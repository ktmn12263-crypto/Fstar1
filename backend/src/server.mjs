import http from "node:http";
import https from "node:https";
import fs from "node:fs";
import path from "node:path";
import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { fileURLToPath } from "node:url";
import { config } from "./config.mjs";
import { audit, createUser, updateUser, updateUserPassword, deleteUser, database, verifyPassword } from "./database.mjs";
import { inspectIpa } from "./ipa-validator.mjs";
import { LocalStorage, EncryptedSigningStorage } from "./storage.mjs";

const storage = new LocalStorage();
const signingStorage = new EncryptedSigningStorage();
const adminRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../admin");
const loginAttempts = new Map();
const rateLimits = new Map();
const allowedCategories = new Set(["apps", "icons", "updates"]);
const cookieName = "fplus_session";
const secretKey = Buffer.from(config.jwtSecret);

await storage.initialize();

const maintenanceTimer = setInterval(() => {
  const time = Date.now();
  for (const [key, value] of loginAttempts) {
    if (value.resetAt <= time) loginAttempts.delete(key);
  }
  for (const [key, value] of rateLimits) {
    if (value.resetAt <= time) rateLimits.delete(key);
  }
  database.prepare("DELETE FROM sessions WHERE expires_at <= ?").run(new Date(time).toISOString());
}, 60_000);
maintenanceTimer.unref();

const now = () => new Date().toISOString();
const appById = database.prepare("SELECT * FROM apps WHERE id = ?");
const versionById = database.prepare("SELECT * FROM app_versions WHERE id = ? AND app_id = ?");
const latestVersion = database.prepare(`
  SELECT * FROM app_versions
  WHERE app_id = ? AND status = 'published' AND (ipa_path IS NOT NULL OR external_url IS NOT NULL)
  ORDER BY published_at DESC, created_at DESC LIMIT 1
`);

function sendJson(res, status, value, headers = {}) {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    ...headers
  });
  res.end(body);
}

function sendError(res, status, message) {
  sendJson(res, status, { error: message });
}

function recordAudit(req, action, subjectId = null) {
  audit(req.user?.id ?? null, action, subjectId);
}

function makeSessionToken() {
  const nonce = randomBytes(32).toString("base64url");
  const signature = createHmac("sha256", secretKey).update(nonce).digest("base64url");
  return `${nonce}.${signature}`;
}

function hashSessionToken(token) {
  return createHash("sha256").update(token).digest("hex");
}

function validSessionToken(token) {
  const [nonce, signature, extra] = token.split(".");
  if (!nonce || !signature || extra) return false;
  const expected = createHmac("sha256", secretKey).update(nonce).digest();
  let supplied;
  try { supplied = Buffer.from(signature, "base64url"); } catch { return false; }
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

function cookieValue(req) {
  const header = req.headers.cookie;
  if (!header) return null;
  for (const part of header.split(";")) {
    const [name, ...value] = part.trim().split("=");
    if (name === cookieName) return decodeURIComponent(value.join("="));
  }
  return null;
}

function authenticate(req) {
  const authorization = req.headers.authorization;
  const bearer = authorization?.startsWith("Bearer ") ? authorization.slice(7) : null;
  const token = bearer || cookieValue(req);
  if (!token || !validSessionToken(token)) return null;

  const row = database.prepare(`
    SELECT users.id, users.username, users.role, users.status, sessions.expires_at
    FROM sessions JOIN users ON users.id = sessions.user_id
    WHERE sessions.token_hash = ?
  `).get(hashSessionToken(token));
  if (!row || row.status !== "active" || Date.parse(row.expires_at) <= Date.now()) return null;
  req.sessionToken = token;
  return row;
}

function requireSameOriginForCookieMutation(req) {
  if (!cookieValue(req) || req.headers.authorization?.startsWith("Bearer ")) return true;
  const origin = req.headers.origin;
  return Boolean(origin && new URL(origin).host === req.headers.host);
}

function clientAddress(req) {
  return req.socket.remoteAddress || "unknown";
}

function rateLimit(req, res, bucket, maximum, windowMs) {
  const key = `${bucket}:${clientAddress(req)}`;
  const current = rateLimits.get(key);
  if (!current || current.resetAt <= Date.now()) {
    rateLimits.set(key, { count: 1, resetAt: Date.now() + windowMs });
    return false;
  }
  current.count++;
  if (current.count <= maximum) return false;
  sendJson(res, 429, { error: "Too many requests. Try again later." }, {
    "Retry-After": String(Math.max(1, Math.ceil((current.resetAt - Date.now()) / 1000)))
  });
  return true;
}

async function readJson(req, maximumBytes = 1_048_576) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > maximumBytes) {
      const error = new Error("Request body is too large");
      error.statusCode = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  if (!total) return {};
  try {
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error();
    return body;
  } catch {
    const error = new Error("Request body must be a JSON object");
    error.statusCode = 400;
    throw error;
  }
}

function text(value, name, maxLength = 1000, required = true) {
  if (typeof value !== "string") {
    if (!required && (value === undefined || value === null)) return "";
    throw Object.assign(new Error(`${name} must be text`), { statusCode: 400 });
  }
  const result = value.trim();
  if ((required && !result) || result.length > maxLength) {
    throw Object.assign(new Error(`${name} is required and must not exceed ${maxLength} characters`), { statusCode: 400 });
  }
  return result;
}

function boolean(value, name) {
  if (typeof value !== "boolean") {
    throw Object.assign(new Error(`${name} must be true or false`), { statusCode: 400 });
  }
  return value;
}

function customer(req, res) {
  if (!req.user) {
    sendError(res, 401, "Authentication required");
    return false;
  }
  if (req.user.role !== "customer" && req.user.role !== "admin") {
    sendError(res, 403, "Customer account required");
    return false;
  }
  return true;
}

