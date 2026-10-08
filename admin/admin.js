const pages = new Map([
  ["dashboard", "Dashboard"], ["apps", "Apps"], ["users", "Users"],
  ["devices", "Devices"], ["certificates", "Certificates"], ["updates", "Store Updates"], ["logs", "Audit Logs"], ["settings", "Settings"]
]);
const content = document.getElementById("pageContent");
const notice = document.getElementById("notice");
let currentPage = "dashboard";
let cachedApps = [];
let noticeTimer;

function escapeHTML(value) {
  return String(value ?? "").replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  })[character]);
}

function inform(message, isError = false) {
  notice.textContent = message;
  notice.classList.toggle("error", isError);
  notice.hidden = false;
  clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => { notice.hidden = true; }, 3800);
}

async function api(endpoint, options = {}) {
  const headers = new Headers(options.headers || {});
  if (options.body && !(options.body instanceof Blob) && !(options.body instanceof FormData)) {
    headers.set("Content-Type", "application/json");
    options.body = JSON.stringify(options.body);
  }
  const response = await fetch(endpoint, { ...options, headers, credentials: "same-origin" });
  const result = response.status === 204 ? null : await response.json().catch(() => null);
  if (!response.ok) throw new Error(result?.error || `Request failed (${response.status})`);
  return result;
}

function setAuthenticated(user) {
  document.getElementById("loginScreen").hidden = Boolean(user);
  document.getElementById("adminApp").hidden = !user;
  if (user) navigate("dashboard");
}

async function checkSession() {
  try {
    const result = await api("/api/auth/me");
    setAuthenticated(result.user);
  } catch {
    setAuthenticated(null);
  }
}

function navigate(page) {
  if (!pages.has(page)) return;
  currentPage = page;
  document.getElementById("pageHeading").textContent = pages.get(page);
  document.querySelectorAll(".nav-item").forEach((button) => button.classList.toggle("active", button.dataset.page === page));
  document.getElementById("sidebar").classList.remove("open");
  renderPage().catch((error) => {
    inform(error.message, true);
    content.innerHTML = `<div class="empty-card"><strong>Unable to load this section</strong>${escapeHTML(error.message)}</div>`;
  });
}

async function renderPage() {
  content.innerHTML = '<div class="loading">Loading…</div>';
  if (currentPage === "dashboard") return renderDashboard();
  if (currentPage === "apps") return renderApps();
  if (currentPage === "users") return renderUsers();
  if (currentPage === "devices") return renderDevices();
  if (currentPage === "certificates") return renderCertificates();
  if (currentPage === "updates") return renderUpdates();
  if (currentPage === "logs") return renderLogs();
  if (currentPage === "settings") return renderSettings();
}

function empty(message, action = "") {
  return `<div class="empty-card"><strong>${escapeHTML(message)}</strong>${action}</div>`;
}

function pageTitle(title, description, button = "") {
  return `<div class="page-title"><div><h2>${escapeHTML(title)}</h2><p>${escapeHTML(description)}</p></div>${button}</div>`;
}

async function renderDashboard() {
  const [appData, users, devices, health] = await Promise.all([
    api("/api/admin/apps"), api("/api/admin/users"), api("/api/admin/devices"), api("/api/health")
  ]);
  cachedApps = appData.apps;
  const published = cachedApps.filter((app) => app.status === "published").length;
  const pending = devices.devices.filter((device) => device.status === "pending").length;
  const recent = cachedApps.slice(0, 5);
  content.innerHTML = `${pageTitle("Store overview", "A quick view of your local Fplus service.")}
    <div class="stats-grid">
      <article class="stat-card"><span>Published apps</span><strong>${published}</strong></article>
      <article class="stat-card"><span>Total apps</span><strong>${cachedApps.length}</strong></article>
      <article class="stat-card"><span>Customer accounts</span><strong>${users.users.filter((user) => user.role === "customer").length}</strong></article>
      <article class="stat-card"><span>Pending devices</span><strong>${pending}</strong></article>
    </div>
    <section class="panel"><h3>Service status</h3><p class="muted">Fplus API is ${health.status === "ok" ? "running" : "unavailable"} on this server. Customer app signing is performed locally; the server never signs an IPA.</p></section>
    <section class="panel"><h3>Recently updated apps</h3>${recent.length ? recent.map(appRow).join("") : empty("No apps yet", "Add an app to start building your private catalog.")}</section>`;
  content.querySelectorAll("[data-open-app]").forEach((button) => button.addEventListener("click", () => navigate("apps")));
}

