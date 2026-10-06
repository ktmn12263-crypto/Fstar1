# Enable LAN HTTPS for iPhone access
$ErrorActionPreference = "Stop"

$ip = (Get-NetIPAddress -AddressFamily IPv4 | Where-Object { 
    $_.InterfaceAlias -notmatch 'Loopback|vEthernet|Virtual' -and 
    $_.IPAddress -notmatch '^169\.254\.' -and 
    $_.IPAddress -notmatch '^127\.' 
} | Select-Object -First 1).IPAddress

if (-not $ip) {
    $ip = "192.168.1.100"
    Write-Warning "Could not automatically determine primary LAN IP. Defaulting to $ip. You can edit lan-cert generation."
} else {
    Write-Host "Detected Local LAN IP: $ip" -ForegroundColor Cyan
}

$certPem = Join-Path $PSScriptRoot "lan-cert.pem"
$keyPem = Join-Path $PSScriptRoot "lan-key.pem"

Write-Host "Generating LAN TLS certificate for IP: $ip and localhost..." -ForegroundColor Yellow

node -e "
const crypto = require('node:crypto');
const fs = require('node:fs');

// Generate 2048-bit RSA key pair
const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' }
});

fs.writeFileSync('$($keyPem.Replace('\', '/'))', privateKey);
console.log('Saved private key to lan-key.pem');
"

# Generate self-signed cert via PowerShell PKI
$cert = New-SelfSignedCertificate -DnsName "localhost", "$ip" -CertStoreLocation "Cert:\CurrentUser\My" -NotAfter (Get-Date).AddYears(2) -KeyExportPolicy Exportable -KeyUsage DigitalSignature,KeyEncipherment -Type Custom -Subject "CN=Fplus Local CA ($ip)"

$certBytes = $cert.Export([System.Security.Cryptography.X509Certificates.X509ContentType]::Cert)
$base64Cert = [System.Convert]::ToBase64String($certBytes, [System.Base64FormattingOptions]::InsertLineBreaks)
$pemContent = "-----BEGIN CERTIFICATE-----`r`n$base64Cert`r`n-----END CERTIFICATE-----`r`n"
[System.IO.File]::WriteAllText($certPem, $pemContent, [System.Text.UTF8Encoding]::new($false))

# Also export as .crt for easy installation on iPhone
$crtPath = Join-Path $PSScriptRoot "fplus-ca.crt"
[System.IO.File]::WriteAllBytes($crtPath, $certBytes)

Write-Host "Certificate generated successfully!" -ForegroundColor Green
Write-Host "Saved: lan-cert.pem and fplus-ca.crt"

# Update .env
$envFile = Join-Path $PSScriptRoot ".env"
if (Test-Path $envFile) {
    $content = Get-Content $envFile -Raw
    $content = $content -replace "SERVER_HOST=.*", "SERVER_HOST=0.0.0.0"
    $content = $content -replace "TLS_CERT_PATH=.*", "TLS_CERT_PATH=./lan-cert.pem"
    $content = $content -replace "TLS_KEY_PATH=.*", "TLS_KEY_PATH=./lan-key.pem"
    Set-Content -Path $envFile -Value $content -NoNewline
    Write-Host "Updated .env with SERVER_HOST=0.0.0.0 and TLS cert paths." -ForegroundColor Green
}

Write-Host ""
Write-Host "============================================================" -ForegroundColor Cyan
Write-Host "INSTRUCTIONS FOR IPHONE CONNECTION:" -ForegroundColor Cyan
Write-Host "============================================================" -ForegroundColor Cyan
Write-Host "1. AirDrop or email 'fplus-ca.crt' to your iPhone (or host it)."
Write-Host "2. On iPhone: Settings > Profile Downloaded > Install."
Write-Host "3. On iPhone: Settings > General > About > Certificate Trust Settings > Turn ON full trust for Fplus Local CA."
Write-Host "4. Start server: .\start-local.ps1"
Write-Host "5. Open Fplus in KSign > Configure Server: https://$($ip):4317"
Write-Host "6. Admin Panel from iPhone browser: https://$($ip):4317"
Write-Host "============================================================" -ForegroundColor Cyan
