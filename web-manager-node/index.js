const ROOM_STORAGE_KEY = "wm_manager_room";

const state = {
  tabs: [],
  rooms: [],
  socket: null,
  room: "lobby",
};

function normalizeRoom(raw) {
  const cleaned = String(raw || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, "")
    .slice(0, 32);
  return cleaned || "lobby";
}

function getOrCreateTabId() {
  const existing = sessionStorage.getItem("wm_tab_id");
  if (existing) return existing;
  const created = "manager-" + Math.random().toString(36).slice(2, 10);
  sessionStorage.setItem("wm_tab_id", created);
  return created;
}

const managerId = getOrCreateTabId();

function setConnectionState(text, cssClass) {
  const el = document.getElementById("ws-state");
  el.textContent = text;
  el.className = "metric-value " + cssClass;
}

function formatTime(iso) {
  if (!iso) return "-";
  return new Date(iso).toLocaleTimeString();
}

async function api(path, options = {}) {
  const res = await fetch(path, {
    headers: { "Content-Type": "application/json" },
    ...options,
  });
  const payload = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(payload.error || "Request failed");
  }
  return payload;
}

function setCurrentRoom(room) {
  state.room = normalizeRoom(room);
  sessionStorage.setItem(ROOM_STORAGE_KEY, state.room);
  document.getElementById("current-room").textContent = state.room;
  renderRooms();
  renderTabs();
}

function renderRooms() {
  const grid = document.getElementById("rooms-grid");
  grid.innerHTML = "";
  if (state.rooms.length === 0) {
    grid.innerHTML = '<div class="logs-hint">No rooms yet.</div>';
    return;
  }

  state.rooms.forEach((room) => {
    const card = document.createElement("button");
    card.className = "room-card" + (room.name === state.room ? " selected" : "");
    card.type = "button";
    card.innerHTML = `
      <div class="room-name">${room.name}</div>
      <div class="small">instances: ${room.instances} | managers: ${room.managers}</div>
      <div class="small">last: ${formatTime(room.lastActivity)}</div>
    `;
    card.onclick = () => {
      setCurrentRoom(room.name);
      sendHeartbeat();
    };
    grid.appendChild(card);
  });
}

function filteredTabs() {
  return state.tabs.filter((tab) => tab.room === state.room && tab.role === "instance");
}

function renderTabs() {
  const rows = filteredTabs();
  const tbody = document.getElementById("tabs-table");
  tbody.innerHTML = "";

  rows.forEach((tab) => {
    const tr = document.createElement("tr");

    const idTd = document.createElement("td");
    idTd.innerHTML = `<div><span class="id">${tab.tabId || "-"}</span></div><div class="small">${tab.id}</div>`;

    const labelTd = document.createElement("td");
    labelTd.textContent = tab.label || "Untitled";

    const roleTd = document.createElement("td");
    roleTd.innerHTML = '<span class="badge role-instance">instance</span>';

    const seenTd = document.createElement("td");
    seenTd.textContent = formatTime(tab.lastSeen);

    tr.appendChild(idTd);
    tr.appendChild(labelTd);
    tr.appendChild(roleTd);
    tr.appendChild(seenTd);
    tbody.appendChild(tr);
  });

  document.getElementById("tabs-count").textContent = String(rows.length);
}

async function refreshData() {
  const payload = await api("/api/tabs");
  state.tabs = payload.tabs || [];
  state.rooms = payload.rooms || [];
  renderRooms();
  renderTabs();
}

async function copyText(text) {
  if (navigator.clipboard && navigator.clipboard.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }
  window.prompt("Copy this link", text);
}

function buildClientLink(room = state.room) {
  const params = new URLSearchParams({ room: normalizeRoom(room) });
  return `${location.origin}/instance?${params.toString()}`;
}

function connectSocket() {
  const protocol = location.protocol === "https:" ? "wss" : "ws";
  const socket = new WebSocket(`${protocol}://${location.host}`);
  state.socket = socket;

  socket.onopen = () => {
    setConnectionState("Connected", "ok");
    socket.send(
      JSON.stringify({
        type: "register",
        tabId: managerId,
        label: `Manager ${managerId.slice(-4)}`,
        title: document.title,
        url: location.href,
        role: "manager",
        room: state.room,
        userAgent: navigator.userAgent,
      })
    );
  };

  socket.onmessage = (event) => {
    const data = JSON.parse(event.data);
    if (data.type === "tabs_snapshot") {
      state.tabs = data.tabs || [];
      state.rooms = data.rooms || state.rooms;
      renderRooms();
      renderTabs();
      return;
    }
  };

  socket.onclose = () => {
    setConnectionState("Disconnected", "danger");
    setTimeout(connectSocket, 1200);
  };

  socket.onerror = () => {
    setConnectionState("Error", "danger");
  };
}

function sendHeartbeat() {
  if (!state.socket || state.socket.readyState !== WebSocket.OPEN) return;
  state.socket.send(
    JSON.stringify({
      type: "heartbeat",
      tabId: managerId,
      label: `Manager ${managerId.slice(-4)}`,
      title: document.title,
      url: location.href,
      role: "manager",
      room: state.room,
    })
  );
}

async function createRoomAndCopyLink() {
  const created = await api("/api/rooms/create", {
    method: "POST",
    body: JSON.stringify({ lock: false }),
  });
  setCurrentRoom(created.room);
  sendHeartbeat();
  await refreshData();
  await copyText(created.clientUrl);
}

document.getElementById("my-id").textContent = managerId;
setCurrentRoom("lobby");

document.getElementById("create-room").onclick = () => {
  createRoomAndCopyLink().catch(() => {});
};

document.getElementById("copy-link").onclick = () => {
  copyText(buildClientLink()).catch(() => {});
};

setInterval(sendHeartbeat, 5000);
window.addEventListener("focus", sendHeartbeat);

connectSocket();
refreshData().catch(() => {});
