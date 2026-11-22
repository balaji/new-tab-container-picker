import test from "node:test";
import assert from "node:assert/strict";
import { createSettingsState } from "../src/background/settings-state.js";

function createMockBrowserForSettings(localData = {}, options = {}) {
  const badge = { text: null, title: null };
  const writes = [];
  return {
    badge,
    writes,
    api: {
      storage: {
        local: {
          async get(keys) {
            const out = {};
            for (const k of keys) {
              if (k in localData) out[k] = localData[k];
            }
            return out;
          },
          async set(obj) {
            if (options.failWrite) {
              throw new Error("Write failed");
            }
            writes.push(obj);
            Object.assign(localData, obj);
          },
        },
      },
      action: {
        async setBadgeText({ text }) {
          badge.text = text;
        },
        async setBadgeBackgroundColor() {},
        async setBadgeTextColor() {},
        async setTitle({ title }) {
          badge.title = title;
        },
      },
    },
  };
}

test("init loads settings from storage.local and syncs badge", async () => {
  const mock = createMockBrowserForSettings({
    enabled: false,
    autoOpenSingleMatch: true,
  });
  const state = createSettingsState(mock.api);

  await state.init();
  assert.equal(state.isEnabled(), false);
  assert.deepEqual(state.getSettings(), {
    enabled: false,
    autoOpenSingleMatch: true,
  });
  assert.equal(mock.badge.text, "OFF");
});

test("toggleEnabled flips state, persists, handles write failures, and notifies onDisabled", async () => {
  let disabledCount = 0;
  const mock = createMockBrowserForSettings({}, { failWrite: true });
  const state = createSettingsState(mock.api, {
    onDisabled: async () => {
      disabledCount += 1;
    },
  });

  await state.init();
  assert.equal(state.isEnabled(), true);

  await state.toggleEnabled();
  assert.equal(state.isEnabled(), false);
  assert.equal(mock.badge.text, "OFF");
  assert.equal(disabledCount, 1);

  await state.toggleEnabled();
  assert.equal(state.isEnabled(), true);
  assert.equal(mock.badge.text, "");
  assert.equal(disabledCount, 1);
});

test("handleStorageChanged guards non-local areas, falls back non-booleans, and triggers onDisabled", async () => {
  let disabledCount = 0;
  const mock = createMockBrowserForSettings();
  const state = createSettingsState(mock.api, {
    onDisabled: () => {
      disabledCount += 1;
    },
  });
  await state.init();

  await state.handleStorageChanged({ enabled: { newValue: false } }, "sync");
  assert.equal(state.isEnabled(), true);
  assert.equal(disabledCount, 0);

  await state.handleStorageChanged(null, "local");
  assert.equal(state.isEnabled(), true);

  await state.handleStorageChanged(
    {
      enabled: { newValue: false },
      autoOpenSingleMatch: { newValue: true },
    },
    "local"
  );
  assert.deepEqual(state.getSettings(), {
    enabled: false,
    autoOpenSingleMatch: true,
  });
  assert.equal(mock.badge.text, "OFF");
  assert.equal(disabledCount, 1);

  await state.handleStorageChanged(
    {
      enabled: { newValue: "not-a-bool" },
      autoOpenSingleMatch: { newValue: 123 },
    },
    "local"
  );
  assert.deepEqual(state.getSettings(), {
    enabled: true,
    autoOpenSingleMatch: false,
  });
  assert.equal(mock.badge.text, "");
});
