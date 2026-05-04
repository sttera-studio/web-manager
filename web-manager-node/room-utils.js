const DEFAULT_ROOM = "lobby";

function normalizeRoom(roomName) {
  const raw = String(roomName || "").trim().toLowerCase();
  if (!raw) return DEFAULT_ROOM;
  return raw.replace(/[^a-z0-9_-]/g, "").slice(0, 32) || DEFAULT_ROOM;
}

function actionToCommand(action) {
  const actionMap = {
    ping: "ping",
    reload: "reload",
    "trigger-webgl": "trigger_webgl",
    "trigger-audio": "trigger_audio",
  };
  return actionMap[action] || null;
}

function buildRoomLinks(host, room) {
  const managerUrl = `http://${host}/?room=${encodeURIComponent(room)}`;
  const clientUrl = `http://${host}/instance?room=${encodeURIComponent(room)}`;
  return { managerUrl, clientUrl };
}

module.exports = {
  DEFAULT_ROOM,
  normalizeRoom,
  actionToCommand,
  buildRoomLinks,
};
