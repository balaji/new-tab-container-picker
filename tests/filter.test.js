import test from "node:test";
import assert from "node:assert/strict";
import {
  computeUniqueShortcutChars,
  filterContainers,
  getNextIndex,
} from "../src/lib/filter.js";
import { PREVIEW_CONTAINERS } from "../src/picker/preview-data.js";

const SAMPLE = [
  { cookieStoreId: "firefox-default", name: "Default", isDefault: true },
  { cookieStoreId: "firefox-container-1", name: "Personal", isDefault: false },
  { cookieStoreId: "firefox-container-2", name: "Work", isDefault: false },
  { cookieStoreId: "firefox-container-3", name: "Team Workspace", isDefault: false },
  { cookieStoreId: "firefox-container-4", name: "Banking", isDefault: false },
  { cookieStoreId: "firefox-container-5", name: "Shopping", isDefault: false },
];

test("filterContainers preserves order on empty/whitespace query", () => {
  assert.deepEqual(
    filterContainers(SAMPLE, "").map((c) => c.name),
    ["Default", "Personal", "Work", "Team Workspace", "Banking", "Shopping"]
  );
  assert.deepEqual(
    filterContainers(SAMPLE, "   ").map((c) => c.name),
    ["Default", "Personal", "Work", "Team Workspace", "Banking", "Shopping"]
  );
});

test("filterContainers ranks exact > prefix > substring > fuzzy subsequence", () => {
  const candidates = [
    { name: "My Working Setup" },
    { name: "Workspace" },
    { name: "w-o-r-k" },
    { name: "Work" },
  ];

  const ranked = filterContainers(candidates, "work").map((c) => c.name);
  assert.deepEqual(ranked, [
    "Work",           // exact
    "Workspace",      // prefix
    "My Working Setup", // substring
    "w-o-r-k",        // fuzzy subsequence
  ]);
});

test("filterContainers is case-insensitive and supports fuzzy search", () => {
  assert.deepEqual(
    filterContainers(SAMPLE, "WRK").map((c) => c.name),
    ["Work", "Team Workspace"]
  );

  assert.deepEqual(
    filterContainers(SAMPLE, "shp").map((c) => c.name),
    ["Shopping"]
  );

  assert.deepEqual(
    filterContainers(SAMPLE, "def").map((c) => c.name),
    ["Default"]
  );
});

test("filterContainers returns empty array when nothing matches", () => {
  assert.deepEqual(filterContainers(SAMPLE, "zzzzz"), []);
});

test("getNextIndex wraps cleanly across bounds and handles empty lists", () => {
  assert.equal(getNextIndex(0, 1, 5), 1);
  assert.equal(getNextIndex(4, 1, 5), 0);
  assert.equal(getNextIndex(0, -1, 5), 4);
  assert.equal(getNextIndex(-1, 1, 5), 1);
  assert.equal(getNextIndex(0, 1, 0), -1);
});

test("computeUniqueShortcutChars finds the first unique character per container and matches filterContainers", () => {
  const list = [
    { cookieStoreId: "c1", name: "WORK" },
    { cookieStoreId: "c2", name: "Social" },
    { cookieStoreId: "c3", name: "Hobby" },
    { cookieStoreId: "c4", name: "Doomscroll" },
    { cookieStoreId: "firefox-default", name: "Default" },
  ];

  const shortcuts = computeUniqueShortcutChars(list);
  assert.equal(shortcuts.get("c1"), "w");
  assert.equal(shortcuts.get("c2"), "i");
  assert.equal(shortcuts.get("c3"), "h");
  assert.equal(shortcuts.get("c4"), "m");
  assert.equal(shortcuts.get("firefox-default"), "e");

  for (const item of list) {
    const sc = shortcuts.get(item.cookieStoreId);
    assert.ok(sc, `Expected unique shortcut for ${item.name}`);
    const matches = filterContainers(list, sc);
    assert.equal(matches.length, 1);
    assert.equal(matches[0].cookieStoreId, item.cookieStoreId);
  }
});

test("computeUniqueShortcutChars picks the first candidate left-to-right and omits containers without unique chars", () => {
  const previewShortcuts = computeUniqueShortcutChars(PREVIEW_CONTAINERS);
  assert.equal(previewShortcuts.has("firefox-container-1"), false); // Personal has no unique char
  assert.equal(previewShortcuts.get("firefox-container-2"), "w");
  assert.equal(previewShortcuts.get("firefox-container-3"), "b");
  assert.equal(previewShortcuts.get("firefox-container-4"), "h");
  assert.equal(previewShortcuts.get("firefox-default"), "d");

  const subsetAndDuplicate = [
    { cookieStoreId: "sub", name: "Dev" },
    { cookieStoreId: "sup", name: "DevOps" },
    { cookieStoreId: "dup1", name: "Work" },
    { cookieStoreId: "dup2", name: "Work" },
  ];
  const s = computeUniqueShortcutChars(subsetAndDuplicate);
  assert.equal(s.has("sub"), false);
  assert.equal(s.get("sup"), "p");
  assert.equal(s.has("dup1"), false);
  assert.equal(s.has("dup2"), false);
});

test("computeUniqueShortcutChars restricts to letters/digits, skips combining/multi-unit edges", () => {
  const list = [
    { cookieStoreId: "emoji", name: "🚀 Work - 1" },
    { cookieStoreId: "num", name: "Work - 2" },
    { cookieStoreId: "turkish", name: "İ" },
    { cookieStoreId: "other-i", name: "i" },
    { cookieStoreId: "decomposed", name: "Cafe\u0301" },
    { cookieStoreId: "precomposed", name: "Café" },
    { cookieStoreId: "", name: "UniqueZ" },
    { name: "UniqueY" },
  ];

  const shortcuts = computeUniqueShortcutChars(list);
  assert.equal(shortcuts.get("emoji"), "1");
  assert.equal(shortcuts.get("num"), "2");
  // Turkish "İ".toLowerCase() is "i\u0307" (length 2) -> skipped for İ, and still blocks "other-i"
  assert.equal(shortcuts.has("turkish"), false);
  assert.equal(shortcuts.has("other-i"), false);
  // Combining-mark base "e" in "Cafe\u0301" is skipped; precomposed "é" is eligible
  assert.equal(shortcuts.has("decomposed"), false);
  assert.equal(shortcuts.get("precomposed"), "é");
  assert.equal(shortcuts.has(""), false);
  assert.equal(shortcuts.size, 3);

  assert.equal(computeUniqueShortcutChars([]).size, 0);
  assert.equal(computeUniqueShortcutChars(null).size, 0);
});