function appRow(app) {
  const icon = app.icon_url ? `<img src="${escapeHTML(app.icon_url)}" alt="" class="app-placeholder" style="object-fit:cover">` : `<span class="app-placeholder">${escapeHTML(app.name.slice(0, 1).toUpperCase())}</span>`;
  const latest = app.versions?.find((version) => version.status === "published");
  return `<article class="app-row">
    ${icon}<div><p class="app-name">${escapeHTML(app.name)}</p><p class="app-description">${escapeHTML(app.description || app.category)}</p></div>
    <span class="badge ${escapeHTML(app.status)}">${escapeHTML(app.status)}${latest ? ` · v${escapeHTML(latest.version)}` : ""}</span>
    <div class="row-actions"><button class="secondary" type="button" data-open-app="${escapeHTML(app.id)}">Manage</button>
    ${app.status === "draft" && latest ? `<button class="quiet" type="button" data-publish-app="${escapeHTML(app.id)}">Publish app</button>` : ""}
    <button class="danger" type="button" data-archive-app="${escapeHTML(app.id)}">Archive</button></div>
  </article>`;
}

async function renderApps() {
  const result = await api("/api/admin/apps");
  cachedApps = result.apps;
  content.innerHTML = `${pageTitle("Apps", "Create a listing, upload versions, and publish them to the customer catalog.")}
    <section class="panel"><h3>Add app</h3>
      <form id="createAppForm" class="stack-form">
        <label>App name<input name="name" maxlength="120" required></label>
        <label>Category<input name="category" maxlength="80" placeholder="Utilities" required></label>
        <label class="full">Description<textarea name="description" maxlength="5000"></textarea></label>
        <label class="check-label full"><input name="featured" type="checkbox"> Feature this app on the store home</label>
        <div class="full"><button class="primary" type="submit">Create app</button></div>
      </form>
    </section>
    <section class="panel"><h3>Catalog (${cachedApps.length})</h3>
      ${cachedApps.length ? cachedApps.map((app) => `<div class="app-management" data-app-panel="${escapeHTML(app.id)}">${appRow(app)}
      <details class="panel"><summary>Edit listing details</summary><form class="stack-form" data-app-form="${escapeHTML(app.id)}">
        <label>App name<input name="name" maxlength="120" value="${escapeHTML(app.name)}" required></label>
        <label>Category<input name="category" maxlength="80" value="${escapeHTML(app.category)}" required></label>
        <label class="full">Description<textarea name="description" maxlength="5000">${escapeHTML(app.description || "")}</textarea></label>
        <label class="check-label full"><input name="featured" type="checkbox" ${app.featured ? "checked" : ""}> Feature this app</label>
        <button class="secondary" type="submit">Save app details</button>
      </form></details>
      <div class="version-list">${(app.versions || []).map((version) => versionRow(app, version)).join("")}</div>
      <div class="split">
        <form class="version-form panel" data-version-form="${escapeHTML(app.id)}">
          <h3>New version · ${escapeHTML(app.name)}</h3>
          <label>Version<input name="version" maxlength="32" placeholder="1.0.0" required></label>
          <label>Build<input name="build" maxlength="32" placeholder="1" required></label>
          <label class="full">What's New<textarea name="release_notes" maxlength="5000"></textarea></label>
          <button class="primary" type="submit">Create version</button>
        </form>
        <div class="panel"><h3>Upload app icon</h3><p class="muted">PNG, JPEG or WebP · max 10 MB</p><input class="file-control" type="file" accept="image/png,image/jpeg,image/webp" data-icon-file="${escapeHTML(app.id)}"><button class="secondary" type="button" data-upload-icon="${escapeHTML(app.id)}">Upload icon</button></div>
      </div></div>`).join("") : empty("Your app catalog is empty", "Use the form above to create your first app listing.")}</section>`;

  document.getElementById("createAppForm").addEventListener("submit", createApp);
  content.querySelectorAll("[data-version-form]").forEach((form) => form.addEventListener("submit", createVersion));
  content.querySelectorAll("[data-app-form]").forEach((form) => form.addEventListener("submit", updateApp));
  content.querySelectorAll("[data-version-edit]").forEach((form) => form.addEventListener("submit", updateVersion));
  content.querySelectorAll("[data-upload-ipa]").forEach((button) => button.addEventListener("click", uploadIpa));
  content.querySelectorAll("[data-upload-icon]").forEach((button) => button.addEventListener("click", uploadIcon));
  content.querySelectorAll("[data-publish-version]").forEach((button) => button.addEventListener("click", publishVersion));
  content.querySelectorAll("[data-publish-app]").forEach((button) => button.addEventListener("click", publishApp));
  content.querySelectorAll("[data-archive-app]").forEach((button) => button.addEventListener("click", archiveApp));
  content.querySelectorAll("[data-upload-file]").forEach((input) => input.addEventListener("change", (event) => {
    const label = content.querySelector(`[data-file-label="${CSS.escape(input.dataset.uploadFile)}"]`);
    if (label) label.textContent = event.target.files[0]?.name || "No file chosen";
  }));
  content.querySelectorAll("[data-open-app]").forEach((button) => button.addEventListener("click", () => {
    content.querySelector(`[data-app-panel="${CSS.escape(button.dataset.openApp)}"]`)?.scrollIntoView({ behavior: "smooth", block: "start" });
  }));
}

