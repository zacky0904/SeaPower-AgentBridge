@echo off
echo Disabling SP Advisor plugin (moving DLL out of BepInEx\plugins)...
move /Y "..\BepInEx\plugins\SpAdvisorBridge.dll" "SpAdvisorBridge.dll.disabled" >nul 2>nul
if exist "SpAdvisorBridge.dll.disabled" (echo Plugin DISABLED. BepInEx still loads, but our mod will not run.) else (echo Nothing to disable ^(already off?^).)
pause
