@echo off
chcp 65001 >nul
cd /d "%~dp0.."
echo 正在启动 FreeBuddy...
node src\launcher.mjs
if errorlevel 1 (
  echo.
  echo 启动过程有报错，日志在 %APPDATA%\FreeBuddy\logs\daemon.log
  pause
)
