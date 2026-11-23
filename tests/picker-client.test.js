import test from "node:test";
import assert from "node:assert/strict";
import { createPickerClient } from "../src/picker/picker-client.js";

function createAnnouncerSpy() {
  const calls = [];
  return {
    calls,
    clear: () => calls.push(["clear"]),
    announceImmediate: (text) => calls.push(["immediate", text]),
  };
}

test("picker client supports preview mode load (with Default last), pick, cancel reset, and settings notice", async () => {
  const announcer = createAnnouncerSpy();
  let resetCalls = 0;

  const client = createPickerClient({
    browserApi: undefined,
    win: { location: { search: "?preview=1&autoOpen=1" } },
    announcer,
    onPreviewReset: () => {
      resetCalls += 1;
    },
  });

  assert.equal(client.isPreviewMode, true);
  assert.equal(client.isInTabMode, false);
  const loaded = await client.loadState();
  assert.equal(loaded.isPreview, true);
  assert.equal(loaded.unavailableReason, null);
  assert.equal(loaded.autoOpenSingleMatch, true);
  assert.equal(loaded.containers.length, 5);
  assert.equal(loaded.containers[0].isDefault, false);
  assert.equal(loaded.containers.at(-1).isDefault, true);

  await client.pickContainer("firefox-container-2", "Work");
  assert.equal(client.isSettled(), false);
  assert.deepEqual(announcer.calls.at(-1), ["immediate", "Preview selected: Work"]);

  await client.cancelEscape();
  assert.equal(client.isSettled(), false);
  assert.equal(resetCalls, 1);

  await client.openSettings();
  assert.deepEqual(announcer.calls.at(-1), [
    "immediate",
    "Preview mode: settings unavailable",
  ]);
});

test("picker client toolbar popup mode detects private windows and disabled/empty containers", async () => {
  const privateClient = createPickerClient({
    browserApi: {
      windows: { getCurrent: async () => ({ incognito: true }) },
      contextualIdentities: {
        query: async () => [{ cookieStoreId: "firefox-container-1", name: "Personal" }],
      },
      storage: { local: { get: async () => ({ autoOpenSingleMatch: true }) } },
    },
    win: { location: { search: "" } },
    announcer: createAnnouncerSpy(),
  });
  const privateState = await privateClient.loadState();
  assert.equal(privateState.unavailableReason, "private-window");
  assert.deepEqual(privateState.containers, []);

  const disabledClient = createPickerClient({
    browserApi: {
      windows: { getCurrent: async () => ({ incognito: false }) },
      contextualIdentities: {
        query: async () => {
          throw new Error("Contextual identities disabled");
        },
      },
      storage: { local: { get: async () => ({ autoOpenSingleMatch: true }) } },
    },
    win: { location: { search: "" } },
    announcer: createAnnouncerSpy(),
  });
  const disabledState = await disabledClient.loadState();
  assert.equal(disabledState.unavailableReason, "containers-disabled");
  assert.deepEqual(disabledState.containers, []);
  assert.equal(disabledState.autoOpenSingleMatch, true);
});

