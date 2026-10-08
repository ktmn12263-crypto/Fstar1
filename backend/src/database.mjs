import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { randomBytes, scryptSync, timingSafeEqual, randomUUID } from "node:crypto";
import { config } from "./config.mjs";

fs.mkdirSync(path.dirname(config.databasePath), { recursive: true });

export const database = new DatabaseSync(config.databasePath);
database.exec(`
  PRAGMA foreign_keys = ON;
  PRAGMA journal_mode = WAL;
  PRAGMA busy_timeout = 5000;
  CREATE TABLE IF NOT EXISTS schema_migrations (
    version TEXT PRIMARY KEY,
    applied_at TEXT NOT NULL
  );
`);

const initialMigration = `
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    username TEXT NOT NULL UNIQUE COLLATE NOCASE,
    password_salt TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('admin', 'customer')),
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS sessions_user_id_idx ON sessions(user_id);
  CREATE TABLE IF NOT EXISTS devices (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    device_identifier TEXT NOT NULL,
    udid TEXT,
    name TEXT,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'active', 'revoked')),
    created_at TEXT NOT NULL,
    UNIQUE(user_id, device_identifier)
  );
  CREATE TABLE IF NOT EXISTS entitlements (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked')),
    expires_at TEXT,
    created_at TEXT NOT NULL,
    UNIQUE(user_id, device_id)
  );
  CREATE TABLE IF NOT EXISTS apps (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    category TEXT NOT NULL DEFAULT 'Other',
    icon_path TEXT,
    featured INTEGER NOT NULL DEFAULT 0 CHECK (featured IN (0, 1)),
    status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published', 'archived')),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS app_versions (
    id TEXT PRIMARY KEY,
    app_id TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
    version TEXT NOT NULL,
    build TEXT NOT NULL,
    ipa_path TEXT,
    file_size INTEGER NOT NULL DEFAULT 0,
    sha256 TEXT,
    release_notes TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published')),
    published_at TEXT,
    created_at TEXT NOT NULL,
    UNIQUE(app_id, version, build)
  );
  CREATE INDEX IF NOT EXISTS app_versions_latest_idx ON app_versions(app_id, status, published_at DESC);
  CREATE TABLE IF NOT EXISTS app_updates (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    latest_version TEXT NOT NULL,
    minimum_version TEXT NOT NULL,
    mandatory INTEGER NOT NULL DEFAULT 0 CHECK (mandatory IN (0, 1)),
    download_path TEXT,
    sha256 TEXT,
    release_notes TEXT NOT NULL DEFAULT '[]',
    updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS audit_logs (
    id TEXT PRIMARY KEY,
    actor_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
    action TEXT NOT NULL,
    subject_id TEXT,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS audit_logs_created_idx ON audit_logs(created_at DESC);
`;

