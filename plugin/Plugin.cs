// SP Advisor Bridge — BepInEx plugin（跑在遊戲行程內，讀玩家戰術畫面推給 Web server）
// 資料源：玩家編隊 (Taskforce.Side==Player) 的 PlottingTable.Vehicles —— 即玩家「已知」的接觸畫面，
// 位置用 PositionEstimate（估計值），與遊戲海圖同源，不是上帝視角。
using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Globalization;
using System.Net.Http;
using System.Text;
using System.Text.Json;
using BepInEx;
using UnityEngine;
using SeaPower;

namespace SpAdvisor
{
    [BepInPlugin("com.spadvisor.bridge", "SP Advisor Bridge", "0.1.0")]
    public class SpAdvisorPlugin : BaseUnityPlugin
    {
        private static readonly HttpClient http = new HttpClient { Timeout = TimeSpan.FromSeconds(2) };
        private const string IngestUrl = "http://localhost:8765/api/ingest";
        private const string CommandsUrl = "http://localhost:8765/api/commands";
        private const float Interval = 1.0f; // 每秒推一次
        private float _timer;
        private bool _posting;
        private bool _polling;
        private int _lastCount = -1;
        private static readonly ConcurrentQueue<PendingCmd> _cmdQueue = new ConcurrentQueue<PendingCmd>();

        private void Awake()
        {
            Logger.LogInfo("SP Advisor Bridge 已載入，將每秒推送戰況到 " + IngestUrl);
        }

        private void Update()
        {
            DrainCommands();   // 主執行緒：執行 Web 下的指令
            _timer += Time.unscaledDeltaTime;
            if (_timer < Interval) return;
            _timer = 0f;
            try
            {
                string json = BuildSnapshot();
                if (json != null) Post(json);
            }
            catch (Exception e)
            {
                Logger.LogWarning("snapshot 失敗: " + e.Message);
            }
            PollCommands();    // 背景：拉取新指令
        }

        // ── Web → 遊戲 下指令 ────────────────────────────────
        private void DrainCommands()
        {
            while (_cmdQueue.TryDequeue(out var cmd))
            {
                try { ExecuteCommand(cmd); }
                catch (Exception e) { Logger.LogWarning("指令執行失敗: " + e.Message); }
            }
        }

        private void PollCommands()
        {
            if (_polling) return;
            _polling = true;
            try
            {
                http.GetStringAsync(CommandsUrl).ContinueWith(t =>
                {
                    _polling = false;
                    if (t.IsFaulted || t.Result == null) return;
                    try { ParseCommands(t.Result); } catch { }
                });
            }
            catch { _polling = false; }
        }

        // 背景執行緒：只解析 JSON，不碰 Unity 物件
        private static void ParseCommands(string body)
        {
            using (var doc = JsonDocument.Parse(body))
            {
                if (!doc.RootElement.TryGetProperty("commands", out var arr)) return;
                foreach (var el in arr.EnumerateArray())
                {
                    if (!el.TryGetProperty("type", out var tp)) continue;
                    var cmd = new PendingCmd { type = tp.GetString() };
                    if (el.TryGetProperty("unit", out var u)) cmd.unit = u.GetInt32();
                    if (el.TryGetProperty("target", out var t)) cmd.target = t.GetInt32();
                    if (el.TryGetProperty("salvo", out var s)) cmd.salvo = s.GetInt32();
                    if (el.TryGetProperty("on", out var o)) cmd.on = o.GetBoolean();
                    if (el.TryGetProperty("value", out var v)) cmd.value = v.GetString();
                    if (el.TryGetProperty("num", out var n)) cmd.num = n.GetDouble();
                    if (el.TryGetProperty("replace", out var r)) cmd.replace = r.GetBoolean();
                    if (el.TryGetProperty("points", out var pts))
                    {
                        cmd.points = new List<double[]>();
                        foreach (var p in pts.EnumerateArray())
                            cmd.points.Add(new[] { p.GetProperty("lat").GetDouble(), p.GetProperty("lon").GetDouble() });
                    }
                    _cmdQueue.Enqueue(cmd);
                }
            }
        }

