import test from "node:test";
import assert from "node:assert/strict";
import { filterContainers, getNextIndex } from "../src/lib/filter.js";

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
