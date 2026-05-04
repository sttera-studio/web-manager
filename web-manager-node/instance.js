const state = {
  socket: null,
  audioContext: null,
  gl: null,
  room: "lobby",
};

const ROOM_STORAGE_KEY = "wm_instance_room";

function normalizeRoom(raw) {
  const cleaned = String(raw || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, "")
    .slice(0, 32);
  return cleaned || "lobby";
}

function getOrCreateInstanceId() {
  const existing = sessionStorage.getItem("wm_instance_id");
  if (existing) return existing;
  const created = "instance-" + Math.random().toString(36).slice(2, 10);
  sessionStorage.setItem("wm_instance_id", created);
  return created;
}

const instanceId = getOrCreateInstanceId();

function getLabel() {
  const fromQuery = new URLSearchParams(location.search).get("label");
  return fromQuery || `Instance ${instanceId.slice(-4)}`;
}

function getInitialRoom() {
  const params = new URLSearchParams(location.search);
  const fromQuery = params.get("room");
  const fromSession = sessionStorage.getItem(ROOM_STORAGE_KEY);
  return normalizeRoom(fromQuery || fromSession || "lobby");
}

function setState(id, text, cssClass = "") {
  const el = document.getElementById(id);
  el.textContent = text;
  el.className = "metric-value " + cssClass;
}

function addLog(message, level = "ok") {
  const logs = document.getElementById("logs");
  const item = document.createElement("div");
  item.className = "log-item " + level;
  item.textContent = `[${new Date().toLocaleTimeString()}] ${message}`;
  logs.prepend(item);
}

function sendEvent(event, details = {}) {
  if (!state.socket || state.socket.readyState !== WebSocket.OPEN) return;
  state.socket.send(
    JSON.stringify({
      type: "tab_event",
      event,
      details,
    })
  );
}

function sendHeartbeat() {
  if (!state.socket || state.socket.readyState !== WebSocket.OPEN) return;
  state.socket.send(
    JSON.stringify({
      type: "heartbeat",
      tabId: instanceId,
      label: getLabel(),
      title: document.title,
      url: location.href,
      role: "instance",
      room: state.room,
    })
  );
}

function resizeCanvasToDisplaySize() {
  const canvas = document.getElementById("webgl-canvas");
  const width = Math.max(1, Math.floor(canvas.clientWidth));
  const height = Math.max(1, Math.floor(canvas.clientHeight));
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }
}

function updateWebGLViewport() {
  if (!state.gl) return;
  const canvas = state.gl.canvas;
  resizeCanvasToDisplaySize();
  state.gl.viewport(0, 0, canvas.width, canvas.height);
}

function connectSocket() {
  const protocol = location.protocol === "https:" ? "wss" : "ws";
  const socket = new WebSocket(`${protocol}://${location.host}`);
  state.socket = socket;

  socket.onopen = () => {
    setState("ws-state", "Connected", "ok");
    socket.send(
      JSON.stringify({
        type: "register",
        tabId: instanceId,
        label: getLabel(),
        title: document.title,
        url: location.href,
        role: "instance",
        room: state.room,
        userAgent: navigator.userAgent,
      })
    );
    addLog(`registered as ${instanceId} in room ${state.room}`);
    sendEvent("instance_connected", { role: "instance", room: state.room });
  };

  socket.onclose = () => {
    setState("ws-state", "Disconnected", "danger");
    addLog("socket closed, retrying...", "warning");
    setTimeout(connectSocket, 1200);
  };

  socket.onerror = () => {
    setState("ws-state", "Error", "danger");
  };

  socket.onmessage = (event) => {
    const data = JSON.parse(event.data);
    if (data.type !== "command") return;

    const command = data.command;
    const payload = data.payload || {};

    if (command === "ping") {
      sendEvent("pong", { from: instanceId });
      addLog("ping received");
      return;
    }
    if (command === "reload") {
      addLog("reload received");
      location.reload();
      return;
    }
    if (command === "trigger_audio") {
      addLog("trigger_audio received");
      triggerAudio();
      return;
    }
    if (command === "trigger_webgl") {
      addLog("trigger_webgl received");
      triggerWebGL();
    }
  };
}

async function triggerAudio() {
  try {
    if (!state.audioContext) {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      state.audioContext = new Ctx();
    }

    await state.audioContext.resume();

    const osc = state.audioContext.createOscillator();
    const gain = state.audioContext.createGain();
    osc.type = "sine";
    osc.frequency.value = 440;
    gain.gain.value = 0.0001;

    osc.connect(gain);
    gain.connect(state.audioContext.destination);

    const t = state.audioContext.currentTime;
    gain.gain.exponentialRampToValueAtTime(0.2, t + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.25);

    osc.start(t);
    osc.stop(t + 0.25);

    setState("webgl-state", "audio triggered", "ok");
    addLog("Web Audio triggered");
    sendEvent("web_audio_triggered", {
      sampleRate: state.audioContext.sampleRate,
      state: state.audioContext.state,
    });
  } catch (err) {
    setState("webgl-state", "audio failed", "danger");
    addLog(`Web Audio failed: ${err.message}`, "danger");
    sendEvent("web_audio_failed", { message: err.message });
  }
}

function triggerWebGL() {
  const canvas = document.getElementById("webgl-canvas");
  const gl = canvas.getContext("webgl") || canvas.getContext("experimental-webgl");

  if (!gl) {
    setState("webgl-state", "unsupported", "danger");
    addLog("WebGL not supported", "danger");
    sendEvent("webgl_failed", { reason: "unsupported" });
    return;
  }

  state.gl = gl;
  resizeCanvasToDisplaySize();
  const color = [Math.random() * 0.8, Math.random() * 0.8, Math.random() * 0.8, 1.0];
  gl.viewport(0, 0, canvas.width, canvas.height);
  gl.clearColor(color[0], color[1], color[2], color[3]);
  gl.clear(gl.COLOR_BUFFER_BIT);

  const version = gl.getParameter(gl.VERSION);
  setState("webgl-state", "triggered", "ok");
  addLog(`WebGL triggered (${version})`);
  sendEvent("webgl_triggered", { version, color });
}

document.getElementById("instance-id").textContent = instanceId;
state.room = getInitialRoom();
sessionStorage.setItem(ROOM_STORAGE_KEY, state.room);
document.getElementById("instance-room").textContent = state.room;

document.getElementById("go-panel").onclick = () => {
  const params = new URLSearchParams({ room: state.room });
  window.open(`/?${params.toString()}`, "_blank", "noopener,noreferrer");
};

setInterval(sendHeartbeat, 5000);
window.addEventListener("focus", sendHeartbeat);
window.addEventListener("popstate", sendHeartbeat);

connectSocket();
