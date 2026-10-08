import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { deflateRawSync } from "node:zlib";
import { test } from "node:test";

const projectRoot = path.resolve(import.meta.dirname, "..");

async function availablePort() {
  const socket = net.createServer();
  socket.listen(0, "127.0.0.1");
  await once(socket, "listening");
  const { port } = socket.address();
  await new Promise((resolve, reject) => socket.close((error) => error ? reject(error) : resolve()));
  return port;
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function makeIpa(version, build, identifier = "com.example.demo") {
  const name = Buffer.from("Payload/Demo.app/Info.plist");
  const info = Buffer.from(`<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>${identifier}</string><key>CFBundleShortVersionString</key><string>${version}</string><key>CFBundleVersion</key><string>${build}</string></dict></plist>`);
  const compressed = deflateRawSync(info);
  const checksum = crc32(info);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(8, 8);
  local.writeUInt32LE(checksum, 14);
  local.writeUInt32LE(compressed.length, 18);
  local.writeUInt32LE(info.length, 22);
  local.writeUInt16LE(name.length, 26);
  const localEntry = Buffer.concat([local, name, compressed]);

  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(8, 10);
  central.writeUInt32LE(checksum, 16);
  central.writeUInt32LE(compressed.length, 20);
  central.writeUInt32LE(info.length, 24);
  central.writeUInt16LE(name.length, 28);
  const centralEntry = Buffer.concat([central, name]);

  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(centralEntry.length, 12);
  end.writeUInt32LE(localEntry.length, 16);
  return Buffer.concat([localEntry, centralEntry, end]);
}

test("Fplus API authenticates, publishes a verified IPA, and gates signing packages", async (t) => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "fplus-api-test-"));
  const port = await availablePort();
  const adminPassword = `Admin-${randomBytes(18).toString("hex")}`;
  const processHandle = spawn(process.execPath, [path.join(projectRoot, "src", "server.mjs")], {
    cwd: projectRoot,
    env: {
      ...process.env,
      SERVER_HOST: "127.0.0.1",
      SERVER_PORT: String(port),
      DATABASE_PATH: path.join(temp, "data", "store.sqlite"),
      STORAGE_PATH: path.join(temp, "storage"),
      SIGNING_STORAGE_PATH: path.join(temp, "storage", "signing"),
      JWT_SECRET: randomBytes(32).toString("hex"),
      ENCRYPTION_KEY: randomBytes(32).toString("hex"),
      ADMIN_USERNAME: "test-admin",
      ADMIN_PASSWORD: adminPassword,
      TLS_CERT_PATH: "",
      TLS_KEY_PATH: ""
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  let output = "";
  processHandle.stdout.setEncoding("utf8").on("data", (data) => { output += data; });
  processHandle.stderr.setEncoding("utf8").on("data", (data) => { output += data; });
  const base = `http://127.0.0.1:${port}`;

  t.after(async () => {
    processHandle.kill();
    if (processHandle.exitCode === null) await once(processHandle, "exit").catch(() => {});
    await fs.rm(temp, { recursive: true, force: true });
  });

  let health;
  for (let attempt = 0; attempt < 100; attempt++) {
    if (processHandle.exitCode !== null) assert.fail(`Server stopped early: ${output}`);
    try {
      health = await fetch(`${base}/api/health`);
      if (health.ok) break;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.equal(health?.status, 200, `Server did not become healthy: ${output}`);

  const loginResponse = await fetch(`${base}/api/auth/login`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: "test-admin", password: adminPassword })
  });
  assert.equal(loginResponse.status, 200);
  const { token } = await loginResponse.json();
  const sessionCookie = loginResponse.headers.get("set-cookie").split(";")[0];
  assert.ok(token);
  const adminHeaders = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };

  const unauthenticated = await fetch(`${base}/api/admin/apps`);
  assert.equal(unauthenticated.status, 401);
  const cookieSession = await fetch(`${base}/api/admin/apps`, { headers: { Cookie: sessionCookie } });
  assert.equal(cookieSession.status, 200);

  const createAppResponse = await fetch(`${base}/api/admin/apps`, {
    method: "POST", headers: adminHeaders,
    body: JSON.stringify({ name: "Demo App", category: "Utilities", description: "Sample listing", featured: true })
  });
  assert.equal(createAppResponse.status, 201);
  const { id: appId } = await createAppResponse.json();

  const createVersionResponse = await fetch(`${base}/api/admin/apps/${appId}/versions`, {
    method: "POST", headers: adminHeaders,
    body: JSON.stringify({ version: "1.2.3", build: "12", release_notes: "Stability improvements" })
  });
  assert.equal(createVersionResponse.status, 201);
  const { id: versionId } = await createVersionResponse.json();

  const ipa = makeIpa("1.2.3", "12");
  const uploadResponse = await fetch(`${base}/api/admin/apps/${appId}/versions/${versionId}/ipa`, {
    method: "PUT", headers: { ...adminHeaders, "Content-Type": "application/octet-stream" }, body: ipa
  });
  assert.equal(uploadResponse.status, 200);
  const uploaded = await uploadResponse.json();
  assert.equal(uploaded.sha256, createHash("sha256").update(ipa).digest("hex"));

  const publishResponse = await fetch(`${base}/api/admin/apps/${appId}/versions/${versionId}`, {
    method: "PUT", headers: adminHeaders, body: JSON.stringify({ status: "published" })
  });
  assert.equal(publishResponse.status, 200);
  const catalogResponse = await fetch(`${base}/api/store/apps`);
  const catalog = await catalogResponse.json();
  assert.equal(catalog.apps.length, 1);
  assert.equal(catalog.apps[0].version, "1.2.3");

  const detailResponse = await fetch(`${base}/api/store/apps/${appId}`);
  assert.equal(detailResponse.status, 200);
  const details = await detailResponse.json();
  const downloadResponse = await fetch(`${base}${details.versions[0].download_url}`);
  assert.equal(downloadResponse.status, 200);
  assert.equal(downloadResponse.headers.get("x-checksum-sha256"), uploaded.sha256);
  assert.deepEqual(Buffer.from(await downloadResponse.arrayBuffer()), ipa);

  const iconBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);
  const iconResponse = await fetch(`${base}/api/admin/apps/${appId}/icon`, {
    method: "PUT", headers: { ...adminHeaders, "Content-Type": "image/png" }, body: iconBytes
  });
  assert.equal(iconResponse.status, 200);

  const invalidIpa = await fetch(`${base}/api/admin/apps/${appId}/versions/${versionId}/ipa`, {
    method: "PUT", headers: { ...adminHeaders, "Content-Type": "application/octet-stream" },
    body: Buffer.from("not an IPA")
  });
  assert.equal(invalidIpa.status, 400);
  const catalogStillValid = await (await fetch(`${base}/api/store/apps`)).json();
  assert.equal(catalogStillValid.apps[0].version, "1.2.3");

  const [storedFilename] = await fs.readdir(path.join(temp, "storage", "apps"));
  const storedPath = path.join(temp, "storage", "apps", storedFilename);
  const storedIPA = await fs.readFile(storedPath);
  const corruptedIPA = Buffer.from(storedIPA);
  corruptedIPA[corruptedIPA.length - 1] ^= 0xff;
  await fs.writeFile(storedPath, corruptedIPA);
  const corruptedDownload = await fetch(`${base}${details.versions[0].download_url}`);
  assert.equal(corruptedDownload.status, 500);
  await fs.writeFile(storedPath, storedIPA);

  const mismatchedIpa = await fetch(`${base}/api/admin/apps/${appId}/versions/${versionId}/ipa`, {
    method: "PUT", headers: { ...adminHeaders, "Content-Type": "application/octet-stream" },
    body: makeIpa("9.9.9", "99")
  });
  assert.equal(mismatchedIpa.status, 400);

  const customerPassword = `Customer-${randomBytes(16).toString("hex")}`;
  const userResponse = await fetch(`${base}/api/admin/users`, {
    method: "POST", headers: adminHeaders,
    body: JSON.stringify({ username: "customer-two", password: customerPassword })
  });
  assert.equal(userResponse.status, 201);
  const customerLogin = await fetch(`${base}/api/auth/login`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: "customer-two", password: customerPassword })
  });
  assert.equal(customerLogin.status, 200);
  const customerToken = (await customerLogin.json()).token;
  const customerHeaders = { Authorization: `Bearer ${customerToken}`, "Content-Type": "application/json" };

  const deviceResponse = await fetch(`${base}/api/device/register`, {
    method: "POST", headers: customerHeaders,
    body: JSON.stringify({ device_identifier: "install-instance-1", name: "Test phone", udid: "sample-udid" })
  });
  assert.equal(deviceResponse.status, 202);
  const device = await deviceResponse.json();
  assert.equal(device.status, "pending");
  const deniedPackage = await fetch(`${base}/api/signing-package/request`, {
    method: "POST", headers: customerHeaders, body: JSON.stringify({ device_id: device.device_id })
  });
  assert.equal(deniedPackage.status, 403);

  const approveDevice = await fetch(`${base}/api/admin/devices/${device.device_id}`, {
    method: "PUT", headers: adminHeaders, body: JSON.stringify({ status: "active" })
  });
  assert.equal(approveDevice.status, 200);
  const grantEntitlement = await fetch(`${base}/api/admin/devices/${device.device_id}/entitlement`, {
    method: "PUT", headers: adminHeaders, body: JSON.stringify({ status: "active", expires_at: null })
  });
  assert.equal(grantEntitlement.status, 200);
  const unassignedSigning = await fetch(`${base}/api/signing-package/request`, {
    method: "POST", headers: customerHeaders, body: JSON.stringify({ device_id: device.device_id })
  });
  assert.equal(unassignedSigning.status, 404);

  const createCert = await fetch(`${base}/api/admin/certificates`, {
    method: "POST", headers: adminHeaders, body: JSON.stringify({
      name: "Test Developer Cert",
      p12_base64: Buffer.from("FAKE_P12_DATA").toString("base64"),
      provision_base64: Buffer.from("FAKE_PROVISION_DATA").toString("base64"),
      password: "cert-password-123",
      expiration_date: "2027-01-01"
    })
  });
  assert.equal(createCert.status, 201);
  const certInfo = await createCert.json();

  const grantCertEntitlement = await fetch(`${base}/api/admin/devices/${device.device_id}/entitlement`, {
    method: "PUT", headers: adminHeaders, body: JSON.stringify({ status: "active", expires_at: null, certificate_id: certInfo.id })
  });
  assert.equal(grantCertEntitlement.status, 200);

  const deliveryResponse = await fetch(`${base}/api/signing-package/request`, {
    method: "POST", headers: customerHeaders, body: JSON.stringify({ device_id: device.device_id })
  });
  assert.equal(deliveryResponse.status, 200);
  const signingPackage = await deliveryResponse.json();
  assert.equal(signingPackage.name, "Test Developer Cert");
  assert.equal(signingPackage.password, "cert-password-123");
  assert.equal(Buffer.from(signingPackage.p12_base64, "base64").toString(), "FAKE_P12_DATA");
  assert.equal(Buffer.from(signingPackage.provision_base64, "base64").toString(), "FAKE_PROVISION_DATA");

  const appUpdate = await fetch(`${base}/api/admin/store-update`, {
    method: "PUT", headers: adminHeaders,
    body: JSON.stringify({ latest_version: "1.4.0", minimum_version: "1.2.0", mandatory: false, release_notes: ["Improved reliability"] })
  });
  assert.equal(appUpdate.status, 200);
  const updateResponse = await fetch(`${base}/api/app/update`);
  const updateInfo = await updateResponse.json();
  assert.equal(updateInfo.latest_version, "1.4.0");
  assert.equal(updateInfo.download_url, null);

  const storeUpdateUpload = await fetch(`${base}/api/admin/store-update/ipa`, {
    method: "PUT", headers: { ...adminHeaders, "Content-Type": "application/octet-stream" },
    body: makeIpa("1.4.0", "14")
  });
  assert.equal(storeUpdateUpload.status, 200);
  const updateDigest = (await storeUpdateUpload.json()).sha256;
  const updatePackageInfo = await (await fetch(`${base}/api/app/update`)).json();
  assert.equal(updatePackageInfo.sha256, updateDigest);
  const updatePackage = await fetch(`${base}${updatePackageInfo.download_url}`);
  assert.equal(updatePackage.status, 200);
  assert.deepEqual(Buffer.from(await updatePackage.arrayBuffer()), makeIpa("1.4.0", "14"));

  const auditResponse = await fetch(`${base}/api/admin/logs`, { headers: adminHeaders });
  const audit = await auditResponse.text();
  assert.ok(audit.includes("version.ipa_upload"));
  assert.ok(!audit.includes(adminPassword));
  assert.ok(!audit.includes(token));

  const adminPage = await fetch(`${base}/`);
  assert.equal(adminPage.status, 200);
  assert.match(adminPage.headers.get("content-security-policy"), /default-src 'self'/u);
});
