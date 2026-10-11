@echo off
chcp 65001 >nul
cd /d "%~dp0"

set PORT=8321

echo ==========================================
echo   LumenPnP 本地调试工具 一键启动 (零依赖)
echo ==========================================
echo 无需安装 Python 或任何软件,Windows 自带即可。
echo.

rem ---- 1. 自动结束占用端口的旧进程 ----
echo [1/2] 清理端口 %PORT%...
for /f "tokens=5" %%a in ('netstat -ano ^| findstr ":%PORT% " ^| findstr "LISTENING"') do taskkill /f /pid %%a >nul 2>&1
timeout /t 1 /nobreak >nul

rem ---- 2. 后台启动零依赖服务器(Windows 自带 PowerShell) ----
echo [2/2] 启动服务器...
start "LumenPnP Server" /min powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0server.ps1" -Port %PORT%

rem ---- 等服务器就绪后再打开浏览器 ----
timeout /t 2 /nobreak >nul
start "" "http://localhost:%PORT%"

echo.
echo 已打开: http://localhost:%PORT%
echo 关闭最小化窗口「LumenPnP Server」即停止服务。
timeout /t 5 >nul
