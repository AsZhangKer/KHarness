@echo off
title KHarness
cd /d "%~dp0"

echo ============================================
echo   KHarness - 本地 AI Harness (Windows)
echo ============================================

where node >nul 2>nul
if errorlevel 1 (
  echo [错误] 未检测到 Node.js，请先安装 Node.js 20 LTS：https://nodejs.org/
  pause
  exit /b 1
)

for /f "delims=" %%v in ('node -v') do set NODEV=%%v
echo 检测到 Node.js %NODEV%

if not exist "server\node_modules\better-sqlite3" (
  echo.
  echo 首次运行：安装依赖并构建前端（可能需要几分钟）...
  call npm run setup
  if errorlevel 1 (
    echo [错误] 依赖安装失败。若 better-sqlite3 编译报错，请安装 Visual Studio Build Tools 后重试。
    pause
    exit /b 1
  )
) else if not exist "client\dist\index.html" (
  echo.
  echo 构建前端...
  call npm run build
  if errorlevel 1 (
    echo [错误] 前端构建失败
    pause
    exit /b 1
  )
)

set NODE_ENV=production
echo.
echo 启动服务：http://localhost:8317  （局域网访问 http://本机IP:8317）
echo 停止服务：关闭本窗口或按 Ctrl+C
echo.
start "" "http://localhost:8317"
node server\index.js
pause
