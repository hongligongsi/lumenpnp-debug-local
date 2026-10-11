@echo off
chcp 65001 >nul
cd /d "%~dp0"

set PORT=8321

echo 正在启动 LumenPnP 本地调试工具...
echo 地址: http://localhost:%PORT%
echo 使用 Chrome 或 Edge 浏览器(WebSerial 不支持 Firefox)
echo 关闭本窗口即停止服务。
echo.

rem ---- 检查端口是否被占用 ----
powershell -NoProfile -Command "$p=Test-NetConnection -ComputerName localhost -Port %PORT% -InformationLevel Quiet -WarningAction SilentlyContinue; if($p){exit 1}else{exit 0}" >nul 2>&1
if errorlevel 1 (
  echo [错误] 端口 %PORT% 已被占用,无法启动!
  echo.
  echo 原因: 可能有个旧的 python 服务器进程没有关闭。
  echo 解决方法(任选其一):
  echo   1) 打开任务管理器,找到 python.exe 结束它,再重新双击本脚本。
  echo   2) 或先按任意键,我会帮你把启动端口改成 8322 再试。
  echo.
  echo 按任意键尝试改用端口 8322 ...
  pause >nul
  set PORT=8322
  echo 改用端口 %PORT% 重启...
)

start "" "http://localhost:%PORT%"
python -m http.server %PORT%

if errorlevel 1 (
  echo.
  echo [错误] 服务器启动失败。可能原因:
  echo   - 确认已安装 Python(在 cmd 里执行 python --version 验证)
  echo   - 端口被占用
  echo.
  pause
)
