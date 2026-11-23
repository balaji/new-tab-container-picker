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

test("init loads openOnNewTab, openOnExternalLink, and autoOpenSingleMatch from storage.local", async () => {
  const defaultMock = createMockBrowserForSettings();
  const defaultState = createSettingsState(defaultMock.api);
  await defaultState.init();
  assert.equal(defaultState.isNewTabModeEnabled(), false);
  assert.equal(defaultState.isExternalLinkModeEnabled(), false);
  assert.deepEqual(defaultState.getSettings(), {
    openOnNewTab: false,
    openOnExternalLink: false,
    autoOpenSingleMatch: false,
    extensionEnabled: true,
  });

  const enabledMock = createMockBrowserForSettings({
    openOnNewTab: true,
    openOnExternalLink: true,
    autoOpenSingleMatch: true,
    extensionEnabled: true,
  });
  const enabledState = createSettingsState(enabledMock.api);
  await enabledState.init();
  assert.equal(enabledState.isNewTabModeEnabled(), true);
  assert.equal(enabledState.isExternalLinkModeEnabled(), true);
  assert.deepEqual(enabledState.getSettings(), {
    openOnNewTab: true,
    openOnExternalLink: true,
    autoOpenSingleMatch: true,
    extensionEnabled: true,
  });
});

test("handleStorageChanged guards non-local areas and normalizes invalid values", async () => {
  const mock = createMockBrowserForSettings({
    openOnNewTab: true,
    openOnExternalLink: false,
    autoOpenSingleMatch: false,
    extensionEnabled: true,
  });
  const state = createSettingsState(mock.api);
  await state.init();
  assert.equal(state.isNewTabModeEnabled(), true);
  assert.equal(state.isExternalLinkModeEnabled(), false);

  state.handleStorageChanged({ openOnNewTab: { newValue: false } }, "sync");
  assert.equal(state.isNewTabModeEnabled(), true);

  state.handleStorageChanged(null, "local");
  assert.equal(state.isNewTabModeEnabled(), true);

  state.handleStorageChanged(
    {
      openOnNewTab: { newValue: false },
      openOnExternalLink: { newValue: true },
      autoOpenSingleMatch: { newValue: true },
    },
    "local"
  );
  assert.deepEqual(state.getSettings(), {
    openOnNewTab: false,
    openOnExternalLink: true,
    autoOpenSingleMatch: true,
    extensionEnabled: true,
  });
  assert.equal(state.isNewTabModeEnabled(), false);
  assert.equal(state.isExternalLinkModeEnabled(), true);

  state.handleStorageChanged(
    {
      openOnNewTab: { newValue: "not-a-bool" },
      openOnExternalLink: { newValue: "yes" },
      autoOpenSingleMatch: { newValue: 123 },
    },
    "local"
  );
  assert.deepEqual(state.getSettings(), {
    openOnNewTab: false,
    openOnExternalLink: false,
    autoOpenSingleMatch: false,
    extensionEnabled: true,
  });
});

test("extensionEnabled=false suspends interception modes without losing stored preferences", async () => {
  const mock = createMockBrowserForSettings({
    openOnNewTab: true,
    openOnExternalLink: true,
    extensionEnabled: false,
  });
  const state = createSettingsState(mock.api);
  await state.init();
  assert.equal(state.isExtensionEnabled(), false);
  assert.equal(state.isNewTabModeEnabled(), false);
  assert.equal(state.isExternalLinkModeEnabled(), false);
  assert.equal(state.getSettings().openOnNewTab, true);

  state.handleStorageChanged({ extensionEnabled: { newValue: true } }, "local");
  assert.equal(state.isNewTabModeEnabled(), true);
  assert.equal(state.isExternalLinkModeEnabled(), true);

  state.handleStorageChanged({ extensionEnabled: { newValue: "nope" } }, "local");
  assert.equal(state.isExtensionEnabled(), true);
});