test("picker client toolbar popup mode creates tabs at end of strip, enforces settled guard, and opens settings", async () => {
  const createdTabsA = [];
  let closedA = 0;
  const clientA = createPickerClient({
    browserApi: {
      windows: { getCurrent: async () => ({ incognito: false }) },
      contextualIdentities: {
        query: async () => [
          { cookieStoreId: "firefox-container-1", name: "Personal", color: "blue" },
        ],
      },
      storage: { local: { get: async () => ({ autoOpenSingleMatch: true }) } },
      tabs: {
        async create(props) {
          createdTabsA.push(props);
          return { id: 101 };
        },
      },
    },
    win: {
      location: { search: "" },
      close: () => {
        closedA += 1;
      },
    },
    announcer: createAnnouncerSpy(),
  });

  const loadedA = await clientA.loadState();
  assert.equal(loadedA.unavailableReason, null);
  assert.equal(loadedA.autoOpenSingleMatch, true);
  assert.equal(loadedA.containers[0].name, "Personal");
  assert.equal(loadedA.containers[1].name, "Default");

  await clientA.pickContainer("firefox-container-1", "Personal");
  assert.equal(clientA.isSettled(), true);
  assert.deepEqual(createdTabsA, [
    { cookieStoreId: "firefox-container-1", active: true },
  ]);
  assert.equal(closedA, 1);

  await clientA.cancelEscape();
  await clientA.openSettings();
  assert.equal(closedA, 1);

  const createdTabsB = [];
  let closedB = 0;
  const clientB = createPickerClient({
    browserApi: {
      contextualIdentities: { query: async () => [] },
      tabs: {
        async create(props) {
          createdTabsB.push(props);
          return { id: 102 };
        },
      },
    },
    win: {
      location: { search: "" },
      close: () => {
        closedB += 1;
      },
    },
    announcer: createAnnouncerSpy(),
  });

  await clientB.pickContainer("firefox-default", "Default");
  assert.deepEqual(createdTabsB, [{ active: true }]);
  assert.equal(closedB, 1);

  let closedEscape = 0;
  const clientEscape = createPickerClient({
    browserApi: { contextualIdentities: { query: async () => [] } },
    win: {
      location: { search: "" },
      close: () => {
        closedEscape += 1;
      },
    },
    announcer: createAnnouncerSpy(),
  });
  await clientEscape.cancelEscape();
  assert.equal(clientEscape.isSettled(), true);
  assert.equal(closedEscape, 1);

  let openedOptions = 0;
  let closedSettings = 0;
  const clientSettings = createPickerClient({
    browserApi: {
      contextualIdentities: { query: async () => [] },
      runtime: {
        async openOptionsPage() {
          openedOptions += 1;
          throw new Error("Options error");
        },
      },
    },
    win: {
      location: { search: "" },
      close: () => {
        closedSettings += 1;
      },
    },
    announcer: createAnnouncerSpy(),
  });
  await clientSettings.openSettings();
  assert.equal(openedOptions, 1);
  assert.equal(closedSettings, 1);
  assert.equal(clientSettings.isSettled(), true);
});

test("picker client in-tab mode replaces current picker tab at index, sets openerTabId for Default/Escape, and removes picker tab on settings", async () => {
  // Named container pick
  const createdA = [];
  const removedA = [];
  let closedA = 0;
  const clientA = createPickerClient({
    browserApi: {
      contextualIdentities: {
        query: async () => [
          { cookieStoreId: "firefox-container-1", name: "Personal", color: "blue" },
        ],
      },
      tabs: {
        async getCurrent() {
          return { id: 55, windowId: 10, index: 2 };
        },
        async create(props) {
          createdA.push(props);
          return { id: 56 };
        },
        async remove(id) {
          removedA.push(id);
        },
      },
    },
    win: {
      location: { search: "?mode=tab" },
      close: () => {
        closedA += 1;
      },
    },
    announcer: createAnnouncerSpy(),
  });

  assert.equal(clientA.isInTabMode, true);
  await clientA.pickContainer("firefox-container-1", "Personal");
  assert.deepEqual(createdA, [
    {
      windowId: 10,
      index: 2,
      cookieStoreId: "firefox-container-1",
      active: true,
    },
  ]);
  assert.deepEqual(removedA, [55]);
  assert.equal(closedA, 0);
  // settled guard blocks further calls
  await clientA.cancelEscape();
  assert.equal(createdA.length, 1);

  // Default pick passes openerTabId so background ignores created about:newtab
  const createdDefault = [];
  const removedDefault = [];
  const clientDefault = createPickerClient({
    browserApi: {
      contextualIdentities: { query: async () => [] },
      tabs: {
        async getCurrent() {
          return { id: 60, windowId: 10, index: 1 };
        },
        async create(props) {
          createdDefault.push(props);
          return { id: 61 };
        },
        async remove(id) {
          removedDefault.push(id);
        },
      },
    },
    win: { location: { search: "?mode=tab" } },
    announcer: createAnnouncerSpy(),
  });

  await clientDefault.pickContainer("firefox-default", "Default");
  assert.deepEqual(createdDefault, [
    { windowId: 10, index: 1, active: true, openerTabId: 60 },
  ]);
  assert.deepEqual(removedDefault, [60]);

  // Escape replaces picker tab with native Default tab (openerTabId set)
  const createdEsc = [];
  const removedEsc = [];
  const clientEsc = createPickerClient({
    browserApi: {
      contextualIdentities: { query: async () => [] },
      tabs: {
        async getCurrent() {
          return { id: 70, windowId: 12, index: 3 };
        },
        async create(props) {
          createdEsc.push(props);
          return { id: 71 };
        },
        async remove(id) {
          removedEsc.push(id);
        },
      },
    },
    win: { location: { search: "?mode=tab" } },
    announcer: createAnnouncerSpy(),
  });

  await clientEsc.cancelEscape();
  assert.deepEqual(createdEsc, [
    { windowId: 12, index: 3, active: true, openerTabId: 70 },
  ]);
  assert.deepEqual(removedEsc, [70]);

  // openSettings opens options page and removes picker tab (falling back to win.close on error)
  let openedOptions = 0;
  const removedOpt = [];
  const clientOpt = createPickerClient({
    browserApi: {
      contextualIdentities: { query: async () => [] },
      tabs: {
        async getCurrent() {
          return { id: 80, windowId: 10, index: 0 };
        },
        async remove(id) {
          removedOpt.push(id);
        },
      },
      runtime: {
        async openOptionsPage() {
          openedOptions += 1;
        },
      },
    },
    win: { location: { search: "?mode=tab" } },
    announcer: createAnnouncerSpy(),
  });
  await clientOpt.openSettings();
  assert.equal(openedOptions, 1);
  assert.deepEqual(removedOpt, [80]);

  let fallbackClosed = 0;
  const clientFallback = createPickerClient({
    browserApi: {
      contextualIdentities: { query: async () => [] },
      tabs: {
        async getCurrent() {
          throw new Error("No tab");
        },
      },
      runtime: { async openOptionsPage() {} },
    },
    win: {
      location: { search: "?mode=tab" },
      close: () => {
        fallbackClosed += 1;
      },
    },
    announcer: createAnnouncerSpy(),
  });
  await clientFallback.openSettings();
  assert.equal(fallbackClosed, 1);
});

