import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_SETTINGS,
  STORAGE_KEY_AUTO_OPEN_SINGLE_MATCH,
  STORAGE_KEY_ENABLED,
  loadSettings,
  normalizeSettings,
  saveSettings,
} from "../src/lib/settings.js";

test("normalizeSettings fills defaults for missing, null, partial, or invalid-type values", () => {
  assert.deepEqual(normalizeSettings(undefined), DEFAULT_SETTINGS);
  assert.deepEqual(normalizeSettings(null), DEFAULT_SETTINGS);
  assert.deepEqual(normalizeSettings("invalid"), DEFAULT_SETTINGS);

  assert.deepEqual(normalizeSettings({ [STORAGE_KEY_ENABLED]: false }), {
    enabled: false,
    autoOpenSingleMatch: false,
  });

  assert.deepEqual(
    normalizeSettings({
      [STORAGE_KEY_ENABLED]: "yes",
      [STORAGE_KEY_AUTO_OPEN_SINGLE_MATCH]: 1,
    }),
    DEFAULT_SETTINGS
  );

  assert.deepEqual(
    normalizeSettings({
      [STORAGE_KEY_ENABLED]: false,
      [STORAGE_KEY_AUTO_OPEN_SINGLE_MATCH]: true,
    }),
    {
      enabled: false,
      autoOpenSingleMatch: true,
    }
  );
});

test("loadSettings reads storage keys safely and falls back to defaults on errors", async () => {
  assert.deepEqual(await loadSettings(undefined), DEFAULT_SETTINGS);

  let requestedKeys = null;
  const partialStorage = {
    async get(keys) {
      requestedKeys = keys;
      return { [STORAGE_KEY_AUTO_OPEN_SINGLE_MATCH]: true };
    },
  };
  assert.deepEqual(await loadSettings(partialStorage), {
    enabled: true,
    autoOpenSingleMatch: true,
  });
  assert.deepEqual(requestedKeys, [
    STORAGE_KEY_ENABLED,
    STORAGE_KEY_AUTO_OPEN_SINGLE_MATCH,
  ]);

  const populatedStorage = {
    async get() {
      return {
        [STORAGE_KEY_ENABLED]: false,
        [STORAGE_KEY_AUTO_OPEN_SINGLE_MATCH]: true,
      };
    },
  };
  assert.deepEqual(await loadSettings(populatedStorage), {
    enabled: false,
    autoOpenSingleMatch: true,
  });

  const failingStorage = {
    async get() {
      throw new Error("Storage read failed");
    },
  };
  assert.deepEqual(await loadSettings(failingStorage), DEFAULT_SETTINGS);
});

test("saveSettings persists only known boolean keys and ignores invalid/unknown entries", async () => {
  assert.equal(await saveSettings(undefined, { enabled: false }), false);
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
      [STORAGE_KEY_ENABLED]: "false",
      [STORAGE_KEY_AUTO_OPEN_SINGLE_MATCH]: 1,
    }),
    false
  );
  assert.equal(writes.length, 0);

  assert.equal(
    await saveSettings(mockStorage, {
      unknownKey: "ignored",
      [STORAGE_KEY_AUTO_OPEN_SINGLE_MATCH]: true,
      [STORAGE_KEY_ENABLED]: false,
    }),
    true
  );
  assert.deepEqual(writes, [
    {
      enabled: false,
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