if (!database.prepare("SELECT version FROM schema_migrations WHERE version = ?").get("001_initial_schema")) {
  database.exec("BEGIN IMMEDIATE");
  try {
    database.exec(initialMigration);
    database.prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)")
      .run("001_initial_schema", new Date().toISOString());
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

const certificateMigration = `
  CREATE TABLE IF NOT EXISTS signing_certificates (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    p12_storage_name TEXT NOT NULL,
    provision_storage_name TEXT NOT NULL,
    password_storage_name TEXT NOT NULL,
    expiration_date TEXT,
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked')),
    created_at TEXT NOT NULL
  );
  ALTER TABLE devices ADD COLUMN certificate_id TEXT REFERENCES signing_certificates(id) ON DELETE SET NULL;
  ALTER TABLE entitlements ADD COLUMN certificate_id TEXT REFERENCES signing_certificates(id) ON DELETE SET NULL;
`;

if (!database.prepare("SELECT version FROM schema_migrations WHERE version = ?").get("002_signing_certificates")) {
  database.exec("BEGIN IMMEDIATE");
  try {
    database.exec(certificateMigration);
    database.prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)")
      .run("002_signing_certificates", new Date().toISOString());
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

if (!database.prepare("SELECT version FROM schema_migrations WHERE version = ?").get("003_user_certificate")) {
  database.exec("BEGIN IMMEDIATE");
  try {
    database.exec("ALTER TABLE users ADD COLUMN certificate_id TEXT REFERENCES signing_certificates(id) ON DELETE SET NULL;");
    database.exec("ALTER TABLE users ADD COLUMN plain_password TEXT;");
    database.prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)")
      .run("003_user_certificate", new Date().toISOString());
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

if (!database.prepare("SELECT version FROM schema_migrations WHERE version = ?").get("004_external_download_url")) {
  database.exec("BEGIN IMMEDIATE");
  try {
    database.exec(`
      ALTER TABLE app_versions ADD COLUMN external_url TEXT;
    `);
    database.prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)")
      .run("004_external_download_url", new Date().toISOString());
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

// Migration 005: ensure user columns added by 003 actually exist (003 may have partially failed
// on existing DBs because SQLite rejects multiple ALTER TABLEs in one exec() call).
if (!database.prepare("SELECT version FROM schema_migrations WHERE version = ?").get("005_ensure_user_columns")) {
  database.exec("BEGIN IMMEDIATE");
  try {
    const cols = database.prepare("PRAGMA table_info(users)").all().map((c) => c.name);
    if (!cols.includes("certificate_id"))
      database.exec("ALTER TABLE users ADD COLUMN certificate_id TEXT REFERENCES signing_certificates(id) ON DELETE SET NULL;");
    if (!cols.includes("plain_password"))
      database.exec("ALTER TABLE users ADD COLUMN plain_password TEXT;");
    database.prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)")
      .run("005_ensure_user_columns", new Date().toISOString());
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

if (!database.prepare("SELECT version FROM schema_migrations WHERE version = ?").get("006_custom_pages")) {
  database.exec("BEGIN IMMEDIATE");
  try {
    database.exec(`CREATE TABLE IF NOT EXISTS custom_pages (
      slug TEXT PRIMARY KEY,
      title TEXT NOT NULL DEFAULT '',
      html_content TEXT NOT NULL DEFAULT '',
      updated_at TEXT NOT NULL
    );`);
    database.prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)")
      .run("006_custom_pages", new Date().toISOString());
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

function passwordHash(password, salt) {
  return scryptSync(password, salt, 64).toString("hex");
}

export function verifyPassword(password, salt, expectedHash) {
  const expected = Buffer.from(expectedHash, "hex");
  const actual = Buffer.from(passwordHash(password, salt), "hex");
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

export function createUser({ username, password, role = "customer", status = "active", certificateId = null }) {
  const salt = randomBytes(16).toString("hex");
  const now = new Date().toISOString();
  const id = randomUUID();
  database.prepare(`
    INSERT INTO users (id, username, password_salt, password_hash, role, status, certificate_id, plain_password, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, username, salt, passwordHash(password, salt), role, status, certificateId || null, password, now);
  return { id, username, role, status, certificate_id: certificateId || null, plain_password: password, created_at: now };
}

export function updateUserPassword(userId, newPassword) {
  const salt = randomBytes(16).toString("hex");
  database.prepare(`
    UPDATE users SET password_salt = ?, password_hash = ?, plain_password = ? WHERE id = ?
  `).run(salt, passwordHash(newPassword, salt), newPassword, userId);
  database.prepare("DELETE FROM sessions WHERE user_id = ?").run(userId);
}

export function updateUser(userId, { status, certificateId }) {
  if (status !== undefined && certificateId !== undefined) {
    database.prepare("UPDATE users SET status = ?, certificate_id = ? WHERE id = ?").run(status, certificateId, userId);
  } else if (status !== undefined) {
    database.prepare("UPDATE users SET status = ? WHERE id = ?").run(status, userId);
  } else if (certificateId !== undefined) {
    database.prepare("UPDATE users SET certificate_id = ? WHERE id = ?").run(certificateId, userId);
  }
}

export function deleteUser(userId) {
  database.prepare("DELETE FROM users WHERE id = ?").run(userId);
}

const existingAdmin = database.prepare("SELECT id FROM users WHERE role = 'admin' LIMIT 1").get();
if (!existingAdmin) {
  createUser({
    username: config.adminUsername,
    password: config.adminPassword,
    role: "admin"
  });
}

export function audit(actorUserId, action, subjectId = null) {
  database.prepare(`
    INSERT INTO audit_logs (id, actor_user_id, action, subject_id, created_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(randomUUID(), actorUserId, action, subjectId, new Date().toISOString());
}
