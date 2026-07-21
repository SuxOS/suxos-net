// Rendering layer for the operator-only /admin/* JSON APIs (#18/#19/#20/#81) — a
// static HTML/CSS/JS shell, same dependency-free pattern as src/frontend/demoFrontend.ts
// (no build step, no framework), just pointed at /admin/* instead of /demo/*.
//
// The operator bearer token is entered once client-side and kept in sessionStorage
// (cleared when the tab closes), then sent as `Authorization: Bearer <token>` on every
// call — this page itself carries no server-side session and is not a login form; the
// token gate every /admin/* handler already enforces (assertOperator) is the only
// actual authorization boundary. Script and style are served from their own routes so
// the page runs under the same strict same-origin CSP as /demo.

export const ADMIN_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>suxos.net — operator admin console</title>
<link rel="stylesheet" href="/admin/console.css">
</head>
<body>
<header class="site-header">
  <h1>Operator admin console</h1>
  <p class="notice">Operator-only. Every action below calls the real /admin/* API with your bearer token.</p>
</header>

<section id="gate" class="gate">
  <label for="token-input">Operator bearer token</label>
  <input id="token-input" type="password" autocomplete="off" placeholder="paste OPERATOR_TOKEN">
  <button id="connect-button" type="button">Connect</button>
  <p id="gate-error" class="error" hidden></p>
</section>

<div id="console" hidden>
  <nav class="tabs" role="tablist">
    <button id="tab-accounts" class="tab" role="tab" type="button" aria-selected="true">Accounts</button>
    <button id="tab-references" class="tab" role="tab" type="button" aria-selected="false">References</button>
    <button id="tab-audit" class="tab" role="tab" type="button" aria-selected="false">Audit log</button>
    <button id="disconnect-button" class="tab disconnect" type="button">Disconnect</button>
  </nav>

  <main>
    <section id="panel-accounts" class="panel">
      <form id="create-account-form" class="admin-form">
        <h2>Create account</h2>
        <label for="create-username">Username</label>
        <input id="create-username" type="text" autocomplete="off" required>
        <label for="create-password">Password</label>
        <input id="create-password" type="password" autocomplete="off" required>
        <button type="submit">Create</button>
      </form>

      <form id="reset-password-form" class="admin-form">
        <h2>Reset password</h2>
        <label for="reset-username">Username</label>
        <input id="reset-username" type="text" autocomplete="off" required>
        <label for="reset-password">New password</label>
        <input id="reset-password" type="password" autocomplete="off" required>
        <button type="submit">Reset</button>
      </form>

      <form id="revoke-sessions-form" class="admin-form">
        <h2>Revoke sessions</h2>
        <label for="revoke-username">Username</label>
        <input id="revoke-username" type="text" autocomplete="off" required>
        <button type="submit">Revoke</button>
      </form>

      <div id="accounts-result" class="result" aria-live="polite"></div>
    </section>

    <section id="panel-references" class="panel" hidden>
      <form id="create-reference-form" class="admin-form">
        <h2>Curate a reference</h2>
        <label for="ref-id">Id</label>
        <input id="ref-id" type="text" autocomplete="off" required>
        <label for="ref-text">Text</label>
        <textarea id="ref-text" required></textarea>
        <label for="ref-source">Source</label>
        <input id="ref-source" type="text" autocomplete="off" required>
        <label for="ref-source-url">Source URL (optional)</label>
        <input id="ref-source-url" type="text" autocomplete="off">
        <label for="ref-curator">Curator</label>
        <input id="ref-curator" type="text" autocomplete="off" required>
        <label for="ref-scope">Scope of applicability</label>
        <input id="ref-scope" type="text" autocomplete="off" required>
        <button type="submit">Add reference</button>
      </form>

      <div id="references-result" class="result" aria-live="polite"></div>
      <div id="references-table" class="table" aria-live="polite"></div>
      <button id="references-load-more" type="button" hidden>Load more</button>
    </section>

    <section id="panel-audit" class="panel" hidden>
      <div id="audit-table" class="table" aria-live="polite"></div>
      <button id="audit-load-more" type="button" hidden>Load more</button>
    </section>
  </main>
</div>

<script src="/admin/console.js"></script>
</body>
</html>
`;

export const ADMIN_CSS = `:root {
  color-scheme: light;
  --ink: #1b1f24;
  --muted: #5b6470;
  --bg: #ffffff;
  --panel-bg: #f6f7f9;
  --border: #d8dce1;
  --caution: #926c00;
  --caution-bg: #fdf3d8;
  --support: #146c43;
  --support-bg: #e6f4ea;
  --accent: #2c5eea;
}

* { box-sizing: border-box; }

body {
  margin: 0;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  color: var(--ink);
  background: var(--bg);
  line-height: 1.45;
}

.site-header { padding: 1rem 1.25rem 0.5rem; border-bottom: 1px solid var(--border); }
.site-header h1 { margin: 0 0 0.35rem; font-size: 1.35rem; }

.notice {
  margin: 0 0 0.5rem;
  font-size: 0.85rem;
  color: var(--muted);
}

.gate {
  max-width: 420px;
  margin: 2rem auto;
  padding: 0 1.25rem;
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}

.gate label { font-size: 0.85rem; color: var(--muted); }

.tabs { display: flex; gap: 0.25rem; padding: 0.5rem 1.25rem 0; border-bottom: 1px solid var(--border); overflow-x: auto; align-items: center; }

.tab {
  background: none;
  border: none;
  padding: 0.6rem 0.9rem;
  font-size: 0.95rem;
  cursor: pointer;
  color: var(--muted);
  border-bottom: 2px solid transparent;
  white-space: nowrap;
}

.tab[aria-selected="true"] { color: var(--accent); border-bottom-color: var(--accent); font-weight: 600; }
.disconnect { margin-left: auto; color: var(--caution); }

main { padding: 1rem 1.25rem 2rem; max-width: 820px; margin: 0 auto; }

.panel[hidden] { display: none; }

.admin-form {
  border: 1px solid var(--border);
  border-radius: 0.5rem;
  padding: 0.9rem 1rem;
  margin-bottom: 1rem;
  background: var(--panel-bg);
  display: flex;
  flex-direction: column;
  gap: 0.4rem;
  max-width: 480px;
}

.admin-form h2 { margin: 0 0 0.25rem; font-size: 1rem; }
.admin-form label { font-size: 0.85rem; color: var(--muted); }

input[type="text"], input[type="password"], textarea {
  font-size: 0.95rem;
  padding: 0.4rem 0.5rem;
  border: 1px solid var(--border);
  border-radius: 0.35rem;
  background: var(--bg);
  color: var(--ink);
  font-family: inherit;
}

textarea { min-height: 4rem; resize: vertical; }

button {
  align-self: flex-start;
  font-size: 0.9rem;
  padding: 0.4rem 0.8rem;
  border: 1px solid var(--accent);
  border-radius: 0.35rem;
  background: var(--accent);
  color: #fff;
  cursor: pointer;
}

button.secondary { background: var(--bg); color: var(--accent); }

.result { margin-bottom: 1rem; font-size: 0.9rem; }
.result .ok { color: var(--support); font-weight: 600; }
.result .error, .error { color: var(--caution); font-weight: 600; }

table { border-collapse: collapse; width: 100%; margin-bottom: 0.75rem; font-size: 0.85rem; }
th, td { border: 1px solid var(--border); padding: 0.4rem 0.5rem; text-align: left; vertical-align: top; }
th { background: var(--panel-bg); }

.empty, .loading { color: var(--muted); font-style: italic; }

@media (max-width: 480px) {
  main { padding: 0.75rem; }
}
`;

export const ADMIN_JS = `(function () {
  "use strict";

  var TOKEN_KEY = "suxos-admin-token";
  var referencesCursor = null;
  var auditCursor = null;

  function el(tag, attrs, children) {
    var node = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (key) {
        if (key === "class") node.className = attrs[key];
        else if (key === "text") node.textContent = attrs[key];
        else node.setAttribute(key, attrs[key]);
      });
    }
    (children || []).forEach(function (child) {
      if (child) node.appendChild(child);
    });
    return node;
  }

  function clear(node) {
    while (node.firstChild) node.removeChild(node.firstChild);
  }

  function getToken() {
    return sessionStorage.getItem(TOKEN_KEY);
  }

  function setToken(token) {
    sessionStorage.setItem(TOKEN_KEY, token);
  }

  function clearToken() {
    sessionStorage.removeItem(TOKEN_KEY);
  }

  function apiFetch(path, options) {
    var opts = options || {};
    var headers = Object.assign({}, opts.headers || {}, { Authorization: "Bearer " + getToken() });
    return fetch(path, Object.assign({}, opts, { headers: headers })).then(function (res) {
      if (res.status === 401) {
        clearToken();
        showGate("Session expired or token rejected — reconnect.");
      }
      return res.json().then(function (data) {
        return { ok: res.ok, status: res.status, data: data };
      });
    });
  }

  function showResult(containerId, ok, message) {
    var container = document.getElementById(containerId);
    clear(container);
    container.appendChild(el("p", { class: ok ? "ok" : "error", text: message }));
  }

  // --- Accounts tab ---

  function bindAccountForms() {
    document.getElementById("create-account-form").addEventListener("submit", function (event) {
      event.preventDefault();
      var username = document.getElementById("create-username").value.trim();
      var password = document.getElementById("create-password").value;
      apiFetch("/admin/accounts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: username, password: password }),
      }).then(function (result) {
        showResult("accounts-result", result.ok, result.ok ? "Account created: " + result.data.username : (result.data.error || "Could not create account."));
      });
    });

    document.getElementById("reset-password-form").addEventListener("submit", function (event) {
      event.preventDefault();
      var username = document.getElementById("reset-username").value.trim();
      var password = document.getElementById("reset-password").value;
      apiFetch("/admin/accounts/reset", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: username, password: password }),
      }).then(function (result) {
        showResult("accounts-result", result.ok, result.ok ? "Password reset for " + username : (result.data.error || "Could not reset password."));
      });
    });

    document.getElementById("revoke-sessions-form").addEventListener("submit", function (event) {
      event.preventDefault();
      var username = document.getElementById("revoke-username").value.trim();
      apiFetch("/admin/accounts/revoke-sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: username }),
      }).then(function (result) {
        showResult("accounts-result", result.ok, result.ok ? "Sessions revoked for " + username : (result.data.error || "Could not revoke sessions."));
      });
    });
  }

  // --- References tab ---

  function renderReferenceRow(reference) {
    var row = el("tr");
    row.appendChild(el("td", { text: reference.id }));
    row.appendChild(el("td", { text: reference.text }));
    row.appendChild(el("td", { text: reference.source }));
    row.appendChild(el("td", { text: reference.curator }));
    row.appendChild(el("td", { text: reference.scopeOfApplicability }));

    var actions = el("td");
    var editButton = el("button", { class: "secondary", type: "button", text: "Edit text" });
    editButton.addEventListener("click", function () {
      var nextText = window.prompt("New text for " + reference.id, reference.text);
      if (nextText === null || nextText.trim().length === 0) return;
      apiFetch("/admin/references/update", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: reference.id, text: nextText }),
      }).then(function (result) {
        showResult("references-result", result.ok, result.ok ? "Updated " + reference.id : (result.data.error || "Could not update reference."));
        if (result.ok) loadReferences(true);
      });
    });
    actions.appendChild(editButton);

    var deleteButton = el("button", { class: "secondary", type: "button", text: "Delete" });
    deleteButton.addEventListener("click", function () {
      if (!window.confirm("Delete reference " + reference.id + "?")) return;
      apiFetch("/admin/references/delete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: reference.id }),
      }).then(function (result) {
        showResult("references-result", result.ok, result.ok ? "Deleted " + reference.id : (result.data.error || "Could not delete reference."));
        if (result.ok) loadReferences(true);
      });
    });
    actions.appendChild(deleteButton);
    row.appendChild(actions);
    return row;
  }

  function renderReferencesTable(references) {
    var container = document.getElementById("references-table");
    clear(container);
    if (!references || references.length === 0) {
      container.appendChild(el("p", { class: "empty", text: "No curated references yet." }));
      return;
    }
    var table = el("table");
    var head = el("tr");
    ["Id", "Text", "Source", "Curator", "Scope", ""].forEach(function (label) {
      head.appendChild(el("th", { text: label }));
    });
    table.appendChild(head);
    references.forEach(function (reference) {
      table.appendChild(renderReferenceRow(reference));
    });
    container.appendChild(table);
  }

  function loadReferences(reset) {
    if (reset) referencesCursor = null;
    var container = document.getElementById("references-table");
    clear(container);
    container.appendChild(el("p", { class: "loading", text: "Loading…" }));
    var params = referencesCursor ? "?cursor=" + encodeURIComponent(referencesCursor) : "";
    apiFetch("/admin/references" + params, { method: "GET" }).then(function (result) {
      if (!result.ok) {
        clear(container);
        container.appendChild(el("p", { class: "error", text: result.data.error || "Could not load references." }));
        return;
      }
      renderReferencesTable(result.data.references);
      referencesCursor = result.data.cursor;
      document.getElementById("references-load-more").hidden = !referencesCursor;
    });
  }

  function bindReferenceForm() {
    document.getElementById("create-reference-form").addEventListener("submit", function (event) {
      event.preventDefault();
      var sourceUrl = document.getElementById("ref-source-url").value.trim();
      var input = {
        id: document.getElementById("ref-id").value.trim(),
        text: document.getElementById("ref-text").value.trim(),
        source: document.getElementById("ref-source").value.trim(),
        curator: document.getElementById("ref-curator").value.trim(),
        scopeOfApplicability: document.getElementById("ref-scope").value.trim(),
      };
      if (sourceUrl) input.sourceUrl = sourceUrl;
      apiFetch("/admin/references", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
      }).then(function (result) {
        showResult("references-result", result.ok, result.ok ? "Added " + input.id : (result.data.error || "Could not add reference."));
        if (result.ok) {
          document.getElementById("create-reference-form").reset();
          loadReferences(true);
        }
      });
    });

    document.getElementById("references-load-more").addEventListener("click", function () {
      loadReferences(false);
    });
  }

  // --- Audit log tab ---

  function identityLabel(identity) {
    if (!identity) return "unknown";
    if (identity.kind === "operator-access-email") return identity.email;
    if (identity.kind === "recipient-username") return identity.username;
    return JSON.stringify(identity);
  }

  function renderAuditEntry(entry) {
    var row = el("tr");
    row.appendChild(el("td", { text: entry.timestamp }));
    row.appendChild(el("td", { text: identityLabel(entry.identity) }));
    row.appendChild(el("td", { text: entry.detail.kind }));
    row.appendChild(el("td", { text: JSON.stringify(entry.detail) }));
    return row;
  }

  function renderAuditTable(entries) {
    var container = document.getElementById("audit-table");
    clear(container);
    if (!entries || entries.length === 0) {
      container.appendChild(el("p", { class: "empty", text: "No audit entries yet." }));
      return;
    }
    var table = el("table");
    var head = el("tr");
    ["Timestamp", "Identity", "Kind", "Detail"].forEach(function (label) {
      head.appendChild(el("th", { text: label }));
    });
    table.appendChild(head);
    entries.forEach(function (entry) {
      table.appendChild(renderAuditEntry(entry));
    });
    container.appendChild(table);
  }

  function loadAuditLog(reset) {
    if (reset) auditCursor = null;
    var container = document.getElementById("audit-table");
    clear(container);
    container.appendChild(el("p", { class: "loading", text: "Loading…" }));
    var params = auditCursor ? "?cursor=" + encodeURIComponent(auditCursor) : "";
    apiFetch("/admin/audit-log" + params, { method: "GET" }).then(function (result) {
      if (!result.ok) {
        clear(container);
        container.appendChild(el("p", { class: "error", text: result.data.error || "Could not load the audit log." }));
        return;
      }
      renderAuditTable(result.data.entries);
      auditCursor = result.data.cursor;
      document.getElementById("audit-load-more").hidden = !auditCursor;
    });
  }

  // --- Tabs & gate ---

  var TABS = ["accounts", "references", "audit"];
  var referencesLoaded = false;
  var auditLoaded = false;

  function showTab(name) {
    TABS.forEach(function (tab) {
      document.getElementById("panel-" + tab).hidden = tab !== name;
      document.getElementById("tab-" + tab).setAttribute("aria-selected", String(tab === name));
    });
    if (name === "references" && !referencesLoaded) {
      referencesLoaded = true;
      loadReferences(true);
    }
    if (name === "audit" && !auditLoaded) {
      auditLoaded = true;
      loadAuditLog(true);
    }
  }

  function showGate(message) {
    document.getElementById("gate").hidden = false;
    document.getElementById("console").hidden = true;
    var errorEl = document.getElementById("gate-error");
    if (message) {
      errorEl.textContent = message;
      errorEl.hidden = false;
    } else {
      errorEl.hidden = true;
    }
  }

  function showConsole() {
    document.getElementById("gate").hidden = true;
    document.getElementById("console").hidden = false;
  }

  function connect(token) {
    if (!token) return;
    setToken(token);
    showConsole();
  }

  function init() {
    TABS.forEach(function (tab) {
      document.getElementById("tab-" + tab).addEventListener("click", function () {
        showTab(tab);
      });
    });

    document.getElementById("connect-button").addEventListener("click", function () {
      connect(document.getElementById("token-input").value.trim());
    });

    document.getElementById("disconnect-button").addEventListener("click", function () {
      clearToken();
      referencesLoaded = false;
      auditLoaded = false;
      showGate(null);
    });

    bindAccountForms();
    bindReferenceForm();
    document.getElementById("audit-load-more").addEventListener("click", function () {
      loadAuditLog(false);
    });

    if (getToken()) {
      showConsole();
    } else {
      showGate(null);
    }
  }

  document.addEventListener("DOMContentLoaded", init);
})();
`;