function versionRow(app, version) {
  const size = version.file_size ? `${(version.file_size / 1024 / 1024).toFixed(1)} MB` : "IPA missing";
  const upload = version.has_ipa ? "" : `<label class="file-pick">Choose IPA<input class="file-control" type="file" accept=".ipa,application/octet-stream" data-upload-file="${escapeHTML(version.id)}"></label><span data-file-label="${escapeHTML(version.id)}">No file chosen</span><button class="secondary" type="button" data-upload-ipa="${escapeHTML(version.id)}" data-app-id="${escapeHTML(app.id)}">Upload</button>`;
  const canPublish = version.status !== "published" && version.has_ipa;
  const publishButton = version.status === "published" ? "" : `<button class="quiet" type="button" data-publish-version="${escapeHTML(version.id)}" data-app-id="${escapeHTML(app.id)}" ${canPublish ? "" : "disabled"}>Publish version</button>`;
  return `<div class="version-row"><div><div class="version-label">v${escapeHTML(version.version)} · build ${escapeHTML(version.build)}</div><div class="version-meta">${size} · ${escapeHTML(version.sha256 || "Waiting for IPA")} · ${escapeHTML(version.status)}</div>
    <details><summary>Edit release notes</summary><form class="inline-form" data-version-edit="${escapeHTML(version.id)}" data-app-id="${escapeHTML(app.id)}">
      <label>What's New<textarea name="release_notes" maxlength="5000">${escapeHTML(version.release_notes || "")}</textarea></label><button class="secondary" type="submit">Save notes</button>
    </form></details></div><div class="row-actions">${upload}${publishButton}</div></div>`;
}

async function createApp(event) {
  event.preventDefault();
  const form = new FormData(event.currentTarget);
  try {
    await api("/api/admin/apps", { method: "POST", body: {
      name: form.get("name"), category: form.get("category"), description: form.get("description"),
      featured: form.has("featured"), status: "draft"
    } });
    inform("App listing created.");
    await renderApps();
  } catch (error) { inform(error.message, true); }
}

async function createVersion(event) {
  event.preventDefault();
  const appId = event.currentTarget.dataset.versionForm;
  const form = new FormData(event.currentTarget);
  try {
    await api(`/api/admin/apps/${encodeURIComponent(appId)}/versions`, { method: "POST", body: {
      version: form.get("version"), build: form.get("build"), release_notes: form.get("release_notes")
    } });
    inform("Version created. Upload its IPA before publishing.");
    await renderApps();
  } catch (error) { inform(error.message, true); }
}

async function updateApp(event) {
  event.preventDefault();
  const appId = event.currentTarget.dataset.appForm;
  const form = new FormData(event.currentTarget);
  try {
    await api(`/api/admin/apps/${encodeURIComponent(appId)}`, { method: "PUT", body: {
      name: form.get("name"), category: form.get("category"), description: form.get("description"), featured: form.has("featured")
    } });
    inform("App details saved.");
    await renderApps();
  } catch (error) { inform(error.message, true); }
}

