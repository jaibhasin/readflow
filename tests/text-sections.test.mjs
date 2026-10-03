import assert from "node:assert/strict";
import test from "node:test";
import { splitTextSections } from "../extension/text-sections.ts";

test("sections preserve exact text, source offsets, and order", () => {
  const text = "First sentence.\n\nSecond sentence with café. Third sentence!";
  const sections = splitTextSections(text);

  assert.equal(sections.map((section) => section.text).join(""), text);
  assert.deepEqual(sections.map((section) => section.index), sections.map((_, index) => index));
  for (const section of sections) {
    assert.equal(text.slice(section.start, section.end), section.text);
  }
});

test("long sentences split on word boundaries under the section limit", () => {
  const sentence = `${Array.from({ length: 100 }, (_, index) => `word${index}`).join(" ")}!`;
  const sections = splitTextSections(sentence);

  assert.ok(sections.length > 1);
  assert.equal(sections.map((section) => section.text).join(""), sentence);
  assert.ok(sections.every((section) => section.text.length <= 320));
  assert.ok(sections.every((section) => sentence.slice(section.start, section.end) === section.text));
});

test("very long unbroken words remain bounded without losing source offsets", () => {
  const text = `${"x".repeat(720)}.`;
  const sections = splitTextSections(text);

  assert.equal(sections.map((section) => section.text).join(""), text);
  assert.ok(sections.every((section) => section.text.length <= 320));
  assert.ok(sections.every((section) => text.slice(section.start, section.end) === section.text));
});

test("empty and whitespace-only input returns no requests", () => {
  assert.deepEqual(splitTextSections(""), []);
  assert.deepEqual(splitTextSections(" \n "), []);
});