function admin(req, res) {
  if (!req.user) {
    sendError(res, 401, "Authentication required");
    return false;
  }
  if (req.user.role !== "admin") {
    sendError(res, 403, "Administrator access required");
    return false;
  }
  return true;
}

function publicApp(row) {
  const latest = latestVersion.get(row.id);
  return {
    id: row.id,
    name: row.name,
    version: latest?.version ?? null,
    build: latest?.build ?? null,
    icon_url: row.icon_path ? `/storage/icons/${path.basename(row.icon_path)}` : null,
    description: row.description,
    category: row.category,
    featured: Boolean(row.featured),
    download_size: latest?.file_size ?? 0,
    published_at: latest?.published_at ?? row.created_at,
    sha256: latest?.sha256 ?? null,
    download_url: latest?.ipa_path ? `/api/store/apps/${row.id}/versions/${latest.id}/download` : (latest?.external_url || null)
  };
}

function currentDeviceEntitlement(req, deviceId) {
  return database.prepare(`
    SELECT devices.id, devices.user_id, devices.status AS device_status,
      devices.certificate_id AS device_cert_id,
      users.certificate_id AS user_cert_id,
      entitlements.status AS entitlement_status, entitlements.expires_at,
      entitlements.certificate_id AS entitlement_cert_id
    FROM devices
    JOIN users ON users.id = devices.user_id
    LEFT JOIN entitlements
      ON entitlements.device_id = devices.id AND entitlements.user_id = devices.user_id
    WHERE devices.id = ? AND devices.user_id = ?
  `).get(deviceId, req.user.id);
}

function isAllowedIpa(buffer) {
  return buffer.length >= 4 && buffer[0] === 0x50 && buffer[1] === 0x4b &&
    [0x03, 0x05, 0x07].includes(buffer[2]) && [0x04, 0x06, 0x08].includes(buffer[3]);
}

async function receiveUpload(req, res, category, extension) {
  if (!allowedCategories.has(category)) {
    sendError(res, 400, "Unsupported upload category");
    return null;
  }

  const expectedLength = Number(req.headers["content-length"] || 0);
  const limit = category === "apps" ? config.maxIpaSizeBytes : 10 * 1024 * 1024;
  if (!Number.isSafeInteger(expectedLength) || expectedLength < 4 || expectedLength > limit) {
    sendError(res, expectedLength > limit ? 413 : 400, "Invalid or oversized upload");
    return null;
  }

  const filename = `${randomUUID()}.${extension}`;
  return storage.saveStream(category, filename, req, {
    maxBytes: limit,
    expectedLength,
    validate: (header, tail) => {
      if (category === "apps" || category === "updates") return isAllowedIpa(header);
      if (extension === "png") return header.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
      if (extension === "jpg") return header[0] === 0xff && header[1] === 0xd8 && tail[0] === 0xff && tail[1] === 0xd9;
      return header.subarray(0, 4).toString() === "RIFF" && header.subarray(8, 12).toString() === "WEBP";
    }
  });
}

function validatePublishedVersion(appId) {
  const version = latestVersion.get(appId);
  if (!version) {
    throw Object.assign(new Error("An IPA must be uploaded and published before publishing this app"), { statusCode: 409 });
  }
}

function streamDownload(res, filePath, headers) {
  res.writeHead(200, headers);
  const stream = fs.createReadStream(filePath);
  stream.on("error", (error) => {
    console.error("storage.read_failure", error.code || "unknown");
    res.destroy(error);
  });
  stream.pipe(res);
}

