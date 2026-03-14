// index.js
// index.html

const state = {
  tabs: [],
  socket: null,
};

function getOrCreateTabId() {
  const existing = sessionStorage.getItem("wm_tab_id");
  if (existing) return existing;
  const created = "tab-" + Math.random().toString(36).slice(2, 10);
  sessionStorage.setItem("wm_tab_id", created);
  return created;
}

function getLabel() {
  const fromQuery = new URLSearchParams(location.search).get("label");
  return fromQuery || `Managed ${windowTabId.slice(-4)}`;
}

const windowTabId = getOrCreateTabId();

function setConnectionState(text, cssClass) {
  const el = document.getElementById("ws-state");
  el.textContent = text;
  el.className = "metric-value " + cssClass;
}

function formatTime(iso) {
  if (!iso) return "-";
  const date = new Date(iso);
  return date.toLocaleTimeString();
}

function addLog(message, kind = "ok") {
  const logs = document.getElementById("logs");
  const item = document.createElement("div");
  item.className = "log-item " + (kind || "");
  item.textContent = `[${new Date().toLocaleTimeString()}] ${message}`;
  logs.prepend(item);
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

function rowActions(tab) {
  const cell = document.createElement("td");
  const box = document.createElement("div");
  box.className = "table-actions";

  const quickActions = [
    ["Ping", "ping"],
    ["Reload", "reload"],
  ];
  if (tab.role === "instance") {
    quickActions.splice(2, 0, ["Trigger WebGL", "trigger-webgl"]);
  }

  quickActions.forEach(([label, action]) => {
    const btn = document.createElement("button");
    btn.textContent = label;
    btn.onclick = async () => {
      try {
        await api(`/api/tabs/${tab.id}/${action}`, { method: "POST" });
        addLog(`${action} sent to ${tab.id}`);
      } catch (err) {
        addLog(err.message, "danger");
      }
    };
    box.appendChild(btn);
  });

  cell.appendChild(box);
  return cell;
}

function renderTabs() {
  const active = document.activeElement;
  if (active && active.tagName === "INPUT") {
    return;
  }

  const tbody = document.getElementById("tabs-table");
  tbody.innerHTML = "";

  state.tabs.forEach((tab) => {
    const tr = document.createElement("tr");

    const idTd = document.createElement("td");
    idTd.innerHTML = `<span class="id">${tab.id}</span>`;

    const labelTd = document.createElement("td");
    labelTd.textContent = tab.label || "Untitled";

    const pageTd = document.createElement("td");
    pageTd.innerHTML = `
      <div>${tab.title || "-"}</div>
      <div class="small">${tab.url || "-"}</div>
    `;

    const roleTd = document.createElement("td");
    roleTd.innerHTML = `<span class="badge">${tab.role || "managed"}</span>`;

    const seenTd = document.createElement("td");
    seenTd.textContent = formatTime(tab.lastSeen);

    tr.appendChild(idTd);
    tr.appendChild(labelTd);
    tr.appendChild(pageTd);
    tr.appendChild(roleTd);
    tr.appendChild(seenTd);
    tr.appendChild(rowActions(tab));

    tbody.appendChild(tr);
  });

  document.getElementById("tabs-count").textContent = String(state.tabs.length);
  document.getElementById("last-update").textContent = new Date().toLocaleTimeString();
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
        tabId: windowTabId,
        label: getLabel(),
        title: document.title,
        url: location.href,
        role: "managed",
        userAgent: navigator.userAgent,
      })
    );
    addLog(`registered as ${windowTabId}`);
  };

  socket.onmessage = (event) => {
    const data = JSON.parse(event.data);

    if (data.type === "tabs_snapshot") {
      state.tabs = data.tabs || [];
      renderTabs();
    }

    if (data.type === "tab_event") {
      addLog(`${data.tabId}: ${data.event}`);
    }

    if (data.type === "command") {
      handleCommand(data.command, data.payload || {});
    }
  };

  socket.onclose = () => {
    setConnectionState("Disconnected", "danger");
    addLog("socket closed, retrying...", "warning");
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
      tabId: windowTabId,
      label: getLabel(),
      title: document.title,
      url: location.href,
      role: "managed",
    })
  );
}

function handleCommand(command, payload) {
  if (command === "ping") {
    addLog("ping received");
    if (state.socket && state.socket.readyState === WebSocket.OPEN) {
      state.socket.send(
        JSON.stringify({
          type: "tab_event",
          event: "pong",
          details: { from: windowTabId },
        })
      );
    }
    return;
  }

  if (command === "reload") {
    addLog("reload received");
    location.reload();
    return;
  }

}

document.getElementById("my-id").textContent = windowTabId;

document.getElementById("refresh").onclick = async () => {
  try {
    const payload = await api("/api/tabs");
    state.tabs = payload.tabs || [];
    renderTabs();
    addLog("manual refresh complete");
  } catch (err) {
    addLog(err.message, "danger");
  }
};

setInterval(sendHeartbeat, 5000);
window.addEventListener("focus", sendHeartbeat);
window.addEventListener("popstate", sendHeartbeat);

connectSocket();
fetch("/api/tabs")
  .then((r) => r.json())
  .then((payload) => {
    state.tabs = payload.tabs || [];
    renderTabs();
  })
  .catch(() => {});