async function updateVersion(event) {
  event.preventDefault();
  const appId = event.currentTarget.dataset.appId;
  const versionId = event.currentTarget.dataset.versionEdit;
  const form = new FormData(event.currentTarget);
  try {
    await api(`/api/admin/apps/${encodeURIComponent(appId)}/versions/${encodeURIComponent(versionId)}`, {
      method: "PUT", body: { release_notes: form.get("release_notes") }
    });
    inform("Release notes saved.");
    await renderApps();
  } catch (error) { inform(error.message, true); }
}

async function uploadIpa(event) {
  const versionId = event.currentTarget.dataset.uploadIpa;
  const appId = event.currentTarget.dataset.appId;
  const file = content.querySelector(`[data-upload-file="${CSS.escape(versionId)}"]`)?.files[0];
  if (!file) return inform("Choose an IPA file first.", true);
  try {
    await api(`/api/admin/apps/${encodeURIComponent(appId)}/versions/${encodeURIComponent(versionId)}/ipa`, {
      method: "PUT", headers: { "Content-Type": "application/octet-stream" }, body: file
    });
    inform("IPA uploaded and SHA-256 recorded.");
    await renderApps();
  } catch (error) { inform(error.message, true); }
}

async function uploadIcon(event) {
  const appId = event.currentTarget.dataset.uploadIcon;
  const file = content.querySelector(`[data-icon-file="${CSS.escape(appId)}"]`)?.files[0];
  if (!file) return inform("Choose an icon file first.", true);
  try {
    await api(`/api/admin/apps/${encodeURIComponent(appId)}/icon`, {
      method: "PUT", headers: { "Content-Type": file.type }, body: file
    });
    inform("App icon uploaded.");
    await renderApps();
  } catch (error) { inform(error.message, true); }
}

async function publishVersion(event) {
  const { appId, publishVersion: versionId } = event.currentTarget.dataset;
  try {
    await api(`/api/admin/apps/${encodeURIComponent(appId)}/versions/${encodeURIComponent(versionId)}`, {
      method: "PUT", body: { status: "published" }
    });
    inform("Version published to the Fplus catalog.");
    await renderApps();
  } catch (error) { inform(error.message, true); }
}

async function publishApp(event) {
  const appId = event.currentTarget.dataset.publishApp;
  try {
    await api(`/api/admin/apps/${encodeURIComponent(appId)}`, { method: "PUT", body: { status: "published" } });
    inform("App published to the Fplus catalog.");
    await renderApps();
  } catch (error) { inform(error.message, true); }
}

async function archiveApp(event) {
  const appId = event.currentTarget.dataset.archiveApp;
  if (!confirm("Archive this app? It will no longer appear in the public store.")) return;
  try {
    await api(`/api/admin/apps/${encodeURIComponent(appId)}`, { method: "DELETE" });
    inform("App archived.");
    await renderApps();
  } catch (error) { inform(error.message, true); }
}

