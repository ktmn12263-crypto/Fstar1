import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function loadEnvironmentFile() {
  const file = path.join(root, ".env");
  if (!fs.existsSync(file)) return;

  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/u)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/u);
    if (!match || match[1] in process.env) continue;
    const value = match[2].replace(/^(['"])(.*)\1$/u, "$2");
    process.env[match[1]] = value;
  }
}

loadEnvironmentFile();

function required(name, minimumLength = 1) {
  const value = process.env[name]?.trim();
  if (!value || value.length < minimumLength) {
    throw new Error(`${name} must be configured with at least ${minimumLength} characters`);
  }
  return value;
}

function positiveInteger(name, fallback, maximum = Number.MAX_SAFE_INTEGER) {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new Error(`${name} must be a positive integer no greater than ${maximum}`);
  }
  return value;
}

const jwtSecret = required("JWT_SECRET", 32);
const encryptionKey = required("ENCRYPTION_KEY", 64);
if (!/^[0-9a-f]{64}$/iu.test(encryptionKey)) {
  throw new Error("ENCRYPTION_KEY must be a 32-byte hexadecimal value");
}

export const config = Object.freeze({
  root,
  host: process.env.SERVER_HOST?.trim() || "127.0.0.1",
  port: positiveInteger("SERVER_PORT", 4317, 65535),
  databasePath: path.resolve(root, process.env.DATABASE_PATH || "./data/fplus.sqlite"),
  storagePath: path.resolve(root, process.env.STORAGE_PATH || "./storage"),
  signingStoragePath: path.resolve(root, process.env.SIGNING_STORAGE_PATH || "./storage/signing"),
  jwtSecret,
  encryptionKey,
  adminUsername: required("ADMIN_USERNAME", 3),
  adminPassword: required("ADMIN_PASSWORD", 12),
  sessionTtlHours: positiveInteger("SESSION_TTL_HOURS", 12, 720),
  maxIpaSizeBytes: positiveInteger("MAX_IPA_SIZE_BYTES", 2_147_483_648),
  tlsCertPath: process.env.TLS_CERT_PATH ? path.resolve(root, process.env.TLS_CERT_PATH) : null,
  tlsKeyPath: process.env.TLS_KEY_PATH ? path.resolve(root, process.env.TLS_KEY_PATH) : null
});

if (Boolean(config.tlsCertPath) !== Boolean(config.tlsKeyPath)) {
  throw new Error("TLS_CERT_PATH and TLS_KEY_PATH must both be configured");
}
if (!config.tlsCertPath && !["127.0.0.1", "::1", "localhost"].includes(config.host.toLowerCase())) {
  throw new Error("Binding to a network interface requires TLS_CERT_PATH and TLS_KEY_PATH");
}
