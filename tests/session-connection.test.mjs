import assert from "node:assert/strict";
import test from "node:test";
import { keepSessionConnected } from "../extension/session-connection.ts";
import { connectionErrorMessage, RECONNECT_MESSAGE } from "../extension/extension-runtime.ts";

test("listening keeps an idle worker alive independently of article-tab activity", () => {
  let now = 0;
  let lastActivity = 0;
  let heartbeat;
  let interval;
  const timer = {};
  const stop = keepSessionConnected({
    getPlatformInfo(callback) { lastActivity = now; callback({}); },
    lastError: undefined,
  }, {
    setInterval(callback, delay) { heartbeat = callback; interval = delay; return timer; },
    clearInterval(id) { assert.equal(id, timer); heartbeat = undefined; },
  });
  // No content-script messages arrive during this simulated ten-minute pause.
  for (now = interval; now <= 600_000; now += interval) {
    assert.ok(now - lastActivity < 30_000, "worker must receive activity before Chrome's idle cutoff");
    heartbeat();
  }
  stop();
  assert.equal(heartbeat, undefined, "disconnect releases the keep-alive");
});

test("only an invalidated extension context instructs the user to refresh", () => {
  assert.equal(connectionErrorMessage(undefined), RECONNECT_MESSAGE);
  assert.equal(connectionErrorMessage({ id: undefined }), RECONNECT_MESSAGE);
  assert.match(connectionErrorMessage({ id: "installed-extension" }), /Press Listen/);
  assert.doesNotMatch(connectionErrorMessage({ id: "installed-extension" }), /refresh/i);
});
