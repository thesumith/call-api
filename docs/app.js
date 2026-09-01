const STORE_KEY = "call-api.v1";
const IS_LOCAL = ["127.0.0.1", "localhost"].includes(location.hostname);
const DEFAULT_STATE = {
  saved: [],
  history: [],
  env: {
    id: "local",
    name: IS_LOCAL ? "Local" : "Public",
    vars: [
      {
        enabled: true,
        key: "baseUrl",
        value: IS_LOCAL ? "http://127.0.0.1:4040" : "https://httpbin.org",
      },
    ],
  },
  current: null,
};

const $ = (id) => document.getElementById(id);
const methodEl = $("method");
const urlEl = $("url");
const bodyEl = $("body");
const bodyTypeEl = $("body-type");
const authTypeEl = $("auth-type");
const sendBtn = $("btn-send");
const cancelBtn = $("btn-cancel");

let state = loadState();
let activeId = null;
let inflight = null;
let syncingUrl = false;

function loadState() {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (!raw) return structuredClone(DEFAULT_STATE);
    return { ...structuredClone(DEFAULT_STATE), ...JSON.parse(raw) };
  } catch {
    return structuredClone(DEFAULT_STATE);
  }
}

function persist() {
  localStorage.setItem(STORE_KEY, JSON.stringify(state));
}

function uid() {
  return crypto.randomUUID ? crypto.randomUUID() : String(Date.now() + Math.random());
}

function methodClass(method) {
  return String(method || "GET").toLowerCase();
}

function emptyRows() {
  return [
    { enabled: true, key: "", value: "" },
    { enabled: true, key: "", value: "" },
  ];
}

function blankRequest() {
  return {
    id: uid(),
    name: "Untitled",
    method: "GET",
    url: IS_LOCAL ? "{{baseUrl}}/__echo" : "https://httpbin.org/get",
    params: emptyRows(),
    headers: [
      { enabled: true, key: "Accept", value: "application/json" },
      { enabled: true, key: "", value: "" },
    ],
    bodyType: "none",
    body: "",
    auth: {
      type: "none",
      token: "",
      user: "",
      pass: "",
      keyName: "X-API-Key",
      keyValue: "",
      keyIn: "header",
    },
  };
}

let draft = state.current || blankRequest();

function kvRoot(kind) {
  return document.querySelector(`[data-kv="${kind}"]`);
}

function readKv(kind) {
  return [...kvRoot(kind).querySelectorAll(".kv-row")].map((row) => ({
    enabled: row.querySelector('input[type="checkbox"]').checked,
    key: row.querySelector(".k").value,
    value: row.querySelector(".v").value,
  }));
}

function renderKv(kind, rows) {
  const root = kvRoot(kind);
  root.replaceChildren();
  const list = rows?.length ? rows : emptyRows();
  if (list.every((r) => r.key || r.value)) list.push({ enabled: true, key: "", value: "" });
  for (const row of list) root.append(kvRow(kind, row));
}

function kvRow(kind, row) {
  const wrap = document.createElement("div");
  wrap.className = "kv-row";
  wrap.innerHTML = `
    <input type="checkbox" ${row.enabled !== false ? "checked" : ""} aria-label="Enabled" />
    <input class="k" spellcheck="false" placeholder="Key" />
    <input class="v" spellcheck="false" placeholder="Value" />
    <button type="button" class="gone" aria-label="Remove">×</button>
  `;
  wrap.querySelector(".k").value = row.key || "";
  wrap.querySelector(".v").value = row.value || "";
  wrap.querySelector(".gone").addEventListener("click", () => {
    wrap.remove();
    if (!kvRoot(kind).children.length) renderKv(kind, emptyRows());
    if (kind === "params") paramsToUrl();
  });
  wrap.querySelector(".k").addEventListener("input", () => {
    maybeAppendRow(kind);
    if (kind === "params") paramsToUrl();
  });
  wrap.querySelector(".v").addEventListener("input", () => {
    maybeAppendRow(kind);
    if (kind === "params") paramsToUrl();
  });
  wrap.querySelector('input[type="checkbox"]').addEventListener("change", () => {
    if (kind === "params") paramsToUrl();
  });
  return wrap;
}