async function renderUsers() {
  const [result, certData] = await Promise.all([
    api("/api/admin/users"),
    api("/api/admin/certificates")
  ]);
  const customers = result.users.filter((user) => user.role === "customer");
  const activeCerts = certData.certificates.filter((c) => c.status === "active");

  content.innerHTML = `${pageTitle("Users Management", "Complete management for customer accounts: passwords, certificates, and status.")}
    <section class="panel">
      <h3>Create new customer account</h3>
      <form id="userForm" class="stack-form">
        <label>Username
          <input name="username" maxlength="64" placeholder="e.g. omar_client" required>
        </label>
        <label>Password
          <div style="display:flex;gap:6px">
            <input name="password" id="newPassInput" minlength="6" placeholder="Account password" required>
            <button type="button" class="secondary" id="genPassBtn" style="white-space:nowrap">Generate</button>
          </div>
        </label>
        <label class="full">Assign Signing Certificate (Optional)
          <select name="certificate_id">
            <option value="">-- No certificate assigned yet --</option>
            ${activeCerts.map((c) => `<option value="${escapeHTML(c.id)}">${escapeHTML(c.name)} (Expires: ${escapeHTML(c.expiration_date || "N/A")})</option>`).join("")}
          </select>
        </label>
        <div class="full" style="margin-top:10px">
          <button class="primary" type="submit">Create Customer</button>
        </div>
      </form>
    </section>

    <section class="panel">
      <h3>Customer accounts (${customers.length})</h3>
      ${customers.length ? `
        <div class="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Username</th>
                <th>Password</th>
                <th>Assigned Certificate</th>
                <th>Status</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              ${customers.map((user) => `
                <tr data-user-row="${escapeHTML(user.id)}">
                  <td><strong>${escapeHTML(user.username)}</strong></td>
                  <td>
                    <div style="display:flex;align-items:center;gap:6px">
                      <input type="password" id="pass_${escapeHTML(user.id)}" value="${escapeHTML(user.plain_password || '••••••••')}" readonly style="width:130px;min-height:32px;padding:4px 8px;font-size:12px;background:#f8f9fb">
                      <button type="button" class="secondary" data-toggle-pass="${escapeHTML(user.id)}" style="min-height:32px;padding:4px 8px;font-size:11px" title="Show/Hide">👁</button>
                      <button type="button" class="quiet" data-change-pass="${escapeHTML(user.id)}" style="min-height:32px;padding:4px 8px;font-size:11px" title="Change Password">✏</button>
                    </div>
                  </td>
                  <td>
                    <select data-user-cert="${escapeHTML(user.id)}" style="min-height:32px;padding:4px 8px;font-size:12px">
                      <option value="">-- None --</option>
                      ${activeCerts.map((c) => `<option value="${escapeHTML(c.id)}" ${user.certificate_id === c.id ? "selected" : ""}>${escapeHTML(c.name)}</option>`).join("")}
                    </select>
                  </td>
                  <td>
                    <span class="badge ${escapeHTML(user.status)}">${escapeHTML(user.status)}</span>
                  </td>
                  <td>
                    <div class="row-actions">
                      <button type="button" class="secondary" data-toggle-status="${escapeHTML(user.id)}" data-curr-status="${escapeHTML(user.status)}" style="min-height:32px;padding:4px 9px;font-size:11px">
                        ${user.status === "active" ? "Disable" : "Enable"}
                      </button>
                      <button type="button" class="danger" data-delete-user="${escapeHTML(user.id)}" data-username="${escapeHTML(user.username)}" style="min-height:32px;padding:4px 9px;font-size:11px">
                        Delete
                      </button>
                    </div>
                  </td>
                </tr>
              `).join("")}
            </tbody>
          </table>
        </div>
      ` : empty("No customer accounts yet")}
    </section>`;

  document.getElementById("genPassBtn")?.addEventListener("click", () => {
    const chars = "ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789!@#$%";
    let pass = "";
    for (let i = 0; i < 12; i++) pass += chars[Math.floor(Math.random() * chars.length)];
    document.getElementById("newPassInput").value = pass;
  });

  document.getElementById("userForm")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    try {
      await api("/api/admin/users", {
        method: "POST",
        body: {
          username: form.get("username"),
          password: form.get("password"),
          certificate_id: form.get("certificate_id") || null
        }
      });
      inform("Customer account created successfully!");
      await renderUsers();
    } catch (error) { inform(error.message, true); }
  });

  content.querySelectorAll("[data-toggle-pass]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const input = document.getElementById(`pass_${btn.dataset.togglePass}`);
      if (input) input.type = input.type === "password" ? "text" : "password";
    });
  });

  content.querySelectorAll("[data-change-pass]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const userId = btn.dataset.changePass;
      const newPass = prompt("Enter new password for this user (minimum 6 characters):");
      if (!newPass) return;
      if (newPass.length < 6) return inform("Password must contain at least 6 characters.", true);
      try {
        await api(`/api/admin/users/${encodeURIComponent(userId)}`, {
          method: "PUT",
          body: { password: newPass }
        });
        inform("Password updated successfully!");
        await renderUsers();
      } catch (error) { inform(error.message, true); }
    });
  });

  content.querySelectorAll("[data-user-cert]").forEach((select) => {
    select.addEventListener("change", async () => {
      const userId = select.dataset.userCert;
      const certificateId = select.value || null;
      try {
        await api(`/api/admin/users/${encodeURIComponent(userId)}`, {
          method: "PUT",
          body: { certificate_id: certificateId }
        });
        inform("Certificate updated for user!");
      } catch (error) { inform(error.message, true); }
    });
  });

  content.querySelectorAll("[data-toggle-status]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const userId = btn.dataset.toggleStatus;
      const newStatus = btn.dataset.currStatus === "active" ? "disabled" : "active";
      try {
        await api(`/api/admin/users/${encodeURIComponent(userId)}`, {
          method: "PUT",
          body: { status: newStatus }
        });
        inform(`User status changed to ${newStatus}.`);
        await renderUsers();
      } catch (error) { inform(error.message, true); }
    });
  });

  content.querySelectorAll("[data-delete-user]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const userId = btn.dataset.deleteUser;
      const username = btn.dataset.username;
      if (!confirm(`Are you sure you want to delete user '${username}'?`)) return;
      try {
        await api(`/api/admin/users/${encodeURIComponent(userId)}`, { method: "DELETE" });
        inform("User deleted.");
        await renderUsers();
      } catch (error) { inform(error.message, true); }
    });
  });
}

