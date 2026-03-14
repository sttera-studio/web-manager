const http = require("http");
const fs = require("fs");
const path = require("path");
const { URL } = require("url");
const { WebSocketServer } = require("ws");

const HOST = "127.0.0.1";
const PORT = Number(process.env.PORT || 3000);
const INDEX_PATH = path.join(__dirname, "index.html");
const INSTANCE_PATH = path.join(__dirname, "instance.html");
const CSS_PATH = path.join(__dirname, "global.css");
const JS_PATH = path.join(__dirname, "index.js");
const INSTANCE_JS_PATH = path.join(__dirname, "instance.js");

const tabs = new Map();

function nowIso() {
  return new Date().toISOString();
}

function safeJsonParse(raw) {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function sendJson(res, statusCode, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => {
      data += chunk.toString("utf8");
      if (data.length > 1024 * 64) {
        reject(new Error("Payload too large"));
      }
    });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

function snapshotTabs() {
  return Array.from(tabs.values())
    .map((tab) => ({
      id: tab.id,
      label: tab.label || "Untitled tab",
      connectedAt: tab.connectedAt,
      lastSeen: tab.lastSeen,
      url: tab.url || "",
      title: tab.title || "",
      userAgent: tab.userAgent || "",
      ip: tab.ip || "",
      role: tab.role || "managed",
      status: "online",
    }))
    .sort((a, b) => (a.connectedAt > b.connectedAt ? -1 : 1));
}

function broadcast(payload) {
  const message = JSON.stringify(payload);
  for (const ws of wss.clients) {
    if (ws.readyState === ws.OPEN) {
      ws.send(message);
    }
  }
}

function broadcastSnapshot() {
  broadcast({
    type: "tabs_snapshot",
    tabs: snapshotTabs(),
    serverTime: nowIso(),
  });
}

function dispatchCommandToTab(tabId, command, payload) {
  const tab = tabs.get(tabId);
  if (!tab || tab.ws.readyState !== tab.ws.OPEN) {
    return false;
  }

  tab.ws.send(
    JSON.stringify({
      type: "command",
      command,
      payload: payload || {},
      issuedAt: nowIso(),
    })
  );
  return true;
}

const server = http.createServer(async (req, res) => {
  const reqUrl = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);

  if (req.method === "GET" && (reqUrl.pathname === "/" || reqUrl.pathname === "/index.html")) {
    fs.readFile(INDEX_PATH, (err, file) => {
      if (err) {
        sendJson(res, 500, { error: "Could not load index.html" });
        return;
      }
      res.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Content-Length": file.length,
        "Cache-Control": "no-store",
      });
      res.end(file);
    });
    return;
  }

  if (req.method === "GET" && reqUrl.pathname === "/instance") {
    fs.readFile(INSTANCE_PATH, (err, file) => {
      if (err) {
        sendJson(res, 500, { error: "Could not load instance.html" });
        return;
      }
      res.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Content-Length": file.length,
        "Cache-Control": "no-store",
      });
      res.end(file);
    });
    return;
  }

  if (req.method === "GET" && reqUrl.pathname === "/global.css") {
    fs.readFile(CSS_PATH, (err, file) => {
      if (err) {
        sendJson(res, 500, { error: "Could not load global.css" });
        return;
      }
      res.writeHead(200, {
        "Content-Type": "text/css; charset=utf-8",
        "Content-Length": file.length,
        "Cache-Control": "no-store",
      });
      res.end(file);
    });
    return;
  }

  if (req.method === "GET" && reqUrl.pathname === "/index.js") {
    fs.readFile(JS_PATH, (err, file) => {
      if (err) {
        sendJson(res, 500, { error: "Could not load index.js" });
        return;
      }
      res.writeHead(200, {
        "Content-Type": "application/javascript; charset=utf-8",
        "Content-Length": file.length,
        "Cache-Control": "no-store",
      });
      res.end(file);
    });
    return;
  }

  if (req.method === "GET" && reqUrl.pathname === "/instance.js") {
    fs.readFile(INSTANCE_JS_PATH, (err, file) => {
      if (err) {
        sendJson(res, 500, { error: "Could not load instance.js" });
        return;
      }
      res.writeHead(200, {
        "Content-Type": "application/javascript; charset=utf-8",
        "Content-Length": file.length,
        "Cache-Control": "no-store",
      });
      res.end(file);
    });
    return;
  }

  if (req.method === "GET" && reqUrl.pathname === "/api/health") {
    sendJson(res, 200, {
      status: "ok",
      serverTime: nowIso(),
      tabsOnline: tabs.size,
    });
    return;
  }

  if (req.method === "GET" && reqUrl.pathname === "/api/tabs") {
    sendJson(res, 200, {
      tabs: snapshotTabs(),
      serverTime: nowIso(),
    });
    return;
  }

  if (req.method === "POST" && reqUrl.pathname.startsWith("/api/tabs/")) {
    const parts = reqUrl.pathname.split("/").filter(Boolean);
    const tabId = parts[2];
    const action = parts[3];

    if (!tabId || !action) {
      sendJson(res, 400, { error: "Invalid tab action route" });
      return;
    }

    const rawBody = await readBody(req).catch(() => "");
    const parsedBody = rawBody ? safeJsonParse(rawBody) : {};
    if (rawBody && !parsedBody) {
      sendJson(res, 400, { error: "Invalid JSON body" });
      return;
    }

    let command = null;
    let payload = {};

    if (action === "ping") command = "ping";
    if (action === "trigger-audio") command = "trigger_audio";
    if (action === "trigger-webgl") command = "trigger_webgl";
    if (action === "reload") command = "reload";

    if (!command) {
      sendJson(res, 404, { error: "Unknown tab action" });
      return;
    }

    const sent = dispatchCommandToTab(tabId, command, payload);
    if (!sent) {
      sendJson(res, 404, { error: "Target tab is offline or not found" });
      return;
    }

    sendJson(res, 200, {
      ok: true,
      tabId,
      action,
      serverTime: nowIso(),
    });
    return;
  }

  sendJson(res, 404, { error: "Not found" });
});