test("picker client in-tab mode with target URL opens selected container or Default/Escape at that URL and rejects unsafe URLs", async () => {
  const target = "https://example.com/auth?code=abc#done";
  const createdNamed = [];
  const removedNamed = [];
  const sentMessages = [];
  const clientNamed = createPickerClient({
    browserApi: {
      contextualIdentities: { query: async () => [] },
      runtime: {
        async sendMessage(msg) {
          sentMessages.push(msg);
          return { ok: true };
        },
      },
      tabs: {
        async getCurrent() {
          return { id: 90, windowId: 10, index: 4 };
        },
        async create(props) {
          createdNamed.push(props);
          return { id: 91 };
        },
        async remove(id) {
          removedNamed.push(id);
        },
      },
    },
    win: {
      location: { search: `?mode=tab&url=${encodeURIComponent(target)}` },
    },
    announcer: createAnnouncerSpy(),
  });

  assert.equal(clientNamed.targetUrl, target);
  await clientNamed.pickContainer("firefox-container-2", "Work");
  assert.deepEqual(sentMessages, [
    {
      type: "allow-external-url",
      url: target,
      cookieStoreId: "firefox-container-2",
    },
  ]);
  assert.deepEqual(createdNamed, [
    {
      windowId: 10,
      index: 4,
      url: target,
      cookieStoreId: "firefox-container-2",
      active: true,
    },
  ]);
  assert.deepEqual(removedNamed, [90]);

  // Escape opens target URL in Default container with openerTabId and does NOT send allow-external-url
  const createdEsc = [];
  const escSentMessages = [];
  const clientEsc = createPickerClient({
    browserApi: {
      contextualIdentities: { query: async () => [] },
      runtime: {
        async sendMessage(msg) {
          escSentMessages.push(msg);
          return { ok: true };
        },
      },
      tabs: {
        async getCurrent() {
          return {
            id: 92,
            windowId: 10,
            index: 2,
            cookieStoreId: "firefox-default",
          };
        },
        async create(props) {
          createdEsc.push(props);
          return { id: 93 };
        },
        async remove() {},
      },
    },
    win: {
      location: { search: `?mode=tab&url=${encodeURIComponent(target)}` },
    },
    announcer: createAnnouncerSpy(),
  });
  await clientEsc.cancelEscape();
  assert.deepEqual(escSentMessages, []);
  assert.deepEqual(createdEsc, [
    {
      windowId: 10,
      index: 2,
      url: target,
      openerTabId: 92,
      active: true,
    },
  ]);

  // If picker tab were in a non-default container, Default/Escape omits cross-container openerTabId
  const createdCross = [];
  const clientCross = createPickerClient({
    browserApi: {
      contextualIdentities: { query: async () => [] },
      tabs: {
        async getCurrent() {
          return {
            id: 94,
            windowId: 10,
            index: 2,
            cookieStoreId: "firefox-container-2",
          };
        },
        async create(props) {
          createdCross.push(props);
          return { id: 95 };
        },
        async remove() {},
      },
    },
    win: {
      location: { search: `?mode=tab&url=${encodeURIComponent(target)}` },
    },
    announcer: createAnnouncerSpy(),
  });
  await clientCross.cancelEscape();
  assert.deepEqual(createdCross, [
    {
      windowId: 10,
      index: 2,
      url: target,
      active: true,
    },
  ]);

  // Unsafe URL schemes are rejected (targetUrl becomes null)
  const unsafeClient = createPickerClient({
    browserApi: { contextualIdentities: { query: async () => [] } },
    win: {
      location: {
        search: `?mode=tab&url=${encodeURIComponent("javascript:alert(1)")}`,
      },
    },
    announcer: createAnnouncerSpy(),
  });
  assert.equal(unsafeClient.targetUrl, null);
});

