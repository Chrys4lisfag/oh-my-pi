@echo off
setlocal DisableDelayedExpansion
REM Build and replace OMP without interactive prompts.
REM Optional: -InstallDir "D:\Tools\omp"
"%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "%~dp0scripts\replace-global.ps1" %*
set "OMP_BUILD_EXIT=%ERRORLEVEL%"
endlocal & exit /b %OMP_BUILD_EXIT%
