@echo off
rem Panecast gateway for cmux DR2: the bundled Node runs the bundled gateway.
setlocal
set "PANECAST_CMUX_TUI=%~dp0cmux-tui.exe"
"%~dp0..\node\node.exe" "%~dp0..\panecast\bin\panecast.mjs" %*
exit /b %ERRORLEVEL%
