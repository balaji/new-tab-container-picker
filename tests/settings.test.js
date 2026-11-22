import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_SETTINGS,
  STORAGE_KEY_AUTO_OPEN_SINGLE_MATCH,
  STORAGE_KEY_OPEN_ON_NEW_TAB,
  loadSettings,
  normalizeSettings,
  saveSettings,
} from "../src/lib/settings.js";

test("normalizeSettings fills defaults for missing, null, partial, or invalid-type values", () => {
  assert.deepEqual(normalizeSettings(undefined), DEFAULT_SETTINGS);
  assert.deepEqual(normalizeSettings(null), DEFAULT_SETTINGS);
  assert.deepEqual(normalizeSettings("invalid"), DEFAULT_SETTINGS);
  assert.deepEqual(DEFAULT_SETTINGS, {
    openOnNewTab: false,
    autoOpenSingleMatch: false,
  });

  assert.deepEqual(
    normalizeSettings({
      [STORAGE_KEY_OPEN_ON_NEW_TAB]: "yes",
      [STORAGE_KEY_AUTO_OPEN_SINGLE_MATCH]: 1,
    }),
    DEFAULT_SETTINGS
  );

  assert.deepEqual(
    normalizeSettings({
      [STORAGE_KEY_OPEN_ON_NEW_TAB]: true,
      [STORAGE_KEY_AUTO_OPEN_SINGLE_MATCH]: true,
    }),
    {
      openOnNewTab: true,
      autoOpenSingleMatch: true,
    }
  );
});

test("loadSettings reads storage keys safely and falls back to defaults on errors", async () => {
  assert.deepEqual(await loadSettings(undefined), DEFAULT_SETTINGS);

  let requestedKeys = null;
  const storage = {
    async get(keys) {
      requestedKeys = keys;
      return {
        [STORAGE_KEY_OPEN_ON_NEW_TAB]: true,
        [STORAGE_KEY_AUTO_OPEN_SINGLE_MATCH]: true,
      };
    },
  };
  assert.deepEqual(await loadSettings(storage), {
    openOnNewTab: true,
    autoOpenSingleMatch: true,
  });
  assert.deepEqual(requestedKeys, [
    STORAGE_KEY_OPEN_ON_NEW_TAB,
    STORAGE_KEY_AUTO_OPEN_SINGLE_MATCH,
  ]);

  const emptyStorage = {
    async get() {
      return {};
    },
  };
  assert.deepEqual(await loadSettings(emptyStorage), DEFAULT_SETTINGS);

  const failingStorage = {
    async get() {
      throw new Error("Storage read failed");
    },
  };
  assert.deepEqual(await loadSettings(failingStorage), DEFAULT_SETTINGS);
});

test("saveSettings persists valid boolean keys and ignores invalid or unknown entries", async () => {
  assert.equal(
    await saveSettings(undefined, { autoOpenSingleMatch: true }),
    false
  );
  assert.equal(await saveSettings({ set() {} }, null), false);

  const writes = [];
  const mockStorage = {
    async set(obj) {
      writes.push(obj);
    },
  };

  assert.equal(
    await saveSettings(mockStorage, {
      unknownKey: true,
      [STORAGE_KEY_OPEN_ON_NEW_TAB]: "true",
      [STORAGE_KEY_AUTO_OPEN_SINGLE_MATCH]: 1,
    }),
    false
  );
  assert.equal(writes.length, 0);

  assert.equal(
    await saveSettings(mockStorage, {
      unknownKey: "ignored",
      [STORAGE_KEY_OPEN_ON_NEW_TAB]: true,
      [STORAGE_KEY_AUTO_OPEN_SINGLE_MATCH]: true,
    }),
    true
  );
  assert.deepEqual(writes, [
    {
      openOnNewTab: true,
      autoOpenSingleMatch: true,
    },
  ]);

  const failingStorage = {
    async set() {
      throw new Error("Quota exceeded");
    },
  };
  await assert.rejects(
    saveSettings(failingStorage, { [STORAGE_KEY_AUTO_OPEN_SINGLE_MATCH]: true }),
    /Quota exceeded/
  );
});