function maybeAppendRow(kind) {
  const rows = [...kvRoot(kind).querySelectorAll(".kv-row")];
  const last = rows.at(-1);
  if (!last) return;
  const filled = last.querySelector(".k").value || last.querySelector(".v").value;
  if (filled) kvRoot(kind).append(kvRow(kind, { enabled: true, key: "", value: "" }));
}

function applyDraft(req) {
  draft = structuredClone(req);
  methodEl.value = req.method || "GET";
  urlEl.value = req.url || "";
  bodyTypeEl.value = req.bodyType || "none";
  bodyEl.value = req.body || "";
  authTypeEl.value = req.auth?.type || "none";
  $("auth-token").value = req.auth?.token || "";
  $("auth-user").value = req.auth?.user || "";
  $("auth-pass").value = req.auth?.pass || "";
  $("auth-key-name").value = req.auth?.keyName || "X-API-Key";
  $("auth-key-value").value = req.auth?.keyValue || "";
  $("auth-key-in").value = req.auth?.keyIn || "header";
  renderKv("params", req.params);
  renderKv("headers", req.headers);
  toggleAuth();
  toggleBody();
  paintLists();
}

function captureDraft() {
  draft = {
    ...draft,
    method: methodEl.value,
    url: urlEl.value.trim(),
    params: readKv("params"),
    headers: readKv("headers"),
    bodyType: bodyTypeEl.value,
    body: bodyEl.value,
    auth: {
      type: authTypeEl.value,
      token: $("auth-token").value,
      user: $("auth-user").value,
      pass: $("auth-pass").value,
      keyName: $("auth-key-name").value,
      keyValue: $("auth-key-value").value,
      keyIn: $("auth-key-in").value,
    },
  };
  state.current = draft;
  persist();
  return draft;
}

function vars() {
  return (state.env.vars || []).filter((v) => v.enabled && v.key);
}

function interpolate(value) {
  if (value == null) return "";
  return String(value).replace(/\{\{\s*([^}]+?)\s*\}\}/g, (_, name) => {
    const found = vars().find((v) => v.key === name.trim());
    return found ? found.value : `{{${name}}}`;
  });
}

function activePairs(rows) {
  return (rows || []).filter((r) => r.enabled !== false && r.key);
}

function splitUrl(raw) {
  const trimmed = raw.trim();
  const q = trimmed.indexOf("?");
  if (q === -1) return { base: trimmed, search: "" };
  return { base: trimmed.slice(0, q), search: trimmed.slice(q + 1) };
}

function urlToParams() {
  if (syncingUrl) return;
  const { search } = splitUrl(urlEl.value);
  const params = [];
  if (search) {
    for (const part of search.split("&")) {
      if (!part) continue;
      const eq = part.indexOf("=");
      const key = decodeURIComponent(eq === -1 ? part : part.slice(0, eq));
      const value = decodeURIComponent(eq === -1 ? "" : part.slice(eq + 1));
      params.push({ enabled: true, key, value });
    }
  }
  syncingUrl = true;
  renderKv("params", params.length ? params : emptyRows());
  syncingUrl = false;
}

function paramsToUrl() {
  if (syncingUrl) return;
  const { base } = splitUrl(urlEl.value);
  const q = activePairs(readKv("params"))
    .map((p) => `${encodeURIComponent(p.key)}=${encodeURIComponent(p.value)}`)
    .join("&");
  syncingUrl = true;
  urlEl.value = q ? `${base}?${q}` : base;
  syncingUrl = false;
}

function buildHeaders(req) {
  const headers = {};
  for (const h of activePairs(req.headers)) headers[h.key] = interpolate(h.value);
  const auth = req.auth || { type: "none" };
  if (auth.type === "bearer" && auth.token) {
    headers.Authorization = `Bearer ${interpolate(auth.token)}`;
  }
  if (auth.type === "basic" && (auth.user || auth.pass)) {
    headers.Authorization = `Basic ${btoa(`${interpolate(auth.user)}:${interpolate(auth.pass)}`)}`;
  }
  if (auth.type === "apikey" && auth.keyName && auth.keyIn === "header") {
    headers[auth.keyName] = interpolate(auth.keyValue);
  }
  if (req.bodyType === "json" && req.body && !headerHas(headers, "content-type")) {
    headers["Content-Type"] = "application/json";
  }
  if (req.bodyType === "text" && req.body && !headerHas(headers, "content-type")) {
    headers["Content-Type"] = "text/plain";
  }
  if (req.bodyType === "form" && !headerHas(headers, "content-type")) {
    headers["Content-Type"] = "application/x-www-form-urlencoded";
  }
  return headers;
}

