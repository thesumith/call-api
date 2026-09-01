import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(__dirname, "docs");
const HOST = "127.0.0.1";
const PORT = Number(process.env.PORT) || 4040;
const MAX_BODY = 10 * 1024 * 1024;
const BLOCKED_HEADERS = new Set([
  "host",
  "connection",
  "content-length",
  "transfer-encoding",
  "keep-alive",
  "proxy-connection",
  "upgrade",
]);

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".json": "application/json; charset=utf-8",
  ".ico": "image/x-icon",
};

function send(res, status, body, headers = {}) {
  const payload = Buffer.isBuffer(body) ? body : Buffer.from(body ?? "");
  res.writeHead(status, {
    "content-length": payload.length,
    ...headers,
  });
  res.end(payload);
}

function sendJson(res, status, data) {
  send(res, status, JSON.stringify(data), {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
}

function readBody(req, limit = MAX_BODY) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(Object.assign(new Error("Request body too large"), { code: "TOO_LARGE" }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function safePublicPath(urlPath) {
  const decoded = decodeURIComponent(urlPath.split("?")[0]);
  const relative = decoded === "/" ? "/index.html" : decoded;
  const resolved = path.resolve(PUBLIC, "." + relative);
  if (!resolved.startsWith(PUBLIC + path.sep) && resolved !== PUBLIC) return null;
  return resolved;
}

function describeFetchError(err, timeoutMs) {
  if (err?.name === "AbortError") return `Timed out after ${timeoutMs}ms`;
  const cause = err?.cause;
  if (cause?.code === "ECONNREFUSED") {
    const where = [cause.address, cause.port].filter((v) => v != null).join(":");
    return where ? `Connection refused (${where})` : "Connection refused";
  }
  if (cause?.code === "ENOTFOUND") return `Host not found (${cause.hostname || "unknown"})`;
  if (cause?.code === "ERR_TLS_CERT_ALTNAME_INVALID" || cause?.code === "UNABLE_TO_VERIFY_LEAF_SIGNATURE") {
    return `TLS certificate error: ${cause.message}`;
  }
  return cause?.message || err.message || String(err);
}

function headerObject(headers) {
  const out = {};
  if (!headers || typeof headers !== "object" || Array.isArray(headers)) return out;
  for (const [key, value] of Object.entries(headers)) {
    const name = String(key).trim();
    if (!name || BLOCKED_HEADERS.has(name.toLowerCase())) continue;
    if (value == null) continue;
    out[name] = String(value);
  }
  return out;
}

async function handleEcho(req, res, url) {
  const raw = await readBody(req);
  const headers = {};
  for (const [k, v] of Object.entries(req.headers)) headers[k] = v;
  sendJson(res, 200, {
    echo: true,
    method: req.method,
    path: url.pathname,
    query: Object.fromEntries(url.searchParams),
    headers,
    body: raw.length ? raw.toString("utf8") : "",
    at: new Date().toISOString(),
  });
}

async function handleProxy(req, res) {
  if (req.method !== "POST") {
    sendJson(res, 405, { error: "Use POST" });
    return;
  }

  let payload;
  try {
    const raw = await readBody(req);
    payload = JSON.parse(raw.toString("utf8") || "{}");
  } catch (err) {
    sendJson(res, 400, { error: err.code === "TOO_LARGE" ? "Request body too large" : "Invalid JSON" });
    return;
  }

  const method = String(payload.method || "GET").toUpperCase();
  const target = String(payload.url || "").trim();
  if (!target) {
    sendJson(res, 400, { error: "Missing url" });
    return;
  }

  let parsed;
  try {
    parsed = new URL(target);
  } catch {
    sendJson(res, 400, { error: "Invalid url" });
    return;
  }

  if (!/^https?:$/.test(parsed.protocol)) {
    sendJson(res, 400, { error: "Only http and https URLs are allowed" });
    return;
  }

  const headers = headerObject(payload.headers);
  if (!headers["User-Agent"] && !headers["user-agent"]) {
    headers["User-Agent"] = "Call API/1.0";
  }

  const hasBody = !["GET", "HEAD"].includes(method);
  const body = hasBody && payload.body != null ? String(payload.body) : undefined;
  const timeoutMs = Math.min(Math.max(Number(payload.timeout) || 30000, 1000), 120000);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const started = Date.now();

  try {
    const response = await fetch(parsed, {
      method,
      headers,
      body,
      redirect: payload.redirect === "manual" ? "manual" : "follow",
      signal: controller.signal,
    });

    const buffer = Buffer.from(await response.arrayBuffer());
    const contentType = response.headers.get("content-type") || "";
    const isBinary =
      /^(image|audio|video|font)\//i.test(contentType) ||
      /octet-stream|zip|pdf|wasm/i.test(contentType);

    const responseHeaders = [];
    response.headers.forEach((value, key) => responseHeaders.push([key, value]));

    sendJson(res, 200, {
      ok: true,
      status: response.status,
      statusText: response.statusText,
      url: response.url,
      redirected: response.redirected,
      headers: responseHeaders,
      timeMs: Date.now() - started,
      size: buffer.length,
      binary: isBinary,
      body: isBinary
        ? `[binary ${contentType || "response"} — ${buffer.length} bytes]`
        : buffer.toString("utf8"),
    });
  } catch (err) {
    sendJson(res, 200, {
      ok: false,
      error: describeFetchError(err, timeoutMs),
      timeMs: Date.now() - started,
    });
  } finally {
    clearTimeout(timer);
  }
}

function serveStatic(req, res, url) {
  const filePath = safePublicPath(url.pathname);
  if (!filePath) {
    send(res, 403, "Forbidden");
    return;
  }
  fs.stat(filePath, (err, stat) => {
    if (err || !stat.isFile()) {
      send(res, 404, "Not found", { "content-type": "text/plain; charset=utf-8" });
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    fs.readFile(filePath, (readErr, data) => {
      if (readErr) {
        send(res, 500, "Unable to read file");
        return;
      }
      send(res, 200, data, {
        "content-type": MIME[ext] || "application/octet-stream",
        "cache-control": ext === ".html" ? "no-store" : "public, max-age=60",
      });
    });
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || "/", `http://${HOST}:${PORT}`);

  try {
    if (url.pathname === "/__echo") {
      await handleEcho(req, res, url);
      return;
    }
    if (url.pathname === "/api/send") {
      await handleProxy(req, res);
      return;
    }
    if (req.method !== "GET" && req.method !== "HEAD") {
      send(res, 405, "Method not allowed");
      return;
    }
    serveStatic(req, res, url);
  } catch (err) {
    if (!res.headersSent) {
      sendJson(res, err.code === "TOO_LARGE" ? 413 : 500, {
        error: err.code === "TOO_LARGE" ? "Request body too large" : "Internal error",
      });
    }
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Call API listening on http://${HOST}:${PORT}`);
});