        // 主執行緒：實際下指令給遊戲（每個都驗證單位存在且為玩家可控）
        private void ExecuteCommand(PendingCmd cmd)
        {
            var ob = CoreService.FindByUID(cmd.unit);
            if (ob == null || !ob.IsPlayerObject) { Logger.LogWarning($"指令 {cmd.type}: 找不到可控單位 {cmd.unit}"); return; }
            switch (cmd.type)
            {
                case "waypoint":
                    if (cmd.replace) { int n = ob.GetNumberOfWaypoints(); if (n > 0) ob.DeleteWaypoints(n); }
                    int added = 0;
                    if (cmd.points != null)
                        foreach (var p in cmd.points)
                        { ob.SetWaypointTask(new WaypointData { _geoposition = new GeoPosition { _latitude = p[0], _longitude = p[1] } }); added++; }
                    Logger.LogInfo($"單位 {cmd.unit} 設定 {added} 航點");
                    break;
                case "attack":
                    {
                        var target = CoreService.FindByUID(cmd.target);
                        if (target == null) { Logger.LogWarning("attack: 找不到目標 " + cmd.target); return; }
                        string ammo = ob.GetDefaultAmmunitionForEngage(target);
                        if (string.IsNullOrEmpty(ammo) || ob.getAmmunitionAmountByName(ammo) <= 0)
                        { Logger.LogInfo($"單位 {cmd.unit} 對 {cmd.target} 無可用武器"); return; }
                        int salvo = cmd.salvo > 0 ? cmd.salvo : 1;
                        var task = new EngageTask(ammo, target, ob, salvo) { _ignoreIfUndetected = true };
                        ob.AddEngageTask(task);
                        Logger.LogInfo($"單位 {cmd.unit} 攻擊 {cmd.target}（{ammo} ×{salvo}）");
                    }
                    break;
                case "clearwp": ob.RemoveWaypoints(); Logger.LogInfo($"單位 {cmd.unit} 清除航點"); break;
                case "resume": ob._playerCommandOverride = false; ob.CheckForPlayerAbort(); Logger.LogInfo($"單位 {cmd.unit} 恢復航向"); break;
                case "emcon": ob.setEMCON(cmd.on); Logger.LogInfo($"單位 {cmd.unit} EMCON {(cmd.on ? "靜默" : "輻射")}"); break;
                case "speed": ob.SetSpeedCommand(new ConstantSpeed((float)cmd.num, ob)); Logger.LogInfo($"單位 {cmd.unit} 航速 {cmd.num}kn"); break;
                case "altitude": ob.DesiredAltitude.Value = (float)(cmd.num * 0.00453571); Logger.LogInfo($"單位 {cmd.unit} 高度 {cmd.num}ft"); break;
                case "weaponstatus":
                    if (Enum.TryParse<ObjectBase.WeaponStatus>(cmd.value, out var ws)) { ob.SetWeaponStatus(ws); Logger.LogInfo($"單位 {cmd.unit} 武器 {cmd.value}"); }
                    break;
                case "sensor":
                    bool en = cmd.on;
                    if (cmd.value == "air") { if (en) ob.EnableAirSearchRadars(); else ob.DisableAirSearchRadars(); }
                    else if (cmd.value == "surf") { if (en) ob.EnableSurfaceSearchRadars(); else ob.DisableSurfaceSearchRadars(); }
                    else if (cmd.value == "sonar") { if (en) ob.EnableActiveSonars(); else ob.DisableActiveSonars(); }
                    Logger.LogInfo($"單位 {cmd.unit} 感測 {cmd.value} {(en ? "開" : "關")}");
                    break;
            }
        }

