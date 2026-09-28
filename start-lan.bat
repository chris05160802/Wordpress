@echo off
chcp 65001 >nul
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo 没有找到 Node.js。请先到 https://nodejs.org/zh-cn 下载安装 18 或更高版本（LTS），然后重新运行本文件。
  pause
  exit /b 1
)
echo 这个启动方式允许同一个 Wi-Fi 里的手机访问本程序。
echo 如果 Windows 防火墙询问是否允许 Node.js 访问网络，请勾选"专用网络"并点"允许访问"。
echo.
set HOST=0.0.0.0
node server.js --open
pause
