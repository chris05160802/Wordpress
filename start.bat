@echo off
chcp 65001 >nul
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo 没有找到 Node.js。请先到 https://nodejs.org/zh-cn 下载安装 18 或更高版本（LTS），然后重新运行本文件。
  pause
  exit /b 1
)
node server.js --open
pause
