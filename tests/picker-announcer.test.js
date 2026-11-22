import test from "node:test";
import assert from "node:assert/strict";
import { createStatusAnnouncer } from "../src/picker/announcer.js";

test("createStatusAnnouncer debounces match counts and clears empty-query announcements", async () => {
  const el = { textContent: "stale" };
  const announcer = createStatusAnnouncer(el, { delayMs: 20 });

  // Empty query with matches clears text
  announcer.announceFilterCount(3, false);
  await new Promise((r) => setTimeout(r, 35));
  assert.equal(el.textContent, "");

  // Rapid updates debounce to the last count
  announcer.announceFilterCount(5, true);
  announcer.announceFilterCount(0, true);
  await new Promise((r) => setTimeout(r, 35));
  assert.equal(el.textContent, "No matching containers");

  announcer.announceFilterCount(1, true);
  await new Promise((r) => setTimeout(r, 35));
  assert.equal(el.textContent, "1 matching container");

  announcer.announceFilterCount(4, true);
  await new Promise((r) => setTimeout(r, 35));
  assert.equal(el.textContent, "4 matching containers");
});

test("announceImmediate and clear cancel pending timers and handle null element safely", async () => {
  const el = { textContent: "" };
  const announcer = createStatusAnnouncer(el, { delayMs: 30 });

  announcer.announceFilterCount(2, true);
  announcer.announceImmediate("Preview selected: Work");
  assert.equal(el.textContent, "Preview selected: Work");
  await new Promise((r) => setTimeout(r, 45));
  assert.equal(el.textContent, "Preview selected: Work");

  announcer.announceFilterCount(0, true);
  announcer.clear();
  await new Promise((r) => setTimeout(r, 45));
  assert.equal(el.textContent, "Preview selected: Work");

  const nullAnnouncer = createStatusAnnouncer(null, { delayMs: 10 });
  nullAnnouncer.announceFilterCount(1, true);
  nullAnnouncer.announceImmediate("Ignored");
  nullAnnouncer.clear();
});
