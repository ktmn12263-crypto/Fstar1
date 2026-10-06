$ErrorActionPreference = "Stop"

$envFile = Join-Path $PSScriptRoot ".env"
if (-not (Test-Path -LiteralPath $envFile)) {
    $jwtSecret = node -p "require('node:crypto').randomBytes(48).toString('base64url')"
    $encryptionKey = node -p "require('node:crypto').randomBytes(32).toString('hex')"
    $adminPassword = node -p "require('node:crypto').randomBytes(24).toString('base64url')"
    if ($LASTEXITCODE -ne 0 -or -not $jwtSecret -or -not $encryptionKey -or -not $adminPassword) {
        throw "Unable to generate local secrets. Install Node.js 24 or later and retry."
    }

    $lines = @(
        "SERVER_HOST=127.0.0.1",
        "SERVER_PORT=4317",
        "DATABASE_PATH=./data/fplus.sqlite",
        "STORAGE_PATH=./storage",
        "SIGNING_STORAGE_PATH=./storage/signing",
        "JWT_SECRET=$jwtSecret",
        "ENCRYPTION_KEY=$encryptionKey",
        "ADMIN_USERNAME=admin",
        "ADMIN_PASSWORD=$adminPassword",
        "SESSION_TTL_HOURS=12",
        "MAX_IPA_SIZE_BYTES=2147483648",
        "TLS_CERT_PATH=",
        "TLS_KEY_PATH="
    )
    [System.IO.File]::WriteAllLines($envFile, $lines, [System.Text.UTF8Encoding]::new($false))
    Write-Host ""
    Write-Host "Generated a local .env file. Keep it private and out of source control."
    Write-Host "Initial administrator username: admin"
    Write-Host "Initial administrator password (save it now): $adminPassword"
    Write-Host ""
}

if (-not (Test-Path -LiteralPath (Join-Path $PSScriptRoot "node_modules"))) {
    Write-Host "Installing the locked Fplus server dependencies..."
    Push-Location $PSScriptRoot
    try {
        npm.cmd ci --no-audit --no-fund
        if ($LASTEXITCODE -ne 0) { throw "npm ci failed with exit code $LASTEXITCODE." }
    }
    finally {
        Pop-Location
    }
}

$isTls = (Test-Path $envFile) -and ((Get-Content $envFile -Raw) -match "TLS_CERT_PATH=\S+")
$proto = if ($isTls) { "https" } else { "http" }
Write-Host "Starting Fplus API and Admin at $proto://localhost:4317"
if (-not $isTls) {
    Write-Host "The server binds to this PC only. Run .\enable-lan.ps1 to configure LAN HTTPS for iPhone access." -ForegroundColor Yellow
}
Write-Host "Press Ctrl+C to stop the server."
Push-Location $PSScriptRoot
try {
    node .\src\server.mjs
    if ($LASTEXITCODE -ne 0) { throw "Fplus server exited with code $LASTEXITCODE." }
}
finally {
    Pop-Location
}