        // 在主執行緒建構 JSON（存取 Unity 物件必須在主執行緒）
        private string BuildSnapshot()
        {
            // 關鍵：Singleton<T>.Instance 在找不到實例時會「憑空 new 一個」。
            // 任務切換空檔若被我們觸發，會造出空的幽靈 TaskforceManager、害新任務讀不到資料。
            // 只在實例「已存在」時才讀（InstanceExists 不會創建），讓遊戲自己在正確時機建立實例。
            if (!Singleton<TaskforceManager>.InstanceExists()) return null;
            var tfm = Singleton<TaskforceManager>.Instance;
            if (tfm == null || tfm._taskForces == null) return null;

            Taskforce player = null;
            foreach (var tf in tfm._taskForces)
                if (tf != null && tf.Side == Taskforce.TfType.Player) { player = tf; break; }
            if (player == null || player.PlottingTable == null) return null;

            var contacts = new StringBuilder(4096);
            int count = 0;
            double sumLat = 0, sumLon = 0; int own = 0;

            foreach (var v in player.PlottingTable.Vehicles)
            {
                if (v == null || v.BaseObject == null) continue;

                var mapType = v.GetMapType();
                if (mapType == SeapowerUI.MapVisualType.Invisible) continue;

                double lat, lon;
                var pe = v.PositionEstimate;
                if (pe.HasValue) { lat = pe.Value.Item1.Latitude; lon = pe.Value.Item1.Longitude; }
                else if (v.Position != null) { var p = v.Position.Value; lat = p.Latitude; lon = p.Longitude; }
                else continue;

                string relation = MapRelation(v.CurrentRelationship());
                string domain = MapDomain(mapType);
                var ob = v.BaseObject;
                bool isOwn = ob.IsPlayerObject;
                bool destroyed = ob.IsDestroyed;

                // 接觸編號 + 依識別狀態決定顯示名（未識別 → 用玩家的分類 Vehicle.Class，不洩真名）
                int num = v.Id;
                bool identified = isOwn || (v.Identified != null && v.Identified.Value);
                bool classified = v.IsClassified;
                bool dormant = v.IsDormant != null && v.IsDormant.Value;
                string dispName = "", typeAbbr = "", classStr = "";
                if (identified) { dispName = ob.DisplayNameFull ?? ""; typeAbbr = ob.TypeAbbreviation ?? ""; classStr = ob.ClassNameShort ?? ""; }
                else { try { if (v.Class.HasValue) { dispName = v.Class.Value.Value ?? ""; classStr = dispName; } } catch {} }

                // Fleet 分組（己方）：編隊名，退回 taskforce 名
                string grp = "";
                if (isOwn) {
                    try { if (ob.Formation != null && !string.IsNullOrEmpty(ob.Formation.Name)) grp = ob.Formation.Name; } catch {}
                    if (string.IsNullOrEmpty(grp)) { try { if (ob._taskforce != null) grp = ob._taskforce._nameInMissionFile; } catch {} }
                }

                // 高度（空中/飛彈）：己方用實際值，其他用估計值
                double alt = double.NaN;
                try {
                    if (isOwn && ob.Altitude != null) alt = ob.Altitude.Value;
                    else if (v.Altitude.HasValue) alt = v.Altitude.Value.Value.Estimate;
                } catch {}

                // 從 Unity 速度向量算航向(度,北為0)與航速(節)
                var vel = v.UnityVelocityVector;
                double h = Math.Sqrt(vel.x * vel.x + vel.z * vel.z);
                double speedKn = h * 1.9438445;
                double course = 0;
                if (h > 0.05) { course = Math.Atan2(vel.x, vel.z) * 180.0 / Math.PI; if (course < 0) course += 360; }

                if (count > 0) contacts.Append(',');
                contacts.Append('{')
                    .Append("\"id\":").Append(ob.UniqueID).Append(',')
                    .Append("\"num\":").Append(num).Append(',')
                    .Append("\"name\":").Append(JStr(dispName)).Append(',')
                    .Append("\"class\":").Append(JStr(classStr)).Append(',')
                    .Append("\"type\":").Append(JStr(typeAbbr)).Append(',')
                    .Append("\"domain\":").Append(JStr(domain)).Append(',')
                    .Append("\"relation\":").Append(JStr(relation)).Append(',')
                    .Append("\"lat\":").Append(Num(lat)).Append(',')
                    .Append("\"lon\":").Append(Num(lon)).Append(',')
                    .Append("\"course\":").Append(Num(course)).Append(',')
                    .Append("\"speed\":").Append(Num(speedKn)).Append(',')
                    .Append("\"identified\":").Append(identified ? "true" : "false").Append(',')
                    .Append("\"classified\":").Append(classified ? "true" : "false").Append(',')
                    .Append("\"dormant\":").Append(dormant ? "true" : "false").Append(',')
                    .Append("\"group\":").Append(JStr(grp)).Append(',')
                    .Append("\"own\":").Append(isOwn ? "true" : "false").Append(',')
                    .Append("\"destroyed\":").Append(destroyed ? "true" : "false");
                if (!double.IsNaN(alt) && (domain == "air" || domain == "missile"))
                    contacts.Append(",\"altitude\":").Append(Num(alt));
                try { contacts.Append(",\"det\":").Append(DetJson(v.DetectingSensors)); } catch {}
                if (isOwn && !destroyed) AppendOwnDetail(contacts, ob);
                contacts.Append('}');
                count++;
                if (isOwn && !destroyed) { sumLat += lat; sumLon += lon; own++; }
            }

            double cLat = own > 0 ? sumLat / own : 0, cLon = own > 0 ? sumLon / own : 0;

            if (count != _lastCount) { Logger.LogInfo("推送接觸數: " + count); _lastCount = count; }

            var sb = new StringBuilder(contacts.Length + 256);
            sb.Append('{')
              .Append("\"name\":\"SP Advisor — 即時戰況\",")
              .Append("\"live\":true,")
              .Append("\"center\":{\"lat\":").Append(Num(cLat)).Append(",\"lon\":").Append(Num(cLon)).Append("},")
              .Append("\"land\":[],")
              .Append("\"contacts\":[").Append(contacts).Append("]")
              .Append('}');
            return sb.ToString();
        }

