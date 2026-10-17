@echo off
setlocal DisableDelayedExpansion
REM Double-click to build and replace OMP. Use -NoPause for automation.
REM Optional: -InstallDir "D:\Tools\omp"
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\replace-global.ps1" %*
set "OMP_BUILD_EXIT=%ERRORLEVEL%"
endlocal & exit /b %OMP_BUILD_EXIT%
