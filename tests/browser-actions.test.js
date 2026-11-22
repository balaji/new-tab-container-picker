import test from "node:test";
import assert from "node:assert/strict";
import {
  PICKER_HTML_PATH,
  closePopupWindow,
  dismissToDefaultTab,
  focusParentWindow,
  focusTab,
  getPickerUrlPrefix,
  isOwnPickerUrl,
  syncActionBadge,
} from "../src/background/browser-actions.js";

test("getPickerUrlPrefix and isOwnPickerUrl resolve runtime URLs and fall back cleanly", () => {
  assert.equal(getPickerUrlPrefix(undefined), PICKER_HTML_PATH);
  assert.equal(
    getPickerUrlPrefix({ getURL: (p) => `moz-extension://id/${p}` }),
    "moz-extension://id/src/picker/picker.html"
  );

  const runtime = { getURL: (p) => `moz-extension://id/${p}` };
  assert.equal(isOwnPickerUrl(runtime, null), false);
  assert.equal(isOwnPickerUrl(runtime, 123), false);
  assert.equal(
    isOwnPickerUrl(runtime, "moz-extension://id/src/picker/picker.html?session=1"),
    true
  );
  assert.equal(isOwnPickerUrl(runtime, "https://example.com"), false);
  assert.equal(isOwnPickerUrl(undefined, "src/picker/picker.html?session=abc"), true);
});

test("syncActionBadge updates badge and title for enabled/disabled and swallows errors", async () => {
  await syncActionBadge(undefined, true);

  const calls = [];
  const actionApi = {
    async setBadgeText(arg) {
      calls.push(["setBadgeText", arg]);
    },
    async setBadgeBackgroundColor(arg) {
      calls.push(["setBadgeBackgroundColor", arg]);
    },
    async setBadgeTextColor(arg) {
      calls.push(["setBadgeTextColor", arg]);
    },
    async setTitle(arg) {
      calls.push(["setTitle", arg]);
    },
  };

  await syncActionBadge(actionApi, true);
  assert.deepEqual(calls, [
    ["setBadgeText", { text: "" }],
    ["setTitle", { title: "New Tab Container Picker (Enabled — click to pause)" }],
  ]);

  calls.length = 0;
  await syncActionBadge(actionApi, false);
  assert.deepEqual(calls, [
    ["setBadgeText", { text: "OFF" }],
    ["setBadgeBackgroundColor", { color: "#52525e" }],
    ["setBadgeTextColor", { color: "#ffffff" }],
    ["setTitle", { title: "New Tab Container Picker (Paused — click to resume)" }],
  ]);

  const throwingAction = {
    async setBadgeText() {
      throw new Error("Unsupported");
    },
  };
  await assert.doesNotReject(syncActionBadge(throwingAction, false));
});

test("window and tab focus/close helpers guard non-numbers and swallow API errors", async () => {
  const ops = [];
  const browserApi = {
    windows: {
      async remove(id) {
        ops.push(["windows.remove", id]);
        if (id === 999) throw new Error("No window");
      },
      async update(id, props) {
        ops.push(["windows.update", id, props]);
        if (id === 999) throw new Error("No window");
      },
    },
    tabs: {
      async update(id, props) {
        ops.push(["tabs.update", id, props]);
        if (id === 999) throw new Error("No tab");
      },
    },
  };

  await closePopupWindow(browserApi.windows, undefined);
  await focusParentWindow(browserApi.windows, "10");
  await focusTab(browserApi.tabs, null);
  assert.equal(ops.length, 0);

  await closePopupWindow(browserApi.windows, 999);
  await focusParentWindow(browserApi.windows, 999);
  await focusTab(browserApi.tabs, 999);
  assert.equal(ops.length, 3);

  ops.length = 0;
  await dismissToDefaultTab(browserApi, {
    popupWindowId: 20,
    parentWindowId: 10,
    placeholderTabId: 5,
  });
  assert.deepEqual(ops, [
    ["windows.remove", 20],
    ["windows.update", 10, { focused: true }],
    ["tabs.update", 5, { active: true }],
  ]);
});
