@echo off
rem Opens cmux DR2: attaches to the main session the gateway keeps running,
rem or starts an interactive session when no owner is running.
"%~dp0cmux-tui.exe" server status --session main >/dev/null 2>&1
if %ERRORLEVEL%==0 (
  "%~dp0cmux-tui.exe" attach --session main
) else (
  "%~dp0cmux-tui.exe" --session main
)