function headerHas(headers, name) {
  return Object.keys(headers).some((k) => k.toLowerCase() === name.toLowerCase());
}

function buildUrl(req) {
  let url = interpolate(req.url.trim());
  if (req.auth?.type === "apikey" && req.auth.keyIn === "query" && req.auth.keyName) {
    const joiner = url.includes("?") ? "&" : "?";
    url += `${joiner}${encodeURIComponent(req.auth.keyName)}=${encodeURIComponent(interpolate(req.auth.keyValue))}`;
  }
  return url;
}

function buildBody(req) {
  if (req.bodyType === "none" || ["GET", "HEAD"].includes(req.method)) return undefined;
  if (req.bodyType === "form") {
    return interpolate(req.body)
      .split("&")
      .filter(Boolean)
      .join("&");
  }
  return interpolate(req.body);
}

function toCurl(req) {
  const url = buildUrl(req);
  const headers = buildHeaders(req);
  const body = buildBody(req);
  const parts = ["curl", "-X", req.method, `'${url.replace(/'/g, `'\\''`)}'`];
  for (const [k, v] of Object.entries(headers)) {
    parts.push("-H", `'${k}: ${String(v).replace(/'/g, `'\\''`)}'`);
  }
  if (body) parts.push("--data-raw", `'${body.replace(/'/g, `'\\''`)}'`);
  return parts.join(" ");
}

function toggleAuth() {
  for (const id of ["auth-bearer", "auth-basic", "auth-apikey"]) {
    $(id).classList.toggle("show", id === `auth-${authTypeEl.value}`);
  }
}

function toggleBody() {
  const off = bodyTypeEl.value === "none";
  bodyEl.disabled = off;
  $("btn-pretty").hidden = bodyTypeEl.value !== "json";
}

function setTab(name) {
  document.querySelectorAll(".request-pane .tab").forEach((t) => {
    t.classList.toggle("active", t.dataset.tab === name);
  });
  document.querySelectorAll(".request-pane .panel").forEach((p) => {
    p.classList.toggle("active", p.id === `panel-${name}`);
  });
}

function setResponseTab(name) {
  document.querySelectorAll("[data-rtab]").forEach((t) => {
    t.classList.toggle("active", t.dataset.rtab === name);
  });
  $("response-pretty").classList.toggle("active", name === "pretty");
  $("response-raw").classList.toggle("active", name === "raw");
  $("response-headers").classList.toggle("active", name === "headers");
}

function formatBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function statusClass(code) {
  if (code >= 200 && code < 300) return "ok";
  if (code >= 300 && code < 400) return "warn";
  return "err";
}

function highlightJson(text, root) {
  root.replaceChildren();
  const re = /("(?:\\u[\da-fA-F]{4}|\\[^u]|[^\\"])*"(\s*:)?|\btrue\b|\bfalse\b|\bnull\b|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/g;
  let last = 0;
  let match;
  while ((match = re.exec(text))) {
    if (match.index > last) root.append(text.slice(last, match.index));
    const span = document.createElement("span");
    const token = match[0];
    if (token[0] === '"') span.className = match[2] ? "tok-key" : "tok-str";
    else if (token === "true" || token === "false" || token === "null") span.className = "tok-lit";
    else span.className = "tok-num";
    span.textContent = token;
    root.append(span);
    last = match.index + token.length;
  }
  if (last < text.length) root.append(text.slice(last));
}

function showResponse(result, errorText) {
  $("response-placeholder").classList.toggle("hidden", Boolean(result || errorText));
  const statusEl = $("response-status");
  const timeEl = $("response-time");
  const sizeEl = $("response-size");
  const urlOut = $("response-url");

  if (errorText) {
    statusEl.className = "status-pill err";
    statusEl.textContent = "Failed";
    statusEl.classList.remove("hidden");
    timeEl.classList.add("hidden");
    sizeEl.classList.add("hidden");
    urlOut.classList.add("hidden");
    $("response-pretty").textContent = errorText;
    $("response-raw").textContent = errorText;
    $("response-headers").textContent = "";
    setResponseTab("pretty");
    return;
  }

  statusEl.className = `status-pill ${statusClass(result.status)}`;
  statusEl.textContent = `${result.status} ${result.statusText || ""}`.trim();
  statusEl.classList.remove("hidden");
  timeEl.textContent = `${result.timeMs} ms`;
  timeEl.classList.remove("hidden");
  sizeEl.textContent = formatBytes(result.size || 0);
  sizeEl.classList.remove("hidden");
  if (result.url) {
    urlOut.textContent = result.url;
    urlOut.classList.remove("hidden");
  } else {
    urlOut.classList.add("hidden");
  }

  const raw = result.body ?? "";
  $("response-raw").textContent = raw;
  $("response-headers").textContent = (result.headers || [])
    .map(([k, v]) => `${k}: ${v}`)
    .join("\n");

  const pretty = $("response-pretty");
  try {
    const parsed = JSON.parse(raw);
    highlightJson(JSON.stringify(parsed, null, 2), pretty);
  } catch {
    pretty.textContent = raw || "(empty)";
  }
}

function listItem(entry, group) {
  const li = document.createElement("li");
  if (entry.id === activeId && group === "saved") li.classList.add("active");
  li.innerHTML = `
    <span class="method ${methodClass(entry.method)}">${entry.method}</span>
    <span class="name"></span>
    <button type="button" class="remove" aria-label="Remove">×</button>
  `;
  li.querySelector(".name").textContent = entry.name || entry.url || "Untitled";
  li.addEventListener("click", (e) => {
    if (e.target.closest(".remove")) return;
    activeId = group === "saved" ? entry.id : null;
    applyDraft(entry);
  });
  li.querySelector(".remove").addEventListener("click", (e) => {
    e.stopPropagation();
    if (group === "saved") state.saved = state.saved.filter((s) => s.id !== entry.id);
    else state.history = state.history.filter((s) => s.id !== entry.id);
    persist();
    paintLists();
  });
  return li;
}

function paintLists() {
  const q = $("search").value.trim().toLowerCase();
  const match = (item) =>
    !q ||
    `${item.name} ${item.method} ${item.url}`.toLowerCase().includes(q);

  const saved = $("saved-list");
  saved.replaceChildren();
  const savedItems = state.saved.filter(match);
  if (!savedItems.length) {
    const empty = document.createElement("li");
    empty.className = "empty";
    empty.textContent = q ? "No matches" : "Nothing saved yet";
    saved.append(empty);
  } else {
    savedItems.forEach((item) => saved.append(listItem(item, "saved")));
  }

  const history = $("history-list");
  history.replaceChildren();
  const histItems = state.history.filter(match);
  if (!histItems.length) {
    const empty = document.createElement("li");
    empty.className = "empty";
    empty.textContent = q ? "No matches" : "No requests yet";
    history.append(empty);
  } else {
    histItems.forEach((item) => history.append(listItem(item, "history")));
  }
}

function pushHistory(req, result) {
  const entry = {
    ...structuredClone(req),
    id: uid(),
    name: `${req.method} ${req.url}`,
    lastStatus: result?.status,
    at: Date.now(),
  };
  state.history = [entry, ...state.history].slice(0, 50);
  persist();
  paintLists();
}

async function sendViaProxy(req, signal) {
  const res = await fetch("/api/send", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      method: req.method,
      url: buildUrl(req),
      headers: buildHeaders(req),
      body: buildBody(req) ?? "",
      timeout: 30000,
    }),
    signal,
  });
  return res.json();
}

async function sendDirect(req, signal) {
  const started = Date.now();
  const method = req.method;
  const headers = buildHeaders(req);
  const body = buildBody(req);
  const init = { method, headers, signal, redirect: "follow" };
  if (body !== undefined) init.body = body;
  try {
    const response = await fetch(buildUrl(req), init);
    const buffer = await response.arrayBuffer();
    const contentType = response.headers.get("content-type") || "";
    const isBinary =
      /^(image|audio|video|font)\//i.test(contentType) ||
      /octet-stream|zip|pdf|wasm/i.test(contentType);
    const responseHeaders = [];
    response.headers.forEach((value, key) => responseHeaders.push([key, value]));
    return {
      ok: true,
      status: response.status,
      statusText: response.statusText,
      url: response.url,
      redirected: response.redirected,
      headers: responseHeaders,
      timeMs: Date.now() - started,
      size: buffer.byteLength,
      binary: isBinary,
      body: isBinary
        ? `[binary ${contentType || "response"} — ${buffer.byteLength} bytes]`
        : new TextDecoder().decode(buffer),
    };
  } catch (err) {
    const blocked = /Failed to fetch|NetworkError|Load failed/i.test(err.message || "");
    return {
      ok: false,
      error: blocked
        ? "Browser CORS blocked this request. APIs without Access-Control-Allow-Origin need the local proxy (npm start)."
        : err.message || String(err),
      timeMs: Date.now() - started,
    };
  }
}

async function send() {
  const req = captureDraft();
  if (!req.url) {
    urlEl.focus();
    return;
  }

  inflight?.abort();
  const controller = new AbortController();
  inflight = controller;
  sendBtn.disabled = true;
  cancelBtn.classList.remove("hidden");
  $("response-placeholder").textContent = "Sending…";
  $("response-placeholder").classList.remove("hidden");

  try {
    const data = IS_LOCAL
      ? await sendViaProxy(req, controller.signal)
      : await sendDirect(req, controller.signal);
    if (!data.ok) showResponse(null, data.error || "Request failed");
    else showResponse(data);
    pushHistory(req, data);
  } catch (err) {
    if (err.name !== "AbortError") showResponse(null, err.message);
  } finally {
    if (inflight === controller) inflight = null;
    sendBtn.disabled = false;
    cancelBtn.classList.add("hidden");
  }
}

function flattenPostman(items, acc = []) {
  for (const item of items || []) {
    if (item.item) flattenPostman(item.item, acc);
    else if (item.request) acc.push(item);
  }
  return acc;
}

function fromPostmanUrl(url) {
  if (!url) return "";
  if (typeof url === "string") return url;
  if (url.raw) return url.raw;
  const host = [].concat(url.host || []).join(".");
  const path = [].concat(url.path || []).join("/");
  const proto = url.protocol ? `${url.protocol}://` : "https://";
  return `${proto}${host}/${path}`.replace(/([^:]\/)\/+/g, "$1");
}