async function renderDevices() {
  const [result, certData] = await Promise.all([
    api("/api/admin/devices"),
    api("/api/admin/certificates")
  ]);
  const activeCerts = certData.certificates.filter((c) => c.status === "active");

  content.innerHTML = `${pageTitle("Device management", "Review registrations. Signing access requires an approved device and active entitlement with an assigned certificate.")}
    <section class="panel"><h3>Registered devices (${result.devices.length})</h3>
      ${result.devices.length ? `<div class="table-wrap"><table><thead><tr><th>Account</th><th>Device</th><th>Identifier</th><th>UDID</th><th>Status</th><th>Certificate</th><th>Actions</th></tr></thead><tbody>${result.devices.map((device) => `<tr>
        <td>${escapeHTML(device.username)}</td><td>${escapeHTML(device.name || "Unnamed device")}</td><td>${escapeHTML(device.device_identifier)}</td><td>${escapeHTML(device.udid || "—")}</td>
        <td><span class="badge ${escapeHTML(device.status)}">${escapeHTML(device.status)}</span></td>
        <td>${escapeHTML(device.certificate_name || "None")}</td>
        <td><div class="row-actions">
          ${device.status !== "active" ? `<button class="quiet" data-device-status="active" data-device-id="${escapeHTML(device.id)}">Approve</button>` : ""}
          ${device.status !== "revoked" ? `<button class="danger" data-device-status="revoked" data-device-id="${escapeHTML(device.id)}">Revoke</button>` : ""}
          <button class="secondary" data-entitlement="${escapeHTML(device.id)}">${device.entitlement_status === "active" ? "Update cert/access" : "Enable signing"}</button>
        </div></td></tr>`).join("")}</tbody></table></div>` : empty("No registered devices", "Customer registrations will appear here after login in the iOS app.")}</section>`;

  content.querySelectorAll("[data-device-status]").forEach((button) => button.addEventListener("click", async () => {
    try {
      await api(`/api/admin/devices/${encodeURIComponent(button.dataset.deviceId)}`, { method: "PUT", body: { status: button.dataset.deviceStatus } });
      inform(`Device ${button.dataset.deviceStatus}.`);
      await renderDevices();
    } catch (error) { inform(error.message, true); }
  }));

  content.querySelectorAll("[data-entitlement]").forEach((button) => button.addEventListener("click", async () => {
    if (!activeCerts.length) {
      return inform("Please upload an active Signing Certificate first under Certificates tab.", true);
    }
    const certOptions = activeCerts.map((c, i) => `${i + 1}: ${c.name}`).join("\n");
    const choice = prompt(`Select Certificate number to assign:\n${certOptions}\n(Enter number 1-${activeCerts.length}):`, "1");
    if (choice === null) return;
    const certIndex = parseInt(choice, 10) - 1;
    if (isNaN(certIndex) || certIndex < 0 || certIndex >= activeCerts.length) {
      return inform("Invalid certificate selection.", true);
    }
    const selectedCert = activeCerts[certIndex];
    const date = prompt("Optional entitlement expiry (ISO date YYYY-MM-DD), or leave blank for no expiry:", "");
    if (date === null) return;

    try {
      await api(`/api/admin/devices/${encodeURIComponent(button.dataset.entitlement)}/entitlement`, {
        method: "PUT",
        body: { status: "active", expires_at: date || null, certificate_id: selectedCert.id }
      });
      inform(`Signing access enabled with certificate: ${selectedCert.name}`);
      await renderDevices();
    } catch (error) { inform(error.message, true); }
  }));
}

