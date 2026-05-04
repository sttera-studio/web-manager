const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { URL } = require("url");
const { WebSocketServer } = require("ws");
const {
  DEFAULT_ROOM,
  normalizeRoom,
  actionToCommand,
  buildRoomLinks,
} = require("./room-utils");

const HOST = "127.0.0.1";
const PORT = Number(process.env.PORT || 3000);
const INDEX_PATH = path.join(__dirname, "index.html");
const INSTANCE_PATH = path.join(__dirname, "instance.html");
const CSS_PATH = path.join(__dirname, "global.css");
const JS_PATH = path.join(__dirname, "index.js");
const INSTANCE_JS_PATH = path.join(__dirname, "instance.js");

const connections = new Map();
const rooms = new Map();

function nowIso() {
  return new Date().toISOString();
}

function createRandomCode(prefix) {
  return `${prefix}${Math.random().toString(36).slice(2, 8)}`;
}

function ensureRoom(room) {
  const normalized = normalizeRoom(room);
  if (!rooms.has(normalized)) {
    rooms.set(normalized, {
      name: normalized,
      createdAt: nowIso(),
      lastActivity: nowIso(),
    });
  }
  return rooms.get(normalized);
}

function touchRoom(room) {
  const entry = ensureRoom(room);
  entry.lastActivity = nowIso();
}

function hasConnectionsInRoom(room) {
  for (const connection of connections.values()) {
    if (connection.room === room) return true;
  }
  return false;
}

function getUniqueRoomName() {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const candidate = createRandomCode("room-");
    if (!rooms.has(candidate) && !hasConnectionsInRoom(candidate)) {
      return candidate;
    }
  }
  return `room-${Date.now().toString(36)}`;
}

function createRoomLinks(req, room) {
  const host = req.headers.host || `${HOST}:${PORT}`;
  return buildRoomLinks(host, room, "");
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

function sendFile(res, filePath, contentType, notFoundMessage) {
  fs.readFile(filePath, (err, file) => {
    if (err) {
      sendJson(res, 500, { error: notFoundMessage });
      return;
    }
    res.writeHead(200, {
      "Content-Type": contentType,
      "Content-Length": file.length,
      "Cache-Control": "no-store",
    });
    res.end(file);
  });
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
  return Array.from(connections.values())
    .map((tab) => ({
      id: tab.id,
      tabId: tab.tabId,
      label: tab.label || "Untitled tab",
      connectedAt: tab.connectedAt,
      lastSeen: tab.lastSeen,
      url: tab.url || "",
      title: tab.title || "",
      userAgent: tab.userAgent || "",
      ip: tab.ip || "",
      role: tab.role || "instance",
      room: tab.room || DEFAULT_ROOM,
      status: "online",
    }))
    .sort((a, b) => (a.connectedAt > b.connectedAt ? -1 : 1));
}

function snapshotRooms() {
  const aggregate = new Map();
  for (const entry of rooms.values()) {
    aggregate.set(entry.name, {
      name: entry.name,
      createdAt: entry.createdAt || entry.lastActivity,
      total: 0,
      managers: 0,
      instances: 0,
      lastActivity: entry.lastActivity,
    });
  }

  for (const connection of connections.values()) {
    const room = connection.room || DEFAULT_ROOM;
    if (!aggregate.has(room)) {
      aggregate.set(room, {
        name: room,
        createdAt: connection.connectedAt || connection.lastSeen || nowIso(),
        total: 0,
        managers: 0,
        instances: 0,
        lastActivity: connection.lastSeen || nowIso(),
      });
    }
    const entry = aggregate.get(room);
    entry.total += 1;
    if (connection.role === "manager") {
      entry.managers += 1;
    } else {
      entry.instances += 1;
    }
    if (connection.lastSeen && connection.lastSeen > entry.lastActivity) {
      entry.lastActivity = connection.lastSeen;
    }
  }
  return Array.from(aggregate.values()).sort((a, b) => {
    if (a.createdAt === b.createdAt) {
      return a.name.localeCompare(b.name);
    }
    return a.createdAt > b.createdAt ? 1 : -1;
  });
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
    rooms: snapshotRooms(),
    serverTime: nowIso(),
  });
}

