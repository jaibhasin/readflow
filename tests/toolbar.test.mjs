import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const calls = [];
let listener;
let present = false;
let blocked = false;
globalThis.chrome = {
  tabs: { async sendMessage(id, message) {
    calls.push(["message", id, message]);
    if (!present) throw new Error("No receiver");
    return { ok: true };
  } },
  scripting: {
    async insertCSS(options) { calls.push(["css", options]); if (blocked) throw new Error("Restricted page"); },
    async executeScript(options) { calls.push(["script", options]); present = true; },
  },
  action: {
    onClicked: { addListener(fn) { listener = fn; } },
    async setBadgeText(options) { calls.push(["badge", options]); },
    async setTitle(options) { calls.push(["title", options]); },
  },
};
const { showWalkman } = await import("../extension/toolbar.ts");

test("normal websites remain untouched until toolbar activation", async () => {
  const manifest = JSON.parse(await readFile(new URL("../extension/manifest.json", import.meta.url)));
  assert.equal(manifest.content_scripts, undefined);
  assert.equal(manifest.action.default_popup, undefined);
  assert.ok(manifest.permissions.includes("activeTab"));
  assert.equal(calls.length, 0);
});

test("first click injects styles and player, subsequent clicks reuse it", async () => {
  await showWalkman({ id: 7 });
  assert.deepEqual(calls.slice(1), [
    ["css", { target: { tabId: 7 }, files: ["highlight.css"] }],
    ["script", { target: { tabId: 7 }, files: ["content.js"] }],
  ]);
  calls.length = 0;
  await showWalkman({ id: 7 });
  assert.deepEqual(calls, [["message", 7, { type: "show_readflow" }]]);
});

test("restricted pages show actionable toolbar feedback", async () => {
  calls.length = 0;
  present = false;
  blocked = true;
  listener({ id: 8 });
  await new Promise(resolve => setImmediate(resolve));
  assert.ok(calls.some(([kind, value]) => kind === "badge" && value.text === "!"));
  assert.ok(calls.some(([kind, value]) => kind === "title" && value.title.includes("regular website")));
  assert.ok(!calls.some(([kind]) => kind === "script"));
});