function importPayload(data) {
  if (Array.isArray(data.saved) || Array.isArray(data.history)) {
    if (data.saved) state.saved = [...data.saved, ...state.saved];
    if (data.env) state.env = data.env;
    persist();
    paintLists();
    return `${data.saved?.length || 0} saved requests`;
  }
  if (data.info && data.item) {
    const imported = flattenPostman(data.item).map((item) => {
      const r = item.request || {};
      const headers = (r.header || []).map((h) => ({
        enabled: !h.disabled,
        key: h.key || "",
        value: h.value || "",
      }));
      let bodyType = "none";
      let body = "";
      if (r.body?.mode === "raw") {
        body = r.body.raw || "";
        bodyType = /json/i.test(r.body.options?.raw?.language || "") || looksLikeJson(body)
          ? "json"
          : "text";
      } else if (r.body?.mode === "urlencoded") {
        bodyType = "form";
        body = (r.body.urlencoded || [])
          .filter((p) => !p.disabled)
          .map((p) => `${p.key}=${p.value}`)
          .join("&");
      }
      return {
        ...blankRequest(),
        name: item.name || "Imported",
        method: (r.method || "GET").toUpperCase(),
        url: fromPostmanUrl(r.url),
        headers: headers.length ? headers : blankRequest().headers,
        bodyType,
        body,
      };
    });
    state.saved = [...imported, ...state.saved];
    persist();
    paintLists();
    return `${imported.length} Postman requests`;
  }
  throw new Error("Unrecognized file");
}