function dispatchCommandToTab(tabId, command, payload) {
  const tab = connections.get(tabId);
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

function dispatchCommandToRoom(room, command, payload, targetRole = null) {
  let sentCount = 0;
  for (const connection of connections.values()) {
    if (connection.room !== room) continue;
    if (targetRole && connection.role !== targetRole) continue;
    if (connection.ws.readyState !== connection.ws.OPEN) continue;

    connection.ws.send(
      JSON.stringify({
        type: "command",
        command,
        payload: payload || {},
        issuedAt: nowIso(),
      })
    );
    sentCount += 1;
  }
  if (sentCount > 0) {
    touchRoom(room);
  }
  return sentCount;
}

const server = http.createServer(async (req, res) => {
  const reqUrl = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);

  if (req.method === "GET" && (reqUrl.pathname === "/" || reqUrl.pathname === "/index.html")) {
    sendFile(res, INDEX_PATH, "text/html; charset=utf-8", "Could not load index.html");
    return;
  }

  if (req.method === "GET" && reqUrl.pathname === "/instance") {
    sendFile(res, INSTANCE_PATH, "text/html; charset=utf-8", "Could not load instance.html");
    return;
  }

  if (req.method === "GET" && reqUrl.pathname === "/global.css") {
    sendFile(res, CSS_PATH, "text/css; charset=utf-8", "Could not load global.css");
    return;
  }

  if (req.method === "GET" && reqUrl.pathname === "/index.js") {
    sendFile(res, JS_PATH, "application/javascript; charset=utf-8", "Could not load index.js");
    return;
  }

  if (req.method === "GET" && reqUrl.pathname === "/instance.js") {
    sendFile(res, INSTANCE_JS_PATH, "application/javascript; charset=utf-8", "Could not load instance.js");
    return;
  }

  if (req.method === "GET" && reqUrl.pathname === "/api/health") {
    sendJson(res, 200, {
      status: "ok",
      serverTime: nowIso(),
      tabsOnline: connections.size,
      roomsOnline: snapshotRooms().length,
    });
    return;
  }

  if (req.method === "GET" && reqUrl.pathname === "/api/rooms") {
    sendJson(res, 200, {
      rooms: snapshotRooms(),
      serverTime: nowIso(),
    });
    return;
  }

  if (req.method === "GET" && reqUrl.pathname === "/api/tabs") {
    sendJson(res, 200, {
      tabs: snapshotTabs(),
      rooms: snapshotRooms(),
      serverTime: nowIso(),
    });
    return;
  }

  if (req.method === "POST" && reqUrl.pathname === "/api/rooms/create") {
    const rawBody = await readBody(req).catch(() => "");
    const parsedBody = rawBody ? safeJsonParse(rawBody) : {};
    if (rawBody && !parsedBody) {
      sendJson(res, 400, { error: "Invalid JSON body" });
      return;
    }

    const requestedRoom = normalizeRoom(parsedBody.room);
    const shouldAutogenerate = !parsedBody.room || parsedBody.room === DEFAULT_ROOM;
    const room = shouldAutogenerate ? getUniqueRoomName() : requestedRoom;

    if (!shouldAutogenerate && (rooms.has(room) || hasConnectionsInRoom(room))) {
      sendJson(res, 409, { error: "Room already exists" });
      return;
    }

    const roomEntry = ensureRoom(room);
    roomEntry.lastActivity = nowIso();

    const links = createRoomLinks(req, room);
    sendJson(res, 200, {
      ok: true,
      room,
      ...links,
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

    const command = actionToCommand(action);
    const payload = parsedBody && typeof parsedBody.payload === "object" ? parsedBody.payload : {};

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

  if (req.method === "POST" && reqUrl.pathname.startsWith("/api/rooms/")) {
    const parts = reqUrl.pathname.split("/").filter(Boolean);
    const room = normalizeRoom(parts[2]);
    const action = parts[3];

    if (!room || !action) {
      sendJson(res, 400, { error: "Invalid room action route" });
      return;
    }

    const rawBody = await readBody(req).catch(() => "");
    const parsedBody = rawBody ? safeJsonParse(rawBody) : {};
    if (rawBody && !parsedBody) {
      sendJson(res, 400, { error: "Invalid JSON body" });
      return;
    }

    const command = actionToCommand(action);
    const payload = parsedBody && typeof parsedBody.payload === "object" ? parsedBody.payload : {};
    const targetRole = parsedBody && parsedBody.targetRole === "manager" ? "manager" : "instance";

    if (!command) {
      sendJson(res, 404, { error: "Unknown room action" });
      return;
    }

    const sentCount = dispatchCommandToRoom(room, command, payload, targetRole);
    if (sentCount === 0) {
      sendJson(res, 404, { error: "No matching online clients in room" });
      return;
    }

    sendJson(res, 200, {
      ok: true,
      room,
      action,
      targetRole,
      sentCount,
      serverTime: nowIso(),
    });
    return;
  }

  sendJson(res, 404, { error: "Not found" });
});

const wss = new WebSocketServer({ server });

wss.on("connection", (ws, req) => {
  const connectionId = `conn-${crypto.randomUUID()}`;
  let isRegistered = false;
  const remoteIp = req.socket.remoteAddress || "";

  ws.on("message", (message) => {
    const data = safeJsonParse(message.toString("utf8"));
    if (!data || typeof data !== "object") {
      return;
    }

    if (data.type === "register") {
      const tabId = String(data.tabId || "").trim();
      if (!tabId) return;

      isRegistered = true;
      const role = String(data.role || "instance").trim() === "manager" ? "manager" : "instance";
      const room = normalizeRoom(data.room);

      touchRoom(room);

      connections.set(connectionId, {
        id: connectionId,
        tabId,
        ws,
        connectedAt: nowIso(),
        lastSeen: nowIso(),
        label: String(data.label || "").trim() || `Tab ${tabId.slice(0, 6)}`,
        title: String(data.title || "").trim(),
        url: String(data.url || "").trim(),
        userAgent: String(data.userAgent || "").trim(),
        ip: remoteIp,
        role,
        room,
      });

      ws.send(
        JSON.stringify({
          type: "registered",
          id: connectionId,
          tabId,
          room,
          role,
          serverTime: nowIso(),
        })
      );

      broadcastSnapshot();
      return;
    }

    if (!isRegistered || !connections.has(connectionId)) {
      return;
    }

    const tab = connections.get(connectionId);
    tab.lastSeen = nowIso();

    if (data.type === "heartbeat") {
      const nextRoom = normalizeRoom(data.room || tab.room);
      tab.title = String(data.title || "").trim();
      tab.url = String(data.url || "").trim();
      tab.label = String(data.label || tab.label).trim();
      tab.role = String(data.role || tab.role).trim() === "manager" ? "manager" : "instance";
      tab.room = nextRoom;
      touchRoom(tab.room);
      broadcastSnapshot();
      return;
    }

    if (data.type === "tab_event") {
      touchRoom(tab.room);
      broadcast({
        type: "tab_event",
        id: connectionId,
        tabId: tab.tabId,
        event: String(data.event || "unknown"),
        details: data.details || {},
        serverTime: nowIso(),
      });
    }
  });

  ws.on("close", () => {
    if (connections.has(connectionId)) {
      connections.delete(connectionId);
      broadcastSnapshot();
    }
  });
});

setInterval(() => {
  const staleTime = Date.now() - 45_000;
  let changed = false;

  for (const [id, tab] of connections.entries()) {
    const lastSeenMs = new Date(tab.lastSeen).getTime();
    if (!Number.isNaN(lastSeenMs) && lastSeenMs < staleTime) {
      connections.delete(id);
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
