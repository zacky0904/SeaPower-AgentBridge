// SP Advisor 橋接探針（手寫 SystemJS 模組，對應 @sp-advisor/bridge）
// 目的：驗證(1)第三方模組能否被遊戲執行 (2)能否用 spruntime RPC 讀到真實戰況
//       (3)讀到的資料是「玩家已知」還是上帝視角。
// 所有輸出都以 [SP-ADVISOR] 前綴印到 console → 會進 Player.log，方便事後檢查。
// 匿名 System.register（比照 spai），SystemJS 會用 import 指定名綁定。
System.register(["spruntime"], function (_export, _context) {
  "use strict";
  var runtime;
  var TAG = "[SP-ADVISOR]";

  function req(method, params) {
    return runtime.serverAndClient.request(method, params || {});
  }

  async function probe(round) {
    try {
      var tfs = await req("GetTaskforces", {});
      console.log(TAG, "round", round, "Taskforces =", JSON.stringify(tfs));

      for (var i = 0; i < tfs.length; i++) {
        var tf = tfs[i];
        var units = [];
        try { units = await req("GetUnitsInTaskforce", { taskforce: tf }); }
        catch (e) { console.log(TAG, "  GetUnitsInTaskforce(" + tf + ") err:", String(e)); continue; }
        console.log(TAG, "  TF '" + tf + "' units =", JSON.stringify(units));

        for (var j = 0; j < units.length && j < 40; j++) {
          try {
            var info = await req("GetObjectInfo", { unitid: units[j] });
            var pos = await req("GetUnitPosition", { unitid: units[j] });
            console.log(TAG, "    #" + units[j],
              (info && info.name) || "?",
              "@", pos && pos.latitude, pos && pos.longitude);
          } catch (e) {
            console.log(TAG, "    #" + units[j], "info/pos err:", String(e));
          }
        }
      }

      // 用第一個編隊第一個單位的位置，畫一個大圓查各編隊的「已知接觸」
      if (tfs.length) {
        var u0 = await req("GetUnitsInTaskforce", { taskforce: tfs[0] });
        if (u0 && u0.length) {
          var p = await req("GetUnitPosition", { unitid: u0[0] });
          var region = { type: "circle",
            center: { latitude: p.latitude, longitude: p.longitude }, radius: 100000 };
          for (var k = 0; k < tfs.length; k++) {
            try {
              var vs = await req("VehiclesInArea", { taskforce: tfs[k], region: region });
              console.log(TAG, "  VehiclesInArea(plot of '" + tfs[k] + "') =", JSON.stringify(vs));
            } catch (e) {
              console.log(TAG, "  VehiclesInArea(" + tfs[k] + ") err:", String(e));
            }
          }
        }
      }
      console.log(TAG, "round", round, "done");
    } catch (e) {
      console.log(TAG, "PROBE ERROR:", String(e), e && e.stack);
    }
  }

  return {
    setters: [function (m) { runtime = m.runtime; }],
    execute: function () {
      console.log(TAG, "bridge module loaded (execute)");
      runtime.onEvent("start", async function () {
        console.log(TAG, "start event fired — client registered, begin probing");
        var round = 0;
        await probe(round);
        while (true) {
          try { await req("WaitGameTime", { delay: 10 }); }
          catch (e) { console.log(TAG, "WaitGameTime err:", String(e)); break; }
          await probe(++round);
        }
      });
    }
  };
});
