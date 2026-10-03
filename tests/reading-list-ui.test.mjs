import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";

const dom = new JSDOM(readFileSync(new URL("../extension/reading-list.html", import.meta.url), "utf8"));
globalThis.document = dom.window.document;
const calls = [];
const reads = [
  { id: "pending", url: "https://example.com/article", title: "<script>Unsafe title</script>", source: "article", text: "One two three four", offset: 8, status: "in-progress", updatedAt: "2026-01-02" },
  { id: "future", url: "https://example.com/later", title: "For later", source: "article", text: "One two", offset: 0, status: "queued", updatedAt: "2026-01-01" },
];
globalThis.chrome = {
  runtime: { async sendMessage(input) {
    calls.push(input);
    if (input.type === "reading_list") return { items: structuredClone(reads) };
    if (input.type === "reading_remove") reads.splice(reads.findIndex(item => item.id === input.id), 1);
    return { ok: true };
  } },
  storage: { onChanged: { addListener() {} } },
  tabs: { async query() { return [{ id: 1 }]; }, async sendMessage() { return { ok: true }; }, async getCurrent() { return undefined; } },
};
await import("../extension/reading-list.ts");
const tick = () => new Promise(resolve => setImmediate(resolve));
await tick();

test("reading list shows progress, queued reads, and safe article titles", () => {
  assert.equal(document.querySelector("#pending-title").textContent, "In progress (1)");
  assert.equal(document.querySelector("#future-title").textContent, "To read (1)");
  assert.match(document.querySelector("#pending .status").textContent, /50% read\s+2 words left/);
  assert.equal(document.querySelector("progress").value, 50);
  assert.match(document.querySelector("#future .status").textContent, /Not started/);
  assert.equal(document.querySelector("#pending h3").textContent, "<script>Unsafe title</script>");
  assert.equal(document.querySelector("#pending script"), null);
});

test("pending and to-read cards open their saved links in a new tab", async () => {
  for (const section of ["pending", "future"]) {
    const card = document.querySelector(`#${section} article`);
    const link = card.querySelector(".read-link");
    assert.equal(link.href, reads.find(item => item.id === section).url);
    assert.equal(link.target, "_blank");
    assert.equal(link.rel, "noopener noreferrer");
    const before = calls.filter(call => call.type === "reading_open").length;
    card.click();
    await tick();
    assert.equal(calls.filter(call => call.type === "reading_open").length, before + 1);
    assert.deepEqual(calls.filter(call => call.type === "reading_open").at(-1), { type: "reading_open", id: section });
    link.click();
    await tick();
    assert.equal(calls.filter(call => call.type === "reading_open").length, before + 2);
  }
});

test("resume opens the saved read and removing it shows the empty state", async () => {
  const before = calls.filter(call => call.type === "reading_open").length;
  document.querySelector("#pending .actions button").click();
  await tick();
  assert.equal(calls.filter(call => call.type === "reading_open").length, before + 1);
  assert.ok(calls.some(call => call.type === "reading_open" && call.id === "pending"));
  document.querySelector("#pending .remove").click();
  await tick();
  assert.equal(calls.filter(call => call.type === "reading_open").length, before + 1, "removing a card never opens its link");
  assert.equal(document.querySelector("#pending article"), null);
  assert.match(document.querySelector("#pending").textContent, /No unfinished reads/);
});