async function handleApi(req, res, url) {
  const method = req.method || "GET";
  const pathname = url.pathname;
  const parts = pathname.split("/").filter(Boolean);
  const unsafeMethod = !["GET", "HEAD", "OPTIONS"].includes(method);

  if (method === "OPTIONS") {
    res.writeHead(204, { Allow: "GET, HEAD, POST, PUT, DELETE, OPTIONS" }).end();
    return;
  }
  if (unsafeMethod && !requireSameOriginForCookieMutation(req)) {
    sendError(res, 403, "Origin verification failed");
    return;
  }

  if (pathname === "/api/health" && method === "GET") {
    sendJson(res, 200, { status: "ok", service: "fplus-api", time: now() });
    return;
  }

  if (pathname === "/api/auth/login" && method === "POST") {
    if (rateLimit(req, res, "login", 8, 60_000)) return;
    const body = await readJson(req, 16_384);
    const username = text(body.username, "username", 128);
    const password = text(body.password, "password", 1024);
    const attemptKey = `${clientAddress(req)}:${username.toLowerCase()}`;
    const previous = loginAttempts.get(attemptKey);
    if (previous && previous.resetAt > Date.now() && previous.count >= 8) {
      sendError(res, 429, "Too many failed login attempts. Try again later.");
      return;
    }

    const user = database.prepare("SELECT * FROM users WHERE username = ? COLLATE NOCASE").get(username);
    if (!user || user.status !== "active" || !verifyPassword(password, user.password_salt, user.password_hash)) {
      const count = previous && previous.resetAt > Date.now() ? previous.count + 1 : 1;
      loginAttempts.set(attemptKey, { count, resetAt: Date.now() + 15 * 60_000 });
      sendError(res, 401, "Invalid username or password");
      return;
    }

    loginAttempts.delete(attemptKey);
    const token = makeSessionToken();
    const expiresAt = new Date(Date.now() + config.sessionTtlHours * 60 * 60_000).toISOString();
    database.prepare("INSERT INTO sessions (token_hash, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)")
      .run(hashSessionToken(token), user.id, expiresAt, now());
    audit(user.id, "auth.login", user.id);
    const secure = req.socket.encrypted ? "; Secure" : "";
    sendJson(res, 200, {
      token,
      expires_at: expiresAt,
      user: { id: user.id, username: user.username, role: user.role }
    }, {
      "Set-Cookie": `${cookieName}=${encodeURIComponent(token)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${config.sessionTtlHours * 3600}${secure}`
    });
    return;
  }

  req.user = authenticate(req);

  if (pathname === "/api/auth/logout" && method === "POST") {
    if (!req.user) {
      sendJson(res, 200, { ok: true }, { "Set-Cookie": `${cookieName}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0` });
      return;
    }
    database.prepare("DELETE FROM sessions WHERE token_hash = ?").run(hashSessionToken(req.sessionToken));
    recordAudit(req, "auth.logout", req.user.id);
    sendJson(res, 200, { ok: true }, { "Set-Cookie": `${cookieName}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0` });
    return;
  }

  if (pathname === "/api/auth/me" && method === "GET") {
    if (!req.user) return sendError(res, 401, "Authentication required");
    sendJson(res, 200, { user: { id: req.user.id, username: req.user.username, role: req.user.role } });
    return;
  }

  if (pathname === "/api/store/apps" && method === "GET") {
    const apps = database.prepare(`
      SELECT * FROM apps WHERE status = 'published'
      ORDER BY featured DESC, updated_at DESC
    `).all().filter((row) => latestVersion.get(row.id)).map(publicApp);
    sendJson(res, 200, { apps });
    return;
  }

  if (parts[0] === "api" && parts[1] === "store" && parts[2] === "apps" && parts.length === 4 && method === "GET") {
    const app = appById.get(parts[3]);
    if (!app || app.status !== "published" || !latestVersion.get(app.id)) return sendError(res, 404, "App not found");
    const versions = database.prepare(`
      SELECT id, version, build, file_size AS download_size, sha256, release_notes, published_at, ipa_path, external_url
      FROM app_versions WHERE app_id = ? AND status = 'published' AND (ipa_path IS NOT NULL OR external_url IS NOT NULL)
      ORDER BY published_at DESC
    `).all(app.id).map((version) => ({
      ...version,
      ipa_path: undefined,
      external_url: undefined,
      download_url: version.ipa_path
        ? `/api/store/apps/${app.id}/versions/${version.id}/download`
        : (version.external_url || null)
    }));
    sendJson(res, 200, { app: publicApp(app), versions });
    return;
  }

  if (parts[0] === "api" && parts[1] === "store" && parts[2] === "apps" &&
      parts[4] === "versions" && parts[6] === "download" && parts.length === 7 &&
      ["GET", "HEAD"].includes(method)) {
    const app = appById.get(parts[3]);
    const version = versionById.get(parts[5], parts[3]);
    if (!app || app.status !== "published" || !version || version.status !== "published" || !version.ipa_path) {
      return sendError(res, 404, "App version not found");
    }
    if (await storage.sha256(version.ipa_path) !== version.sha256) {
      console.error("storage.integrity_failure", version.id);
      return sendError(res, 500, "Stored app failed integrity verification");
    }
    const headers = {
      "Content-Type": "application/octet-stream",
      "Content-Disposition": `attachment; filename="${encodeURIComponent(app.name)}-${encodeURIComponent(version.version)}.ipa"`,
      "Content-Length": version.file_size,
      "Cache-Control": "public, max-age=300",
      "X-Content-Type-Options": "nosniff",
      "X-Checksum-SHA256": version.sha256
    };
    if (method === "HEAD") res.writeHead(200, headers).end();
    else streamDownload(res, version.ipa_path, headers);
    return;
  }

  if (pathname.startsWith("/storage/icons/") && method === "GET") {
    const filename = parts.at(-1);
    if (!/^[0-9a-f-]{36}\.(png|jpg|jpeg|webp)$/iu.test(filename)) return sendError(res, 404, "Asset not found");
    const file = await storage.read(path.join(config.storagePath, "icons", filename));
    const mime = filename.endsWith(".png") ? "image/png" : filename.endsWith(".webp") ? "image/webp" : "image/jpeg";
    res.writeHead(200, { "Content-Type": mime, "Content-Length": file.length, "Cache-Control": "public, max-age=86400", "X-Content-Type-Options": "nosniff" }).end(file);
    return;
  }

  if (pathname === "/api/app/update" && method === "GET") {
    const update = database.prepare("SELECT * FROM app_updates WHERE id = 1").get();
    if (!update) {
      sendJson(res, 200, {
        latest_version: "0.0.0",
        minimum_version: "0.0.0",
        mandatory: false,
        download_url: null,
        sha256: null,
        release_notes: []
      });
      return;
    }
    let notes;
    try { notes = JSON.parse(update.release_notes); } catch { notes = []; }
    sendJson(res, 200, {
      latest_version: update.latest_version,
      minimum_version: update.minimum_version,
      mandatory: Boolean(update.mandatory),
      download_url: update.download_path ? "/api/app/update/download" : null,
      sha256: update.sha256,
      release_notes: notes
    });
    return;
  }

  if (pathname === "/api/device/status" && method === "GET") {
    if (!customer(req, res)) return;
    const devices = database.prepare("SELECT id, device_identifier, name, status, created_at FROM devices WHERE user_id = ? ORDER BY created_at DESC").all(req.user.id);
    sendJson(res, 200, { devices });
    return;
  }

  if (pathname === "/api/device/register" && method === "POST") {
    if (!customer(req, res)) return;
    const body = await readJson(req, 16_384);
    const deviceIdentifier = text(body.device_identifier, "device_identifier", 128);
    const deviceName = text(body.name, "name", 128, false);
    const udid = text(body.udid, "udid", 128, false) || null;
    const existing = database.prepare("SELECT id, status FROM devices WHERE user_id = ? AND device_identifier = ?").get(req.user.id, deviceIdentifier);
    if (existing) {
      sendJson(res, 200, { device_id: existing.id, status: existing.status });
      return;
    }
    const id = randomUUID();
    database.prepare(`
      INSERT INTO devices (id, user_id, device_identifier, udid, name, status, created_at)
      VALUES (?, ?, ?, ?, ?, 'pending', ?)
    `).run(id, req.user.id, deviceIdentifier, udid, deviceName || null, now());
    recordAudit(req, "device.register", id);
    sendJson(res, 202, { device_id: id, status: "pending", message: "Device registration requires administrator approval" });
    return;
  }

  if (pathname === "/api/entitlement" && method === "GET") {
    if (!customer(req, res)) return;
    const deviceId = url.searchParams.get("device_id");
    if (!deviceId) return sendError(res, 400, "device_id is required");
    const entitlement = currentDeviceEntitlement(req, deviceId);
    if (!entitlement) return sendError(res, 404, "Device not found");
    const active = entitlement.device_status === "active" &&
      entitlement.entitlement_status === "active" &&
      (!entitlement.expires_at || Date.parse(entitlement.expires_at) > Date.now());
    sendJson(res, 200, { allowed: active, status: active ? "active" : "inactive", expires_at: entitlement.expires_at ?? null });
    return;
  }

  if (pathname === "/api/signing-package/request" && method === "POST") {
    if (!customer(req, res)) return;
    const body = await readJson(req, 16_384);
    const deviceId = text(body.device_id, "device_id", 128);
    const entitlement = currentDeviceEntitlement(req, deviceId);
    if (!entitlement) return sendError(res, 403, "Device is not registered to this account");
    const allowed = entitlement.device_status === "active" &&
      entitlement.entitlement_status === "active" &&
      (!entitlement.expires_at || Date.parse(entitlement.expires_at) > Date.now());
    if (!allowed) return sendError(res, 403, "Signing access is not enabled for this device");

    const certId = entitlement.entitlement_cert_id || entitlement.device_cert_id || entitlement.user_cert_id;
    if (!certId) {
      return sendError(res, 404, "No signing certificate assigned to this device or user account");
    }
    const cert = database.prepare("SELECT * FROM signing_certificates WHERE id = ? AND status = 'active'").get(certId);
    if (!cert) {
      return sendError(res, 404, "Assigned signing certificate is no longer active");
    }

    try {
      const p12Buffer = await signingStorage.read(cert.p12_storage_name);
      const provBuffer = await signingStorage.read(cert.provision_storage_name);
      const passBuffer = await signingStorage.read(cert.password_storage_name);
      recordAudit(req, "signing_package.delivered", deviceId);
      sendJson(res, 200, {
        certificate_id: cert.id,
        name: cert.name,
        p12_base64: p12Buffer.toString("base64"),
        provision_base64: provBuffer.toString("base64"),
        password: passBuffer.toString("utf8"),
        expiration: cert.expiration_date
      });
    } catch (err) {
      console.error("signing_package.error", err.message);
      return sendError(res, 500, "Unable to load encrypted signing package");
    }
    return;
  }

  if (pathname === "/api/app/update/download" && method === "GET") {
    const update = database.prepare("SELECT * FROM app_updates WHERE id = 1").get();
    if (!update?.download_path) return sendError(res, 404, "No app update is published");
    if (await storage.sha256(update.download_path) !== update.sha256) return sendError(res, 500, "Update failed integrity verification");
    const stat = await fs.promises.stat(update.download_path);
    streamDownload(res, update.download_path, { "Content-Type": "application/octet-stream", "Content-Length": stat.size, "X-Checksum-SHA256": update.sha256, "X-Content-Type-Options": "nosniff" });
    return;
  }

  if (!pathname.startsWith("/api/admin/")) {
    sendError(res, 404, "Endpoint not found");
    return;
  }
  if (!admin(req, res)) return;

  if (pathname === "/api/admin/apps" && method === "GET") {
    const apps = database.prepare("SELECT * FROM apps WHERE status != 'archived' ORDER BY updated_at DESC").all();
    sendJson(res, 200, { apps: apps.map((row) => ({ ...publicApp(row), status: row.status, description: row.description, category: row.category, versions: database.prepare("SELECT id, version, build, file_size, sha256, release_notes, status, published_at, external_url, ipa_path IS NOT NULL AS has_ipa FROM app_versions WHERE app_id = ? ORDER BY created_at DESC").all(row.id) })) });
    return;
  }

  if (pathname === "/api/admin/apps" && method === "POST") {
    const body = await readJson(req);
    const name = text(body.name, "name", 120);
    const description = text(body.description, "description", 5000, false);
    const category = text(body.category, "category", 80);
    const featured = boolean(body.featured ?? false, "featured");
    const status = body.status === undefined ? "draft" : text(body.status, "status", 20);
    if (!["draft", "published"].includes(status)) return sendError(res, 400, "Invalid app status");
    const id = randomUUID();
    const timestamp = now();
    database.prepare("INSERT INTO apps (id, name, description, category, featured, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'draft', ?, ?)")
      .run(id, name, description, category, featured ? 1 : 0, timestamp, timestamp);
    if (status === "published") {
      try {
        validatePublishedVersion(id);
        database.prepare("UPDATE apps SET status = 'published' WHERE id = ?").run(id);
      } catch (error) {
        database.prepare("DELETE FROM apps WHERE id = ?").run(id);
        throw error;
      }
    }
    recordAudit(req, "app.create", id);
    sendJson(res, 201, { id, name, status });
    return;
  }

  if (parts[0] === "api" && parts[1] === "admin" && parts[2] === "apps" && parts.length === 4) {
    const id = parts[3];
    const app = appById.get(id);
    if (!app || app.status === "archived") return sendError(res, 404, "App not found");

    if (method === "PUT") {
      const body = await readJson(req);
      const name = body.name === undefined ? app.name : text(body.name, "name", 120);
      const description = body.description === undefined ? app.description : text(body.description, "description", 5000, false);
      const category = body.category === undefined ? app.category : text(body.category, "category", 80);
      const featured = body.featured === undefined ? Boolean(app.featured) : boolean(body.featured, "featured");
      const status = body.status === undefined ? app.status : text(body.status, "status", 20);
      if (!["draft", "published"].includes(status)) return sendError(res, 400, "Invalid app status");
      if (status === "published") validatePublishedVersion(id);
      database.prepare("UPDATE apps SET name = ?, description = ?, category = ?, featured = ?, status = ?, updated_at = ? WHERE id = ?")
        .run(name, description, category, featured ? 1 : 0, status, now(), id);
      recordAudit(req, "app.update", id);
      sendJson(res, 200, { id, name, status });
      return;
    }

    if (method === "DELETE") {
      database.prepare("UPDATE apps SET status = 'archived', updated_at = ? WHERE id = ?").run(now(), id);
      recordAudit(req, "app.archive", id);
      sendJson(res, 200, { ok: true });
      return;
    }
  }

  if (parts[0] === "api" && parts[1] === "admin" && parts[2] === "apps" &&
      parts[4] === "versions" && parts.length === 5 && method === "POST") {
    const appId = parts[3];
    const app = appById.get(appId);
    if (!app || app.status === "archived") return sendError(res, 404, "App not found");
    const body = await readJson(req);
    const version = text(body.version, "version", 32);
    const build = text(body.build, "build", 32);
    const releaseNotes = text(body.release_notes, "release_notes", 5000, false);
    const externalUrl = body.external_url ? text(body.external_url, "external_url", 2048, false) : null;
    const status = body.status === undefined ? "draft" : text(body.status, "status", 20);
    if (!["draft", "published"].includes(status)) return sendError(res, 400, "Invalid version status");
    if (status === "published" && !externalUrl) return sendError(res, 409, "Provide a download URL or upload an IPA before publishing");
    const id = randomUUID();
    const timestamp = now();
    const publishedAt = status === "published" ? timestamp : null;
    database.prepare("INSERT INTO app_versions (id, app_id, version, build, release_notes, external_url, status, published_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(id, appId, version, build, releaseNotes, externalUrl, status, publishedAt, timestamp);
    if (status === "published") database.prepare("UPDATE apps SET status = 'published', updated_at = ? WHERE id = ?").run(timestamp, appId);
    recordAudit(req, "version.create", id);
    sendJson(res, 201, { id, app_id: appId, version, build, status, external_url: externalUrl });
    return;
  }

  if (parts[0] === "api" && parts[1] === "admin" && parts[2] === "apps" &&
      parts[4] === "versions" && parts.length === 6) {
    const appId = parts[3];
    const versionId = parts[5];
    const version = versionById.get(versionId, appId);
    if (!version) return sendError(res, 404, "App version not found");
    if (method === "PUT") {
      const body = await readJson(req);
      const versionName = body.version === undefined ? version.version : text(body.version, "version", 32);
      const build = body.build === undefined ? version.build : text(body.build, "build", 32);
      const releaseNotes = body.release_notes === undefined ? version.release_notes : text(body.release_notes, "release_notes", 5000, false);
      const externalUrl = body.external_url === undefined ? version.external_url : (body.external_url ? text(body.external_url, "external_url", 2048, false) : null);
      const status = body.status === undefined ? version.status : text(body.status, "status", 20);
      if (!["draft", "published"].includes(status)) return sendError(res, 400, "Invalid version status");
      if (status === "published" && !version.ipa_path && !externalUrl) return sendError(res, 409, "Provide a download URL or upload an IPA before publishing");
      const publishedAt = status === "published" ? version.published_at || now() : null;
      database.prepare("UPDATE app_versions SET version = ?, build = ?, release_notes = ?, external_url = ?, status = ?, published_at = ? WHERE id = ?")
        .run(versionName, build, releaseNotes, externalUrl, status, publishedAt, versionId);
      if (status === "published") database.prepare("UPDATE apps SET status = 'published', updated_at = ? WHERE id = ?").run(now(), appId);
      recordAudit(req, "version.update", versionId);
      sendJson(res, 200, { id: versionId, version: versionName, build, status, external_url: externalUrl });
      return;
    }
    if (method === "DELETE") {
      database.prepare("DELETE FROM app_versions WHERE id = ?").run(versionId);
      recordAudit(req, "version.delete", versionId);
      sendJson(res, 200, { ok: true });
      return;
    }
  }

  if (parts[0] === "api" && parts[1] === "admin" && parts[2] === "apps" &&
      parts[4] === "versions" && parts[6] === "ipa" && parts.length === 7 && method === "PUT") {
    const appId = parts[3];
    const versionId = parts[5];
    const version = versionById.get(versionId, appId);
    if (!version) return sendError(res, 404, "App version not found");
    if (req.headers["content-type"] !== "application/octet-stream") return sendError(res, 415, "IPA uploads must use application/octet-stream");
    const upload = await receiveUpload(req, res, "apps", "ipa");
    if (!upload) return;
    try {
      const metadata = await inspectIpa(upload.path);
      if (metadata.version !== version.version || metadata.build !== version.build) {
        await storage.remove(upload.path);
        return sendError(res, 400, "IPA version and build must match the version record");
      }
    } catch (error) {
      await storage.remove(upload.path);
      return sendError(res, error.statusCode || 400, error.message);
    }
    if (version.ipa_path) await storage.remove(version.ipa_path);
    database.prepare("UPDATE app_versions SET ipa_path = ?, file_size = ?, sha256 = ?, status = 'draft', published_at = NULL WHERE id = ?")
      .run(upload.path, upload.file_size, upload.sha256, versionId);
    recordAudit(req, "version.ipa_upload", versionId);
    sendJson(res, 200, { version_id: versionId, file_size: upload.file_size, sha256: upload.sha256, status: "draft" });
    return;
  }

  if (parts[0] === "api" && parts[1] === "admin" && parts[2] === "apps" &&
      parts[4] === "icon" && parts.length === 5 && method === "PUT") {
    const appId = parts[3];
    const app = appById.get(appId);
    if (!app || app.status === "archived") return sendError(res, 404, "App not found");
    const contentType = req.headers["content-type"];
    const extension = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp" }[contentType];
    if (!extension) return sendError(res, 415, "Icon must be a PNG, JPEG, or WebP image");
    const upload = await receiveUpload(req, res, "icons", extension);
    if (!upload) return;
    database.prepare("UPDATE apps SET icon_path = ?, updated_at = ? WHERE id = ?").run(upload.path, now(), appId);
    recordAudit(req, "app.icon_upload", appId);
    sendJson(res, 200, { icon_url: `/storage/icons/${upload.filename}` });
    return;
  }

  if (pathname === "/api/admin/users" && method === "GET") {
    const users = database.prepare(`
      SELECT users.id, users.username, users.role, users.status, users.plain_password,
        users.certificate_id, users.created_at,
        signing_certificates.name AS certificate_name
      FROM users
      LEFT JOIN signing_certificates ON signing_certificates.id = users.certificate_id
      ORDER BY users.created_at DESC
    `).all();
    sendJson(res, 200, { users });
    return;
  }

  if (pathname === "/api/admin/users" && method === "POST") {
    const body = await readJson(req, 16_384);
    const username = text(body.username, "username", 64);
    const password = text(body.password, "password", 256);
    const certificateId = body.certificate_id ? text(body.certificate_id, "certificate_id", 128) : null;
    if (password.length < 6) return sendError(res, 400, "User passwords must contain at least 6 characters");
    if (!/^[A-Za-z0-9_.@-]+$/u.test(username)) return sendError(res, 400, "Username contains unsupported characters");
    const user = createUser({ username, password, certificateId });
    recordAudit(req, "user.create", user.id);
    sendJson(res, 201, user);
    return;
  }

  if (parts[0] === "api" && parts[1] === "admin" && parts[2] === "users" && parts.length === 4) {
    const id = parts[3];
    const user = database.prepare("SELECT id, username, role, status FROM users WHERE id = ?").get(id);
    if (!user) return sendError(res, 404, "User not found");

    if (method === "PUT") {
      const body = await readJson(req, 16_384);
      if (body.password !== undefined && body.password !== "") {
        const newPassword = text(body.password, "password", 256);
        if (newPassword.length < 6) return sendError(res, 400, "Password must contain at least 6 characters");
        updateUserPassword(id, newPassword);
        recordAudit(req, "user.password_change", id);
      }
      if (body.status !== undefined || body.certificate_id !== undefined) {
        const status = body.status !== undefined ? text(body.status, "status", 20) : undefined;
        if (status && !["active", "disabled"].includes(status)) return sendError(res, 400, "Invalid user status");
        const certificateId = body.certificate_id !== undefined ? (body.certificate_id ? text(body.certificate_id, "certificate_id", 128) : null) : undefined;
        updateUser(id, { status, certificateId });
        recordAudit(req, "user.update", id);
      }
      sendJson(res, 200, { ok: true });
      return;
    }

    if (method === "DELETE") {
      if (user.role === "admin") return sendError(res, 403, "Cannot delete admin account");
      deleteUser(id);
      recordAudit(req, "user.delete", id);
      sendJson(res, 200, { ok: true });
      return;
    }
  }

  if (pathname === "/api/admin/devices" && method === "GET") {
    const devices = database.prepare(`
      SELECT devices.id, devices.user_id, users.username, devices.device_identifier, devices.udid,
        devices.name, devices.status, devices.certificate_id, devices.created_at,
        entitlements.status AS entitlement_status, entitlements.expires_at AS entitlement_expires_at,
        entitlements.certificate_id AS entitlement_cert_id,
        signing_certificates.name AS certificate_name
      FROM devices
      JOIN users ON users.id = devices.user_id
      LEFT JOIN entitlements ON entitlements.device_id = devices.id AND entitlements.user_id = devices.user_id
      LEFT JOIN signing_certificates ON signing_certificates.id = COALESCE(entitlements.certificate_id, devices.certificate_id)
      ORDER BY devices.created_at DESC
    `).all();
    sendJson(res, 200, { devices });
    return;
  }

  if (parts[0] === "api" && parts[1] === "admin" && parts[2] === "devices" && parts.length === 4 && method === "PUT") {
    const id = parts[3];
    const body = await readJson(req, 16_384);
    const status = text(body.status, "status", 20);
    if (!["active", "pending", "revoked"].includes(status)) return sendError(res, 400, "Invalid device status");
    const device = database.prepare("SELECT id, user_id FROM devices WHERE id = ?").get(id);
    if (!device) return sendError(res, 404, "Device not found");
    const certificateId = body.certificate_id !== undefined ? (body.certificate_id ? text(body.certificate_id, "certificate_id", 128) : null) : undefined;
    if (certificateId !== undefined) {
      database.prepare("UPDATE devices SET status = ?, certificate_id = ? WHERE id = ?").run(status, certificateId, id);
    } else {
      database.prepare("UPDATE devices SET status = ? WHERE id = ?").run(status, id);
    }
    if (status !== "active") database.prepare("UPDATE entitlements SET status = 'revoked' WHERE device_id = ?").run(id);
    recordAudit(req, `device.${status}`, id);
    sendJson(res, 200, { id, status });
    return;
  }

  if (parts[0] === "api" && parts[1] === "admin" && parts[2] === "devices" &&
      parts[4] === "entitlement" && parts.length === 5 && method === "PUT") {
    const deviceId = parts[3];
    const body = await readJson(req, 16_384);
    const status = text(body.status, "status", 20);
    const expiresAt = body.expires_at === null || body.expires_at === "" || body.expires_at === undefined
      ? null : text(body.expires_at, "expires_at", 64);
    const certificateId = body.certificate_id !== undefined ? (body.certificate_id ? text(body.certificate_id, "certificate_id", 128) : null) : undefined;
    if (!["active", "revoked"].includes(status)) return sendError(res, 400, "Invalid entitlement status");
    if (expiresAt && !Number.isFinite(Date.parse(expiresAt))) return sendError(res, 400, "expires_at must be a valid date");
    const device = database.prepare("SELECT id, user_id, status FROM devices WHERE id = ?").get(deviceId);
    if (!device) return sendError(res, 404, "Device not found");
    if (status === "active" && device.status !== "active") return sendError(res, 409, "Approve the device before granting signing entitlement");
    const existing = database.prepare("SELECT id FROM entitlements WHERE device_id = ? AND user_id = ?").get(deviceId, device.user_id);
    if (existing) {
      if (certificateId !== undefined) {
        database.prepare("UPDATE entitlements SET status = ?, expires_at = ?, certificate_id = ? WHERE id = ?").run(status, expiresAt, certificateId, existing.id);
      } else {
        database.prepare("UPDATE entitlements SET status = ?, expires_at = ? WHERE id = ?").run(status, expiresAt, existing.id);
      }
    } else {
      database.prepare("INSERT INTO entitlements (id, user_id, device_id, status, expires_at, certificate_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
        .run(randomUUID(), device.user_id, deviceId, status, expiresAt, certificateId || null, now());
    }
    recordAudit(req, `entitlement.${status}`, deviceId);
    sendJson(res, 200, { device_id: deviceId, status, expires_at: expiresAt });
    return;
  }

  if (pathname === "/api/admin/certificates" && method === "GET") {
    const certs = database.prepare("SELECT id, name, expiration_date, status, created_at FROM signing_certificates ORDER BY created_at DESC").all();
    sendJson(res, 200, { certificates: certs });
    return;
  }

  if (pathname === "/api/admin/certificates" && method === "POST") {
    const body = await readJson(req, 10 * 1024 * 1024);
    const name = text(body.name, "name", 100);
    const password = typeof body.password === "string" ? body.password : "";
    const p12Base64 = text(body.p12_base64, "p12_base64", 10 * 1024 * 1024);
    const provisionBase64 = text(body.provision_base64, "provision_base64", 10 * 1024 * 1024);
    const expiration = body.expiration_date ? text(body.expiration_date, "expiration_date", 64, false) : null;

    const certId = randomUUID();
    const cleanId = certId.replace(/-/g, "");
    const p12Name = `cert_${cleanId}_p12`;
    const provName = `cert_${cleanId}_prov`;
    const passName = `cert_${cleanId}_pass`;

    await signingStorage.save(p12Name, Buffer.from(p12Base64, "base64"));
    await signingStorage.save(provName, Buffer.from(provisionBase64, "base64"));
    await signingStorage.save(passName, Buffer.from(password, "utf8"));

    database.prepare(`
      INSERT INTO signing_certificates (id, name, p12_storage_name, provision_storage_name, password_storage_name, expiration_date, status, created_at)
      VALUES (?, ?, ?, ?, ?, ?, 'active', ?)
    `).run(certId, name, p12Name, provName, passName, expiration, now());

    recordAudit(req, "certificate.create", certId);
    sendJson(res, 201, { id: certId, name, status: "active", expiration_date: expiration });
    return;
  }

  if (parts[0] === "api" && parts[1] === "admin" && parts[2] === "certificates" && parts.length === 4) {
    const id = parts[3];
    const cert = database.prepare("SELECT * FROM signing_certificates WHERE id = ?").get(id);
    if (!cert) return sendError(res, 404, "Certificate not found");

    if (method === "PUT") {
      const body = await readJson(req, 16_384);
      const status = body.status ? text(body.status, "status", 20) : cert.status;
      const name = body.name ? text(body.name, "name", 100) : cert.name;
      if (!["active", "revoked"].includes(status)) return sendError(res, 400, "Invalid status");
      database.prepare("UPDATE signing_certificates SET status = ?, name = ? WHERE id = ?").run(status, name, id);
      recordAudit(req, `certificate.${status}`, id);
      sendJson(res, 200, { id, name, status });
      return;
    }

    if (method === "DELETE") {
      database.prepare("DELETE FROM signing_certificates WHERE id = ?").run(id);
      recordAudit(req, "certificate.delete", id);
      sendJson(res, 200, { ok: true });
      return;
    }
  }

  if (pathname === "/api/admin/store-update" && method === "GET") {
    const update = database.prepare("SELECT latest_version, minimum_version, mandatory, download_path, sha256, release_notes FROM app_updates WHERE id = 1").get();
    let notes = [];
    try { notes = JSON.parse(update?.release_notes || "[]"); } catch { notes = []; }
    sendJson(res, 200, { update: update ? { ...update, mandatory: Boolean(update.mandatory), has_download: Boolean(update.download_path), download_path: undefined, release_notes: notes } : null });
    return;
  }

  if (pathname === "/api/admin/store-update" && method === "PUT") {
    const body = await readJson(req, 64_000);
    const latest = text(body.latest_version, "latest_version", 32);
    const minimum = text(body.minimum_version, "minimum_version", 32);
    const mandatory = boolean(body.mandatory, "mandatory");
    const notes = body.release_notes;
    if (!Array.isArray(notes) || notes.length > 100 || notes.some((note) => typeof note !== "string" || note.length > 500)) {
      return sendError(res, 400, "release_notes must be an array of short text entries");
    }
    const current = database.prepare("SELECT download_path, sha256 FROM app_updates WHERE id = 1").get();
    database.prepare(`
      INSERT INTO app_updates (id, latest_version, minimum_version, mandatory, download_path, sha256, release_notes, updated_at)
      VALUES (1, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET latest_version = excluded.latest_version, minimum_version = excluded.minimum_version,
        mandatory = excluded.mandatory, release_notes = excluded.release_notes, updated_at = excluded.updated_at
    `).run(latest, minimum, mandatory ? 1 : 0, current?.download_path ?? null, current?.sha256 ?? null, JSON.stringify(notes), now());
    recordAudit(req, "store_update.publish");
    sendJson(res, 200, { latest_version: latest, minimum_version: minimum, mandatory });
    return;
  }

  if (pathname === "/api/admin/store-update/ipa" && method === "PUT") {
    if (req.headers["content-type"] !== "application/octet-stream") return sendError(res, 415, "Update uploads must use application/octet-stream");
    const upload = await receiveUpload(req, res, "updates", "ipa");
    if (!upload) return;
    const current = database.prepare("SELECT * FROM app_updates WHERE id = 1").get();
    if (!current) {
      await storage.remove(upload.path);
      return sendError(res, 409, "Save update metadata before uploading its IPA");
    }
    try {
      const metadata = await inspectIpa(upload.path);
      if (metadata.version !== current.latest_version) {
        await storage.remove(upload.path);
        return sendError(res, 400, "Update IPA version must match the published update metadata");
      }
    } catch (error) {
      await storage.remove(upload.path);
      return sendError(res, error.statusCode || 400, error.message);
    }
    if (current.download_path) await storage.remove(current.download_path);
    database.prepare("UPDATE app_updates SET download_path = ?, sha256 = ?, updated_at = ? WHERE id = 1")
      .run(upload.path, upload.sha256, now());
    recordAudit(req, "store_update.ipa_upload");
    sendJson(res, 200, { file_size: upload.file_size, sha256: upload.sha256 });
    return;
  }

  if (pathname === "/api/admin/logs" && method === "GET") {
    const limit = Math.min(500, Math.max(1, Number(url.searchParams.get("limit")) || 100));
    const logs = database.prepare(`
      SELECT audit_logs.id, users.username AS actor, audit_logs.action, audit_logs.subject_id, audit_logs.created_at
      FROM audit_logs LEFT JOIN users ON users.id = audit_logs.actor_user_id
      ORDER BY audit_logs.created_at DESC LIMIT ?
    `).all(limit);
    sendJson(res, 200, { logs });
    return;
  }

  sendError(res, 404, "Endpoint not found");
}

async function serveAdmin(req, res, pathname) {
  let requested = pathname === "/" || pathname === "/admin" || pathname === "/admin/" ? "/index.html" : pathname;
  if (requested.startsWith("/admin/")) requested = requested.replace(/^\/admin/, "");
  const resolved = path.resolve(adminRoot, `.${requested}`);
  if (resolved !== adminRoot && !resolved.startsWith(`${adminRoot}${path.sep}`)) return sendError(res, 404, "Not found");
  let filePath = resolved;
  try {
    const stat = await fs.promises.stat(filePath);
    if (stat.isDirectory()) filePath = path.join(filePath, "index.html");
    const data = await fs.promises.readFile(filePath);
    const type = filePath.endsWith(".css") ? "text/css; charset=utf-8" :
      filePath.endsWith(".js") ? "text/javascript; charset=utf-8" :
      filePath.endsWith(".svg") ? "image/svg+xml" : "text/html; charset=utf-8";
    res.writeHead(200, {
      "Content-Type": type,
      "Cache-Control": "no-cache",
      "Content-Security-Policy": "default-src 'self'; connect-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; base-uri 'none'; frame-ancestors 'none'",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer"
    }).end(data);
  } catch (error) {
    if (error.code === "ENOENT") sendError(res, 404, "Not found");
    else throw error;
  }
}

const requestHandler = async (req, res) => {
  try {
    const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
    if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/storage/")) {
      await handleApi(req, res, url);
    } else if (["GET", "HEAD"].includes(req.method || "GET")) {
      await serveAdmin(req, res, url.pathname);
    } else {
      sendError(res, 404, "Not found");
    }
  } catch (error) {
    if (res.headersSent) {
      res.destroy();
      return;
    }
    const status = Number.isInteger(error.statusCode) ? error.statusCode : 500;
    if (status === 500) console.error("request.error", req.method, new URL(req.url || "/", "http://localhost").pathname, error.message);
    sendError(res, status, status === 500 ? "Something went wrong. Please retry." : error.message);
  }
};

const server = config.tlsCertPath
  ? https.createServer({
    cert: fs.readFileSync(config.tlsCertPath),
    key: fs.readFileSync(config.tlsKeyPath)
  }, requestHandler)
  : http.createServer(requestHandler);

server.requestTimeout = 15 * 60_000;
server.headersTimeout = 30_000;
server.listen(config.port, config.host, () => {
  console.log(`Fplus API listening on ${config.tlsCertPath ? "https" : "http"}://${config.host}:${config.port}`);
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    clearInterval(maintenanceTimer);
    server.close(() => {
      database.close();
      process.exit(0);
    });
  });
}