        private void Post(string json)
        {
            if (_posting) return;
            _posting = true;
            try
            {
                var content = new StringContent(json, Encoding.UTF8, "application/json");
                http.PostAsync(IngestUrl, content).ContinueWith(t =>
                {
                    _posting = false;
                    if (t.IsFaulted) { /* server 沒開就忽略 */ }
                });
            }
            catch { _posting = false; }
        }

        // 己方單位的豐富資料（餵給 AI）：航程、武器狀態、交戰距離、彈藥、艦載機、航線
        private static void AppendOwnDetail(StringBuilder sb, ObjectBase ob)
        {
            sb.Append(",\"detail\":{");
            bool first = true;
            try { sb.Append("\"nation\":").Append(JStr(ob.Nation != null ? ob.Nation.Value : "")); first = false; } catch {}
            try { sb.Append(first?"":",").Append("\"heading\":").Append(Num(ob.Heading != null ? ob.Heading.Value : 0f)); first = false; } catch {}
            try { sb.Append(first?"":",").Append("\"emcon\":").Append((ob.Emcon != null && ob.Emcon.Value) ? "true" : "false"); first = false; } catch {}
            try { sb.Append(first?"":",").Append("\"order\":").Append(JStr(ob.CurrentOrderText != null ? ob.CurrentOrderText.Value : "")); first = false; } catch {}
            try { sb.Append(first?"":",").Append("\"inFormation\":").Append((ob.InFormation != null && ob.InFormation.Value) ? "true" : "false")
                    .Append(",\"formationLeader\":").Append(ob.IsFormationLeader ? "true" : "false"); first = false; } catch {}
            try { sb.Append(first?"":",").Append("\"disabled\":").Append(ob.Disabled ? "true" : "false"); first = false; } catch {}
            try { sb.Append(first?"":",").Append("\"surfRadar\":").Append(ob.HasSurfaceOrAirSurfaceSearchRadar() ? "true" : "false"); first = false; } catch {}
            try {
                float km = ob.RangeInKm != null ? ob.RangeInKm.Value : 0f;
                sb.Append(first?"":",").Append("\"rangeKm\":").Append(Num(km))
                  .Append(",\"unlimitedFuel\":").Append(ob._unlimitedFuel ? "true" : "false");
                first = false;
            } catch {}
            try {
                sb.Append(first ? "" : ",").Append("\"weaponStatus\":").Append(JStr(ob._weaponStatus.ToString()));
                first = false;
            } catch {}
            try {
                var lc = ob._currentLoadoutCapabilities;
                sb.Append(first ? "" : ",").Append("\"engage\":{\"aaw\":").Append(Num(lc.Range_AAW))
                  .Append(",\"asuw\":").Append(Num(lc.Range_ASuW)).Append(",\"asw\":").Append(Num(lc.Range_ASW)).Append('}');
                first = false;
            } catch {}
            // 感測器裝備清單（各類數量）— 明面資訊
            try {
                var p = ob._obp;
                if (p != null) {
                    sb.Append(first ? "" : ",").Append("\"sensors\":{")
                      .Append("\"airRadar\":").Append(p._airSearchRadars != null ? p._airSearchRadars.Count : 0)
                      .Append(",\"surfRadar\":").Append(p._surfaceSearchRadars != null ? p._surfaceSearchRadars.Count : 0)
                      .Append(",\"targRadar\":").Append(p._targetingRadarSystems != null ? p._targetingRadarSystems.Count : 0)
                      .Append(",\"sonar\":").Append(p._sonarSystems != null ? p._sonarSystems.Count : 0)
                      .Append(",\"towed\":").Append(p._towedSystems != null ? p._towedSystems.Count : 0)
                      .Append(",\"visual\":").Append(p._visualSensors != null ? p._visualSensors.Count : 0)
                      .Append('}');
                    first = false;
                }
            } catch {}
            // 彈藥 + 每種武器的發射射程包絡（min/max 哩）— 明面資訊
            try {
                var ammo = ob.AmmunitionAmountDictionary;
                var adict = ob.AmmunitionNameToAmmunitionDictionary;
                if (ammo != null) {
                    sb.Append(first ? "" : ",").Append("\"ammo\":["); first = false;
                    bool a0 = true; int n = 0;
                    foreach (var kv in ammo) {
                        if (kv.Value <= 0) continue; if (n++ >= 40) break;
                        if (!a0) sb.Append(','); a0 = false;
                        sb.Append("{\"n\":").Append(JStr(kv.Key)).Append(",\"c\":").Append(kv.Value);
                        try {
                            Ammunition am;
                            if (adict != null && adict.TryGetValue(kv.Key, out am) && am != null && am._ap != null) {
                                string dn = am._ap._displayedName;
                                if (!string.IsNullOrEmpty(am._ap._displayedNickname))
                                    dn = (string.IsNullOrEmpty(dn) ? "" : dn + " ") + am._ap._displayedNickname;
                                if (!string.IsNullOrEmpty(dn)) sb.Append(",\"dn\":").Append(JStr(dn));
                                float rmax = am._ap._maxLaunchRangeInMiles;
                                if (rmax > 0.01f)
                                    sb.Append(",\"rmin\":").Append(Num(am._ap._minLaunchRangeInMiles))
                                      .Append(",\"rmax\":").Append(Num(rmax));
                                if (!string.IsNullOrEmpty(am._ap._displayedType))
                                    sb.Append(",\"wt\":").Append(JStr(am._ap._displayedType));
                            }
                        } catch {}
                        sb.Append('}');
                    }
                    sb.Append(']');
                }
            } catch {}
            try {
                var fd = ob._obp != null ? ob._obp._flightDeck : null;
                if (fd != null && fd._vehiclesOnBoard != null) {
                    sb.Append(first ? "" : ",").Append("\"aircraft\":["); first = false;
                    bool a0 = true;
                    foreach (var vt in fd._vehiclesOnBoard) {
                        if (vt == null || vt.Numbers <= 0) continue;
                        if (!a0) sb.Append(','); a0 = false;
                        string an = string.IsNullOrEmpty(vt.DisplayName) ? vt._fileName : vt.DisplayName;
                        sb.Append("{\"n\":").Append(JStr(an)).Append(",\"c\":").Append(vt.Numbers).Append('}');
                    }
                    sb.Append(']');
                }
            } catch {}
            try {
                var wps = ob.ExportWaypoints();
                if (wps != null && wps.Count > 0) {
                    sb.Append(first ? "" : ",").Append("\"waypoints\":["); first = false;
                    bool a0 = true;
                    foreach (var w in wps) {
                        if (w == null) continue;
                        var g = w._geoposition;
                        if (!a0) sb.Append(','); a0 = false;
                        bool atk = !string.IsNullOrEmpty(w._ammunitionForEngage);
                        sb.Append("{\"lat\":").Append(Num(g.Latitude)).Append(",\"lon\":").Append(Num(g.Longitude))
                          .Append(",\"name\":").Append(JStr(w.wpName)).Append(",\"atk\":").Append(atk ? "true" : "false").Append('}');
                    }
                    sb.Append(']');
                }
            } catch {}
            sb.Append('}');
        }

