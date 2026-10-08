@echo off
setlocal EnableDelayedExpansion
title Fplus Local Server
color 0B

echo ========================================================
echo               Fplus Local Server Manager
echo ========================================================
echo.

set "SCRIPT_DIR=%~dp0"
if exist "%SCRIPT_DIR%backend\src\server.mjs" (
    cd /d "%SCRIPT_DIR%backend"
) else if exist "%SCRIPT_DIR%Ksign-1.6\backend\src\server.mjs" (
    cd /d "%SCRIPT_DIR%Ksign-1.6\backend"
) else if exist "%SCRIPT_DIR%src\server.mjs" (
    cd /d "%SCRIPT_DIR%"
) else (
    color 0C
    echo [ERROR] Backend folder could not be found!
    echo Please make sure this script is placed in the project directory.
    pause
    exit /b 1
)

set "NODE_CMD=node"
where node >nul 2>&1
if %ERRORLEVEL% neq 0 (
    if exist "C:\Program Files\nodejs\node.exe" (
        set "NODE_CMD=C:\Program Files\nodejs\node.exe"
    ) else if exist "%LOCALAPPDATA%\Programs\nodejs\node.exe" (
        set "NODE_CMD=%LOCALAPPDATA%\Programs\nodejs\node.exe"
    ) else (
        color 0C
        echo [ERROR] Node.js is not found!
        echo Please install Node.js from https://nodejs.org/
        pause
        exit /b 1
    )
)

set "LOCAL_IP="
for /f "tokens=2 delims=:" %%a in ('ipconfig ^| findstr /i "IPv4" ^| findstr /v "127.0.0.1"') do (
    if not defined LOCAL_IP (
        for /f "tokens=1" %%b in ("%%a") do set "LOCAL_IP=%%b"
    )
)
if not defined LOCAL_IP set "LOCAL_IP=localhost"

if not exist "lan-cert.pem" (
    echo [INFO] Generating LAN TLS certificate...
    powershell -ExecutionPolicy Bypass -File .\enable-lan.ps1
)

if not exist "node_modules" (
    echo [INFO] Installing backend dependencies...
    call npm.cmd install --no-audit --no-fund
)

echo.
echo ========================================================
echo   Fplus Server is starting!
echo ========================================================
echo.
echo  [Local PC]:
echo    - Admin Panel:  https://localhost:4317/admin
echo    - Store API:    https://localhost:4317/api/store/apps
echo.
echo  [iPhone / Network]:
echo    - Server URL:   https://!LOCAL_IP!:4317
echo    - Admin Panel:  https://!LOCAL_IP!:4317/admin
echo.
echo  [Credentials]:
echo    - Admin:    admin / AdminPassword123!
echo    - Customer: demo_user / Password1234!
echo.
echo ========================================================
echo  Keep this window OPEN while using the app or admin.
echo  Press Ctrl+C to stop the server.
echo ========================================================
echo.

"%NODE_CMD%" src\server.mjs

pause