const wss = new WebSocketServer({ server });

wss.on("connection", (ws, req) => {
  let registeredTabId = null;
  const remoteIp = req.socket.remoteAddress || "";

  ws.on("message", (message) => {
    const data = safeJsonParse(message.toString("utf8"));
    if (!data || typeof data !== "object") {
      return;
    }

    if (data.type === "register") {
      const tabId = String(data.tabId || "").trim();
      if (!tabId) return;

      registeredTabId = tabId;
      tabs.set(tabId, {
        id: tabId,
        ws,
        connectedAt: nowIso(),
        lastSeen: nowIso(),
        label: String(data.label || "").trim() || `Tab ${tabId.slice(0, 6)}`,
        title: String(data.title || "").trim(),
        url: String(data.url || "").trim(),
        userAgent: String(data.userAgent || "").trim(),
        ip: remoteIp,
        role: String(data.role || "managed").trim(),
      });

      ws.send(
        JSON.stringify({
          type: "registered",
          tabId,
          serverTime: nowIso(),
        })
      );

      broadcastSnapshot();
      return;
    }

    if (!registeredTabId || !tabs.has(registeredTabId)) {
      return;
    }

    const tab = tabs.get(registeredTabId);
    tab.lastSeen = nowIso();

    if (data.type === "heartbeat") {
      tab.title = String(data.title || "").trim();
      tab.url = String(data.url || "").trim();
      tab.label = String(data.label || tab.label).trim();
      tab.role = String(data.role || tab.role).trim();
      broadcastSnapshot();
      return;
    }

    if (data.type === "tab_event") {
      broadcast({
        type: "tab_event",
        tabId: registeredTabId,
        event: String(data.event || "unknown"),
        details: data.details || {},
        serverTime: nowIso(),
      });
    }
  });

  ws.on("close", () => {
    if (registeredTabId) {
      tabs.delete(registeredTabId);
      broadcastSnapshot();
    }
  });
});

setInterval(() => {
  const staleTime = Date.now() - 45_000;
  let changed = false;

  for (const [id, tab] of tabs.entries()) {
    const lastSeenMs = new Date(tab.lastSeen).getTime();
    if (!Number.isNaN(lastSeenMs) && lastSeenMs < staleTime) {
      tabs.delete(id);
      changed = true;
    }
  }

  if (changed) {
    broadcastSnapshot();
  }
}, 15_000);

server.listen(PORT, HOST, () => {
  // Keep startup output compact and copy-pastable.
  console.log(`Web manager running at http://${HOST}:${PORT}`);
});