        // 接觸被哪些感測器偵測 → 收斂成高階類別 JSON 陣列（目視/雷達/聲納/電磁/磁探）
        private static string DetJson(SensorSystem.SensorTypeSet ds)
        {
            var cats = new System.Collections.Generic.List<string>();
            if ((ds & (SensorSystem.SensorTypeSet.Visual | SensorSystem.SensorTypeSet.TVSeeker)) != 0) cats.Add("visual");
            if ((ds & (SensorSystem.SensorTypeSet.SearchRadar | SensorSystem.SensorTypeSet.FCR
                       | SensorSystem.SensorTypeSet.ARS | SensorSystem.SensorTypeSet.ActiveIntercept)) != 0) cats.Add("radar");
            if ((ds & (SensorSystem.SensorTypeSet.ActiveSonar | SensorSystem.SensorTypeSet.PassiveSonar)) != 0) cats.Add("sonar");
            if ((ds & SensorSystem.SensorTypeSet.ESM) != 0) cats.Add("esm");
            if ((ds & SensorSystem.SensorTypeSet.MAD) != 0) cats.Add("mad");
            var sb = new StringBuilder("[");
            for (int i = 0; i < cats.Count; i++) { if (i > 0) sb.Append(','); sb.Append('"').Append(cats[i]).Append('"'); }
            return sb.Append(']').ToString();
        }