test("picker client keeps the in-tab picker (and its target URL) open when tab creation fails, then allows retry", async () => {
  const target = "https://example.com/invite?code=xyz";
  const created = [];
  const removed = [];
  const errors = [];
  let failNext = true;
  const announcer = createAnnouncerSpy();
  const client = createPickerClient({
    browserApi: {
      contextualIdentities: { query: async () => [] },
      runtime: { async sendMessage() { return { ok: true }; } },
      tabs: {
        async getCurrent() {
          return { id: 40, windowId: 10, index: 2 };
        },
        async create(props) {
          if (failNext) {
            failNext = false;
            throw new Error("No such container");
          }
          created.push(props);
          return { id: 41 };
        },
        async remove(id) {
          removed.push(id);
        },
      },
    },
    win: {
      location: { search: `?mode=tab&url=${encodeURIComponent(target)}` },
      close() {
        throw new Error("picker must not close");
      },
    },
    announcer,
    onError: (message) => errors.push(message),
  });

  await client.pickContainer("firefox-container-9", "Deleted");
  assert.deepEqual(removed, []);
  assert.equal(client.isSettled(), false);
  assert.equal(errors.length, 1);
  assert.ok(
    announcer.calls.some(([kind, text]) => kind === "immediate" && text === errors[0])
  );

  // Retry with another container succeeds and only then removes the picker tab
  await client.pickContainer("firefox-container-1", "Personal");
  assert.deepEqual(created, [
    {
      windowId: 10,
      index: 2,
      url: target,
      cookieStoreId: "firefox-container-1",
      active: true,
    },
  ]);
  assert.deepEqual(removed, [40]);
  assert.equal(client.isSettled(), true);
});

test("picker client keeps the in-tab picker open when Escape replacement fails", async () => {
  const removed = [];
  const errors = [];
  const client = createPickerClient({
    browserApi: {
      contextualIdentities: { query: async () => [] },
      tabs: {
        async getCurrent() {
          return { id: 42, windowId: 10, index: 0 };
        },
        async create() {
          throw new Error("create failed");
        },
        async remove(id) {
          removed.push(id);
        },
      },
    },
    win: { location: { search: "?mode=tab" } },
    announcer: createAnnouncerSpy(),
    onError: (message) => errors.push(message),
  });

  await client.cancelEscape();
  assert.deepEqual(removed, []);
  assert.equal(client.isSettled(), false);
  assert.equal(errors.length, 1);
});

test("picker client keeps the toolbar popup open when tab creation fails", async () => {
  let closed = 0;
  const errors = [];
  const client = createPickerClient({
    browserApi: {
      contextualIdentities: { query: async () => [] },
      tabs: {
        async create() {
          throw new Error("create failed");
        },
      },
    },
    win: {
      location: { search: "" },
      close: () => {
        closed += 1;
      },
    },
    announcer: createAnnouncerSpy(),
    onError: (message) => errors.push(message),
  });

  await client.pickContainer("firefox-container-1", "Personal");
  assert.equal(closed, 0);
  assert.equal(client.isSettled(), false);
  assert.equal(errors.length, 1);
});

test("picker client opens settings without closing the in-tab picker while an external link is pending", async () => {
  const target = "https://example.com/pending";
  const removed = [];
  let openedOptions = 0;
  const client = createPickerClient({
    browserApi: {
      contextualIdentities: { query: async () => [] },
      runtime: {
        async openOptionsPage() {
          openedOptions += 1;
        },
      },
      tabs: {
        async getCurrent() {
          return { id: 43, windowId: 10, index: 0 };
        },
        async remove(id) {
          removed.push(id);
        },
      },
    },
    win: {
      location: { search: `?mode=tab&url=${encodeURIComponent(target)}` },
      close() {
        throw new Error("picker must not close");
      },
    },
    announcer: createAnnouncerSpy(),
  });

  await client.openSettings();
  assert.equal(openedOptions, 1);
  assert.deepEqual(removed, []);
  assert.equal(client.isSettled(), false);
});
