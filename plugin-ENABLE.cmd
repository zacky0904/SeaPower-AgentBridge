@echo off
echo Enabling SP Advisor plugin...
move /Y "SpAdvisorBridge.dll.disabled" "..\BepInEx\plugins\SpAdvisorBridge.dll" >nul 2>nul
if exist "..\BepInEx\plugins\SpAdvisorBridge.dll" (echo Plugin ENABLED.) else (echo Could not find disabled DLL to restore.)
pause
