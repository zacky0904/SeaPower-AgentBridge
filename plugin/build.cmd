@echo off
cd /d "%~dp0"
echo Building SP Advisor Bridge plugin...
dotnet build -c Release -v minimal
if errorlevel 1 goto FAIL
copy /Y "bin\Release\SpAdvisorBridge.dll" "..\..\BepInEx\plugins\SpAdvisorBridge.dll"
echo.
echo Done. Plugin installed to BepInEx\plugins\. Restart the game to reload.
pause
exit /b 0
:FAIL
echo.
echo Build FAILED. See errors above.
pause
exit /b 1
