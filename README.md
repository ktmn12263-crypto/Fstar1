
<img src="https://github.com/user-attachments/assets/986892f9-c32f-448d-a24e-ba8659203fbf" height="200">

# Ksign 
[![GitHub Release](https://img.shields.io/github/v/release/nyasami/ksign?style=for-the-badge&color=3c94fc)](https://github.com/nyasami/ksign/releases/latest) 
[![GitHub Downloads (all assets, all releases)](https://img.shields.io/github/downloads/nyasami/ksign/total?style=for-the-badge&color=6bc563)](https://github.com/nyasami/ksign/releases)

Yet another codesigning app, have you ever wondered what if Feather and Esign had a child?

## Why?
Since Esign is end of service so people been moving to other signing apps, but Esign was a really big part of the community, so with the help of Feather as the base app, I tried to recreate Esign as close as possible so you guys can easier to get familiar and less app switching for smooth sideloading.

Another reason is this app was built specifically for Khoindvn to share his certificates, allowing more people to access to sideloading without even have to buy a certificate!

## Help
You can create your Issue at [Issue](https://github.com/Nyasami/Ksign-public/issues), this will also be the place for you to request a new feature so feel free to make one!

You can also join Ksign Discord [here](https://discord.gg/sfbZfQzVdQ) for better communication.

## Download
Go to [Releases](https://github.com/Nyasami/Ksign-public/releases) and download the newest ipa from there.

## Fplus local store (development)

The Fplus work adds a separate local REST API and browser-based admin dashboard. KSign remains the signing client: the server stores and serves catalog IPAs, while IPA signing continues on the iOS device using KSign's existing signing engine.

### Start on Windows

Requirements: Node.js 24 or later. The service uses Node's built-in SQLite support; its ZIP and plist validators are locked in `backend/package-lock.json`.

From PowerShell:

```powershell
.\backend\start-local.ps1
```

On first run this installs the locked server dependencies, creates `backend/.env`, generates local secrets and a random administrator password, and prints the password once. Save it securely. The service binds to `127.0.0.1` by default; open `http://localhost:4317` on the PC to sign in.

The API creates its SQLite schema on startup in `backend/data/fplus.sqlite`. Uploaded apps and icons are written under `backend/storage/`. Both locations are ignored by Git.

### iPhone / local network

Do not expose the development HTTP listener to Wi-Fi: it is deliberately loopback-only. To serve another device, configure a trusted TLS certificate and private key using `TLS_CERT_PATH` and `TLS_KEY_PATH` in `backend/.env`, then set `SERVER_HOST` to the PC's LAN address (or `0.0.0.0`) and restart. The certificate must be trusted by both the iPhone and the browser, and its subject alternative name must match the address used. Configure that HTTPS origin in Fplus > Settings. Do not disable TLS verification or forward the service to the public Internet.

For API development and tests, run:

```powershell
node --test .\backend\tests\api.test.mjs
```

### Current API and features

- Public catalog: `GET /api/store/apps`, `GET /api/store/apps/:id`, and verified IPA downloads under `/api/store/apps/:id/versions/:versionId/download`.
- Admin dashboard: accessible via browser on desktop and mobile (`/`). Allows managing apps, versions, IPA & icon uploads, customer accounts, device approval/revocation, signing certificates, updates, and audit logs.
- Certificates management: Admin can upload `.p12` certificates and `.mobileprovision` profiles. They are encrypted at rest with AES-256-GCM under `storage/signing/`.
- Device binding & Entitlements: Customer devices are registered with identifier/UDID and approved by administrator. Admin assigns active certificates to device entitlements.
- Secure Signing Package delivery: `POST /api/signing-package/request` validates user session, device approval, and entitlement, then delivers the decrypted certificate bundle over HTTPS directly to the iOS app.
- Local Signing Engine: KSign imports the signing package into local storage and signs IPAs on the device using Zsign. The server NEVER signs IPAs.
- `GET /api/app/update`: Provides KSign/Fplus update metadata and SHA-256 verified package download.
- Local LAN & iPhone setup: run `.\backend\enable-lan.ps1` to automatically detect your local IP, generate TLS certs, and prepare iPhone installation.

### Transitioning from Local PC to Cloud / VPS

1. **Environment Variables**: The application relies strictly on environment variables (`.env`). No Windows-specific hardcoded paths are used.
2. **Database**: Uses SQLite (`fplus.sqlite`) with schema migrations. For multi-instance cloud deployments, the queries can be mirrored or migrated to PostgreSQL.
3. **Storage Abstraction**: The `LocalStorage` class abstracts disk operations and can be swapped for AWS S3 or Cloudflare R2 without changing REST routes.
4. **Deploying on Linux VPS**:
   - Install Node.js 24+ and PM2 (`npm install -g pm2`).
   - Copy `backend/` and `admin/` to your server (e.g. `/var/www/fplus`).
   - Set up `.env` with domain (e.g. `api.fplus.com`) and HTTPS reverse proxy (Nginx or Caddy with Let's Encrypt).
   - Start using `pm2 start src/server.mjs --name fplus-backend`.
   - Update `API_BASE_URL` in the iOS app settings to `https://api.fplus.com`.

## Star History

<a href="https://www.star-history.com/#Nyasami/Ksign-public&Timeline">
 <picture>
   <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/svg?repos=Nyasami/Ksign-public&type=Timeline&theme=dark" />
   <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/svg?repos=Nyasami/Ksign-public&type=Timeline" />
   <img alt="Star History Chart" src="https://api.star-history.com/svg?repos=Nyasami/Ksign-public&type=Timeline" />
 </picture>
</a>

## Special thanks
- Feather by [claration](https://github.com/claration/Feather)  

- Product manager Khoindvn

- And you! for using the app ❤️

## Disclaimer

This project is maintained here, on GitHub. Releases are distributed here, on GitHub. We do not currently have a project website outside of this repository. Please make sure to avoid any sites that host our software as they are often malicious and are there to mislead to user.
