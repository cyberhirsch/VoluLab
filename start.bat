@echo off
setlocal
title VoluLab
cd /d "%~dp0"

echo.
echo  VoluLab - starting up
echo  ---------------------
echo.

where node >nul 2>&1
if errorlevel 1 (
    echo  [ERROR] Node.js was not found on PATH.
    echo          Install Node.js 20.19 or later from https://nodejs.org/
    echo.
    pause
    exit /b 1
)

for /f "delims=" %%v in ('node -v') do set NODE_VERSION=%%v
echo  Node.js %NODE_VERSION%

if not exist "node_modules\" (
    echo.
    echo  First run - installing dependencies. This takes a few minutes.
    echo.
    call npm install
    if errorlevel 1 (
        echo.
        echo  [ERROR] npm install failed. See the output above.
        echo.
        pause
        exit /b 1
    )
)

echo  Dev server: http://localhost:3000
echo  The browser opens automatically once the first build finishes.
echo  Press Ctrl+C in this window to stop.
echo.

REM Poll the dev server in the background and open the browser when it responds.
REM The initial rollup build can take a while, so allow up to three minutes.
start "" /b powershell -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -Command ^
 "$url = 'http://localhost:3000';" ^
 "for ($i = 0; $i -lt 180; $i++) {" ^
 "  try {" ^
 "    $r = Invoke-WebRequest -Uri $url -UseBasicParsing -TimeoutSec 2;" ^
 "    if ($r.StatusCode -eq 200) { Start-Process $url; break }" ^
 "  } catch { }" ^
 "  Start-Sleep -Seconds 1" ^
 "}"

call npm run develop

echo.
echo  VoluLab dev server stopped.
pause