async function renderCertificates() {
  const result = await api("/api/admin/certificates");
  content.innerHTML = `${pageTitle("Signing Certificates", "Upload Apple distribution certificates (.p12) and provisioning profiles. Encrypted at rest.")}
    <section class="panel"><h3>Upload signing certificate</h3><form id="certForm" class="stack-form">
      <div class="split">
        <label>Certificate name<input name="name" placeholder="e.g. Developer Enterprise 2026" required></label>
        <label>P12 Password<input name="password" type="password" placeholder="Leave blank if none"></label>
      </div>
      <div class="split">
        <label>PKCS#12 (.p12) file<input name="p12" type="file" accept=".p12,.pfx" required></label>
        <label>Provisioning Profile (.mobileprovision)<input name="provision" type="file" accept=".mobileprovision" required></label>
      </div>
      <label>Expiration date (optional)<input name="expiration_date" type="date"></label>
      <button class="primary" type="submit">Upload and Encrypt Certificate</button>
    </form><p class="muted">Certificates and private keys are encrypted on the server with AES-256-GCM and delivered only to authorized devices.</p></section>
    <section class="panel"><h3>Available certificates (${result.certificates.length})</h3>
      ${result.certificates.length ? `<div class="table-wrap"><table><thead><tr><th>Name</th><th>Status</th><th>Expires</th><th>Created</th><th>Actions</th></tr></thead><tbody>${result.certificates.map((cert) => `<tr>
        <td><strong>${escapeHTML(cert.name)}</strong></td>
        <td><span class="badge ${escapeHTML(cert.status)}">${escapeHTML(cert.status)}</span></td>
        <td>${escapeHTML(cert.expiration_date || "—")}</td>
        <td>${escapeHTML(new Date(cert.created_at).toLocaleDateString())}</td>
        <td><div class="row-actions">
          ${cert.status === "active" ? `<button class="danger" data-cert-toggle="revoked" data-cert-id="${escapeHTML(cert.id)}">Revoke</button>` : `<button class="quiet" data-cert-toggle="active" data-cert-id="${escapeHTML(cert.id)}">Activate</button>`}
          <button class="danger" data-cert-delete="${escapeHTML(cert.id)}">Delete</button>
        </div></td>
      </tr>`).join("")}</tbody></table></div>` : empty("No certificates uploaded yet", "Upload a .p12 and .mobileprovision to allow devices to sign IPAs.")}
    </section>`;

  document.getElementById("certForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const p12File = form.get("p12");
    const provFile = form.get("provision");
    if (!p12File || !provFile || !p12File.size || !provFile.size) {
      return inform("Please select both .p12 and .mobileprovision files.", true);
    }

    const readBase64 = (file) => new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result.split(",")[1]);
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });

    try {
      const [p12Base64, provBase64] = await Promise.all([readBase64(p12File), readBase64(provFile)]);
      await api("/api/admin/certificates", {
        method: "POST",
        body: {
          name: form.get("name"),
          password: form.get("password") || "",
          p12_base64: p12Base64,
          provision_base64: provBase64,
          expiration_date: form.get("expiration_date") || null
        }
      });
      inform("Certificate uploaded and encrypted securely.");
      await renderCertificates();
    } catch (error) { inform(error.message, true); }
  });

  content.querySelectorAll("[data-cert-toggle]").forEach((btn) => btn.addEventListener("click", async () => {
    try {
      await api(`/api/admin/certificates/${encodeURIComponent(btn.dataset.certId)}`, {
        method: "PUT",
        body: { status: btn.dataset.certToggle }
      });
      inform("Certificate status updated.");
      await renderCertificates();
    } catch (error) { inform(error.message, true); }
  }));

  content.querySelectorAll("[data-cert-delete]").forEach((btn) => btn.addEventListener("click", async () => {
    if (!confirm("Are you sure you want to delete this certificate?")) return;
    try {
      await api(`/api/admin/certificates/${encodeURIComponent(btn.dataset.certDelete)}`, { method: "DELETE" });
      inform("Certificate deleted.");
      await renderCertificates();
    } catch (error) { inform(error.message, true); }
  }));
}