        private static string MapRelation(RelationsState r)
        {
            switch (r)
            {
                case RelationsState.Friendly: return "friendly";
                case RelationsState.Hostile: return "hostile";
                case RelationsState.Neutral: return "neutral";
                default: return "unknown";
            }
        }

        private static string MapDomain(SeapowerUI.MapVisualType t)
        {
            switch (t)
            {
                case SeapowerUI.MapVisualType.Air:
                case SeapowerUI.MapVisualType.Helicopter:
                case SeapowerUI.MapVisualType.AirDecoy:
                    return "air";
                case SeapowerUI.MapVisualType.Submarine:
                case SeapowerUI.MapVisualType.Biologic:
                case SeapowerUI.MapVisualType.SubDecoy:
                case SeapowerUI.MapVisualType.ActiveSonobouy:
                case SeapowerUI.MapVisualType.PassiveSonobouy:
                    return "subsurface";
                case SeapowerUI.MapVisualType.Missile:
                    return "missile";
                case SeapowerUI.MapVisualType.Torpedo:
                    return "torpedo";
                default:
                    return "surface"; // Surface/Installation/SAM/Radar/Airbase/Port/Bridge/AAA...
            }
        }

        private static string Num(double d)
        {
            if (double.IsNaN(d) || double.IsInfinity(d)) d = 0;
            return d.ToString("0.######", CultureInfo.InvariantCulture);
        }

        private static string JStr(string s)
        {
            if (s == null) return "\"\"";
            var sb = new StringBuilder(s.Length + 2);
            sb.Append('"');
            foreach (char c in s)
            {
                switch (c)
                {
                    case '"': sb.Append("\\\""); break;
                    case '\\': sb.Append("\\\\"); break;
                    case '\n': sb.Append("\\n"); break;
                    case '\r': sb.Append("\\r"); break;
                    case '\t': sb.Append("\\t"); break;
                    default:
                        if (c < 0x20) sb.Append("\\u").Append(((int)c).ToString("x4"));
                        else sb.Append(c);
                        break;
                }
            }
            sb.Append('"');
            return sb.ToString();
        }
    }

    internal class PendingCmd
    {
        public string type;
        public int unit;
        public bool replace;
        public List<double[]> points;
        public int target;
        public int salvo;
        public bool on;
        public string value;
        public double num;
    }
}
