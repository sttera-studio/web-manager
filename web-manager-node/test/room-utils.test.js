const test = require("node:test");
const assert = require("node:assert/strict");

const {
  DEFAULT_ROOM,
  normalizeRoom,
  actionToCommand,
  buildRoomLinks,
} = require("../room-utils");

test("normalizeRoom returns default for empty values", () => {
  assert.equal(normalizeRoom(""), DEFAULT_ROOM);
  assert.equal(normalizeRoom(null), DEFAULT_ROOM);
  assert.equal(normalizeRoom(undefined), DEFAULT_ROOM);
});

test("normalizeRoom sanitizes and lowercases", () => {
  assert.equal(normalizeRoom("  TEAM-A_1  "), "team-a_1");
  assert.equal(normalizeRoom("Room@!$"), "room");
});

test("actionToCommand maps supported actions", () => {
  assert.equal(actionToCommand("ping"), "ping");
  assert.equal(actionToCommand("reload"), "reload");
  assert.equal(actionToCommand("trigger-webgl"), "trigger_webgl");
  assert.equal(actionToCommand("trigger-audio"), "trigger_audio");
  assert.equal(actionToCommand("unknown"), null);
});

test("buildRoomLinks returns manager and client links", () => {
  const links = buildRoomLinks("127.0.0.1:3000", "room-abcd");
  assert.equal(links.managerUrl, "http://127.0.0.1:3000/?room=room-abcd");
  assert.equal(links.clientUrl, "http://127.0.0.1:3000/instance?room=room-abcd");
});