function looksLikeJson(text) {
  const t = text.trim();
  return t.startsWith("{") || t.startsWith("[");
}

function exportState() {
  const blob = new Blob(
    [JSON.stringify({ saved: state.saved, env: state.env, exportedAt: new Date().toISOString() }, null, 2)],
    { type: "application/json" }
  );
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "Call API-collection.json";
  a.click();
  URL.revokeObjectURL(a.href);
}

function paintEnv() {
  $("env-select").replaceChildren();
  const opt = document.createElement("option");
  opt.value = state.env.id;
  opt.textContent = state.env.name;
  $("env-select").append(opt);
  renderKv("env", state.env.vars);
}

document.querySelectorAll(".request-pane .tab").forEach((tab) => {
  tab.addEventListener("click", () => setTab(tab.dataset.tab));
});
document.querySelectorAll("[data-rtab]").forEach((tab) => {
  tab.addEventListener("click", () => setResponseTab(tab.dataset.rtab));
});

authTypeEl.addEventListener("change", toggleAuth);
bodyTypeEl.addEventListener("change", toggleBody);
urlEl.addEventListener("input", urlToParams);
urlEl.addEventListener("change", urlToParams);

$("btn-new").addEventListener("click", () => {
  activeId = null;
  applyDraft(blankRequest());
});