async function renderUpdates() {
  const result = await api("/api/admin/store-update");
  const update = result.update;
  content.innerHTML = `${pageTitle("Fplus / KSign update", "Publish update metadata and a downloadable package with its SHA-256 digest.")}
    <section class="panel"><form id="updateForm" class="stack-form">
      <label>Latest version<input name="latest_version" value="${escapeHTML(update?.latest_version || "")}" placeholder="1.0.0" required></label>
      <label>Minimum version<input name="minimum_version" value="${escapeHTML(update?.minimum_version || "")}" placeholder="1.0.0" required></label>
      <label class="check-label full"><input name="mandatory" type="checkbox" ${update?.mandatory ? "checked" : ""}> Mandatory update</label>
      <label class="full">What's New · one item per line<textarea name="release_notes">${escapeHTML((update?.release_notes || []).join("\n"))}</textarea></label>
      <div class="full"><button class="primary" type="submit">Save update metadata</button></div>
    </form></section>
    <section class="panel"><h3>Update package</h3><p class="muted">${update?.has_download ? `Package uploaded · SHA-256 ${escapeHTML(update.sha256)}` : "No update package uploaded. Save metadata first."}</p>
      <form id="updateUploadForm" class="inline-form"><label>IPA file<input name="ipa" class="file-control" type="file" accept=".ipa,application/octet-stream" required></label>
      <button class="secondary" type="submit" ${update ? "" : "disabled"}>Upload package</button></form>
      <p class="muted">On iOS, updates must be installed through the supported app distribution channel; this endpoint only exposes version information and the file.</p></section>`;
  document.getElementById("updateForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    try {
      await api("/api/admin/store-update", { method: "PUT", body: {
        latest_version: form.get("latest_version"), minimum_version: form.get("minimum_version"),
        mandatory: form.has("mandatory"), release_notes: form.get("release_notes").split(/\r?\n/u).map((line) => line.trim()).filter(Boolean)
      } });
      inform("Update metadata saved.");
      await renderUpdates();
    } catch (error) { inform(error.message, true); }
  });
  document.getElementById("updateUploadForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const file = new FormData(event.currentTarget).get("ipa");
    try {
      await api("/api/admin/store-update/ipa", { method: "PUT", headers: { "Content-Type": "application/octet-stream" }, body: file });
      inform("Update package uploaded and checksum recorded.");
      await renderUpdates();
    } catch (error) { inform(error.message, true); }
  });
}

async function renderLogs() {
  const result = await api("/api/admin/logs?limit=200");
  content.innerHTML = `${pageTitle("Audit logs", "Security-relevant actions only. Passwords, tokens, and signing material are not logged.")}
    <section class="panel">${result.logs.length ? `<div class="table-wrap"><table><thead><tr><th>Time</th><th>Actor</th><th>Action</th><th>Subject</th></tr></thead><tbody>${result.logs.map((log) => `<tr><td>${escapeHTML(new Date(log.created_at).toLocaleString())}</td><td>${escapeHTML(log.actor || "System")}</td><td>${escapeHTML(log.action)}</td><td>${escapeHTML(log.subject_id || "—")}</td></tr>`).join("")}</tbody></table></div>` : empty("No audit events yet")}</section>`;
}

function renderSettings() {
  content.innerHTML = `${pageTitle("Server settings", "Sensitive configuration stays in the server environment, never in this dashboard.")}
    <div class="split">
      <section class="panel"><h3>Local services</h3><p class="muted">REST API, SQLite database, app files, icons, and signing storage are configured through the server's .env file.</p><p class="muted">Keep .env and storage/ outside source control. Back up the database and files securely.</p></section>
      <section class="panel"><h3>Signing packages</h3><p class="muted">Package delivery is deliberately disabled until device-bound encryption, revocation checks, and a reviewed key-management workflow are implemented.</p></section>
    </div>`;
}

document.getElementById("loginForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = new FormData(event.currentTarget);
  const error = document.getElementById("loginError");
  error.textContent = "";
  try {
    const result = await api("/api/auth/login", { method: "POST", body: { username: form.get("username"), password: form.get("password") } });
    setAuthenticated(result.user);
  } catch (reason) { error.textContent = reason.message; }
});
document.getElementById("logoutButton").addEventListener("click", async () => {
  try { await api("/api/auth/logout", { method: "POST" }); }
  catch (error) { inform(error.message, true); }
  setAuthenticated(null);
});
document.getElementById("navigation").addEventListener("click", (event) => {
  const button = event.target.closest("[data-page]");
  if (button) navigate(button.dataset.page);
});
document.querySelector(".brand").addEventListener("click", (event) => {
  event.preventDefault();
  navigate("dashboard");
});
document.getElementById("menuButton").addEventListener("click", () => document.getElementById("sidebar").classList.toggle("open"));
checkSession();
