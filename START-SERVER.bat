@echo off
chcp 65001 >nul
title Fplus Local Server
color 0B

echo ========================================================
echo               Fplus Local Server Manager
echo ========================================================
echo.

cd /d "%~dp0backend"

:: Check Node.js
where node >nul 2>&1
if %ERRORLEVEL% neq 0 (
    color 0C
    echo [ERROR] Node.js is not installed or not in PATH!
    echo Please install Node.js from https://nodejs.org/
    pause
    exit /b 1
)

:: Get Local IPv4 Address
for /f "tokens=2 delims=:" %%a in ('ipconfig ^| findstr /i "IPv4" ^| findstr /v "127.0.0.1"') do (
    for /f "tokens=1" %%b in ("%%a") do (
        set "LOCAL_IP=%%b"
        goto :found_ip
    )
)
:found_ip

if "%LOCAL_IP%"=="" set "LOCAL_IP=localhost"

:: Check TLS certs
if not exist "lan-cert.pem" (
    echo [INFO] Generating LAN TLS certificate...
    powershell -ExecutionPolicy Bypass -File .\enable-lan.ps1
)

:: Check dependencies
if not exist "node_modules" (
    echo [INFO] Installing backend dependencies...
    call npm install --no-audit --no-fund
)

echo.
echo ========================================================
echo  🚀 Fplus Server is starting!
echo ========================================================
echo.
echo  [Local PC]:
echo    - Admin Panel:  https://localhost:4317/admin
echo    - Store API:    https://localhost:4317/api/store/apps
echo.
echo  [iPhone / Network]:
echo    - Server URL:   https://%LOCAL_IP%:4317
echo    - Admin Panel:  https://%LOCAL_IP%:4317/admin
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

node src\server.mjs

pause
