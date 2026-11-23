@echo off
setlocal
cd /d "%~dp0"

where node >nul 2>&1
if errorlevel 1 (
  echo [Unified Marketplace Search] Node.js 24+ is required but was not found on PATH.
  exit /b 1
)

if not exist "node_modules" (
  echo [Unified Marketplace Search] Dependencies not installed. Run "npm ci" first.
  exit /b 1
)

if not exist "dist\server\index.js" goto :build_dist
if not exist "dist\server\launcher.js" goto :build_dist
if not exist "dist\client\index.html" goto :build_dist
goto :launch

:build_dist
echo [Unified Marketplace Search] Building production bundle into dist\...
call npm run build
if errorlevel 1 (
  echo [Unified Marketplace Search] Build failed.
  exit /b %ERRORLEVEL%
)

:launch
node "dist\server\launcher.js"
exit /b %ERRORLEVEL%
