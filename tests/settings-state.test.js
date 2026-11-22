import test from "node:test";
import assert from "node:assert/strict";
import { createSettingsState } from "../src/background/settings-state.js";

function createMockBrowserForSettings(localData = {}) {
  return {
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
        },
      },
    },
  };
}

test("init loads openOnNewTab and autoOpenSingleMatch from storage.local", async () => {
  const defaultMock = createMockBrowserForSettings();
  const defaultState = createSettingsState(defaultMock.api);
  await defaultState.init();
  assert.equal(defaultState.isNewTabModeEnabled(), false);
  assert.deepEqual(defaultState.getSettings(), {
    openOnNewTab: false,
    autoOpenSingleMatch: false,
  });

  const enabledMock = createMockBrowserForSettings({
    openOnNewTab: true,
    autoOpenSingleMatch: true,
  });
  const enabledState = createSettingsState(enabledMock.api);
  await enabledState.init();
  assert.equal(enabledState.isNewTabModeEnabled(), true);
  assert.deepEqual(enabledState.getSettings(), {
    openOnNewTab: true,
    autoOpenSingleMatch: true,
  });
});

test("handleStorageChanged guards non-local areas and normalizes invalid values", async () => {
  const mock = createMockBrowserForSettings({
    openOnNewTab: true,
    autoOpenSingleMatch: false,
  });
  const state = createSettingsState(mock.api);
  await state.init();
  assert.equal(state.isNewTabModeEnabled(), true);

  state.handleStorageChanged({ openOnNewTab: { newValue: false } }, "sync");
  assert.equal(state.isNewTabModeEnabled(), true);

  state.handleStorageChanged(null, "local");
  assert.equal(state.isNewTabModeEnabled(), true);

  state.handleStorageChanged(
    {
      openOnNewTab: { newValue: false },
      autoOpenSingleMatch: { newValue: true },
    },
    "local"
  );
  assert.deepEqual(state.getSettings(), {
    openOnNewTab: false,
    autoOpenSingleMatch: true,
  });
  assert.equal(state.isNewTabModeEnabled(), false);

  state.handleStorageChanged(
    {
      openOnNewTab: { newValue: "not-a-bool" },
      autoOpenSingleMatch: { newValue: 123 },
    },
    "local"
  );
  assert.deepEqual(state.getSettings(), {
    openOnNewTab: false,
    autoOpenSingleMatch: false,
  });
});