$("btn-save").addEventListener("click", () => {
  captureDraft();
  $("save-name").value = draft.name && draft.name !== "Untitled" ? draft.name : `${draft.method} ${draft.url}`;
  $("save-dialog").showModal();
  $("save-name").focus();
});

$("save-cancel").addEventListener("click", () => $("save-dialog").close("cancel"));

$("save-dialog").addEventListener("close", () => {
  if ($("save-dialog").returnValue !== "ok") return;
  const name = $("save-name").value.trim() || "Untitled";
  const req = { ...captureDraft(), id: activeId || uid(), name };
  const idx = state.saved.findIndex((s) => s.id === req.id);
  if (idx >= 0) state.saved[idx] = req;
  else state.saved.unshift(req);
  activeId = req.id;
  persist();
  paintLists();
});

$("btn-send").addEventListener("click", send);
$("btn-cancel").addEventListener("click", () => inflight?.abort());

$("btn-pretty").addEventListener("click", () => {
  try {
    bodyEl.value = JSON.stringify(JSON.parse(bodyEl.value), null, 2);
  } catch {
    bodyEl.focus();
  }
});

$("btn-copy-curl").addEventListener("click", async () => {
  await navigator.clipboard.writeText(toCurl(captureDraft()));
});

$("btn-copy-body").addEventListener("click", async () => {
  const text = $("response-raw").textContent;
  if (text) await navigator.clipboard.writeText(text);
});

$("btn-clear-history").addEventListener("click", () => {
  state.history = [];
  persist();
  paintLists();
});

$("search").addEventListener("input", paintLists);
$("btn-export").addEventListener("click", exportState);
$("btn-import").addEventListener("click", () => $("import-file").click());
$("import-file").addEventListener("change", async (e) => {
  const file = e.target.files?.[0];
  e.target.value = "";
  if (!file) return;
  try {
    const data = JSON.parse(await file.text());
    importPayload(data);
  } catch (err) {
    showResponse(null, `Import failed: ${err.message}`);
  }
});

$("btn-env").addEventListener("click", () => {
  renderKv("env", state.env.vars);
  $("env-dialog").showModal();
});

$("env-dialog").addEventListener("close", () => {
  state.env.vars = readKv("env");
  persist();
});

document.addEventListener("keydown", (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
    e.preventDefault();
    send();
  }
});

const splitter = $("splitter");
splitter.addEventListener("mousedown", (e) => {
  e.preventDefault();
  const pane = document.querySelector(".request-pane");
  const startY = e.clientY;
  const startH = pane.getBoundingClientRect().height;
  const move = (ev) => {
    const next = Math.max(140, Math.min(window.innerHeight - 220, startH + ev.clientY - startY));
    pane.style.flex = `0 0 ${next}px`;
  };
  const up = () => {
    window.removeEventListener("mousemove", move);
    window.removeEventListener("mouseup", up);
  };
  window.addEventListener("mousemove", move);
  window.addEventListener("mouseup", up);
});

$("mode-tag").textContent = IS_LOCAL ? "local" : "pages";
if (!IS_LOCAL) {
  $("mode-hint").textContent = "⌘↵ / Ctrl+Enter to send · GitHub Pages (CORS applies)";
}

paintEnv();
applyDraft(draft);
urlToParams();
