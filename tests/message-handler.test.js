import test from "node:test";
import assert from "node:assert/strict";
import { createMessageHandler } from "../src/background/message-handler.js";

function createHandlerHarness(overrides = {}) {
  let activeSession = overrides.session ?? {
    sessionId: "s1",
    placeholderTabId: 10,
    parentWindowId: 1,
    placeholderTabIndex: 2,
    popupWindowId: 99,
    containers: [
      { cookieStoreId: "firefox-default", name: "Default", isDefault: true },
      { cookieStoreId: "firefox-container-1", name: "Personal", isDefault: false },
    ],
    settled: false,
  };

  const log = {
    settled: 0,
    closedWindows: [],
    focusedWindows: [],
    focusedTabs: [],
    createdTabs: [],
    removedTabs: [],
    ignoredTabs: [],
    openOptionsCalls: 0,
  };

  const browserApi = {
    windows: {
      async remove(id) {
        log.closedWindows.push(id);
      },
      async update(id, props) {
        log.focusedWindows.push([id, props]);
      },
    },
    tabs: {
      async get(id) {
        if (overrides.failTabsGet) throw new Error("Tab gone");
        return { id, index: overrides.liveIndex ?? 4 };
      },
      async create(props) {
        if (overrides.failTabsCreate) throw new Error("Create failed");
        log.createdTabs.push(props);
        return { id: 777 };
      },
      async update(id, props) {
        log.focusedTabs.push([id, props]);
      },
      async remove(id) {
        log.removedTabs.push(id);
      },
    },
    runtime: {
      async openOptionsPage() {
        log.openOptionsCalls += 1;
        if (overrides.failOpenOptions) throw new Error("Cannot open options");
      },
    },
  };

  const handler = createMessageHandler(browserApi, {
    sessionManager: {
      matchSession(id) {
        if (!activeSession || activeSession.settled) return null;
        if (id && id !== activeSession.sessionId) return null;
        return activeSession;
      },
      async settleSession(session) {
        log.settled += 1;
        session.settled = true;
        activeSession = null;
        return true;
      },
    },
    settingsState: {
      getSettings: () => ({
        enabled: true,
        autoOpenSingleMatch: overrides.autoOpenSingleMatch ?? false,
      }),
    },
    ignoreTab: (id) => log.ignoredTabs.push(id),
  });

  return { handler, log };
}

test("handleMessage ignores non-objects, unknown types, and Object.prototype keys like toString", async () => {
  const { handler } = createHandlerHarness();
  assert.equal(await handler.handleMessage(null), undefined);
  assert.equal(await handler.handleMessage({}), undefined);
  assert.equal(await handler.handleMessage({ type: "UNKNOWN_TYPE" }), undefined);
  assert.equal(await handler.handleMessage({ type: "toString" }), undefined);
});

test("GET_PICKER_STATE returns active session containers and autoOpenSingleMatch setting", async () => {
  const { handler } = createHandlerHarness({ autoOpenSingleMatch: true });
  const state = await handler.handleMessage({
    type: "GET_PICKER_STATE",
    sessionId: "s1",
  });
  assert.equal(state.sessionId, "s1");
  assert.equal(state.containers.length, 2);
  assert.deepEqual(state.settings, { autoOpenSingleMatch: true });

  const mismatch = await handler.handleMessage({
    type: "GET_PICKER_STATE",
    sessionId: "wrong",
  });
  assert.equal(mismatch, null);
});

test("PICK_CONTAINER handles Default, valid container (live index + fallback), invalid container, and tabs.create error", async () => {
  // Default container
  const defaultHarness = createHandlerHarness();
  const resDefault = await defaultHarness.handler.handleMessage({
    type: "PICK_CONTAINER",
    sessionId: "s1",
    cookieStoreId: "firefox-default",
  });
  assert.deepEqual(resDefault, { ok: true, cookieStoreId: "firefox-default" });
  assert.deepEqual(defaultHarness.log.closedWindows, [99]);
  assert.deepEqual(defaultHarness.log.focusedTabs, [[10, { active: true }]]);

  // Valid container with live index
  const validHarness = createHandlerHarness({ liveIndex: 5 });
  const resValid = await validHarness.handler.handleMessage({
    type: "PICK_CONTAINER",
    sessionId: "s1",
    cookieStoreId: "firefox-container-1",
  });
  assert.deepEqual(resValid, {
    ok: true,
    cookieStoreId: "firefox-container-1",
    tabId: 777,
  });
  assert.deepEqual(validHarness.log.createdTabs, [
    { windowId: 1, cookieStoreId: "firefox-container-1", active: true, index: 5 },
  ]);
  assert.deepEqual(validHarness.log.ignoredTabs, [777]);
  assert.deepEqual(validHarness.log.removedTabs, [10]);
  assert.deepEqual(validHarness.log.closedWindows, [99]);

  // Valid container falling back to placeholderTabIndex when tabs.get throws
  const fallbackHarness = createHandlerHarness({ failTabsGet: true });
  await fallbackHarness.handler.handleMessage({
    type: "PICK_CONTAINER",
    sessionId: "s1",
    cookieStoreId: "firefox-container-1",
  });
  assert.equal(fallbackHarness.log.createdTabs[0].index, 2);

  // Invalid container
  const invalidHarness = createHandlerHarness();
  const resInvalid = await invalidHarness.handler.handleMessage({
    type: "PICK_CONTAINER",
    sessionId: "s1",
    cookieStoreId: "non-existent",
  });
  assert.deepEqual(resInvalid, { ok: false });
  assert.deepEqual(invalidHarness.log.closedWindows, [99]);
  assert.deepEqual(invalidHarness.log.focusedWindows, [[1, { focused: true }]]);

  // tabs.create failure
  const createErrHarness = createHandlerHarness({ failTabsCreate: true });
  const resErr = await createErrHarness.handler.handleMessage({
    type: "PICK_CONTAINER",
    sessionId: "s1",
    cookieStoreId: "firefox-container-1",
  });
  assert.deepEqual(resErr, { ok: false });
  assert.deepEqual(createErrHarness.log.closedWindows, [99]);
});

test("CANCEL_ESCAPE and OPEN_OPTIONS settle session and handle success/failure", async () => {
  const escapeHarness = createHandlerHarness();
  const escRes = await escapeHarness.handler.handleMessage({
    type: "CANCEL_ESCAPE",
    sessionId: "s1",
  });
  assert.deepEqual(escRes, { ok: true });
  assert.equal(escapeHarness.log.settled, 1);
  assert.deepEqual(escapeHarness.log.closedWindows, [99]);
  assert.deepEqual(escapeHarness.log.focusedTabs, [[10, { active: true }]]);

  // Second cancel fails because already settled
  assert.deepEqual(
    await escapeHarness.handler.handleMessage({ type: "CANCEL_ESCAPE", sessionId: "s1" }),
    { ok: false }
  );

  // OPEN_OPTIONS without active session still opens options page
  const noSessionHarness = createHandlerHarness({ session: null });
  assert.deepEqual(
    await noSessionHarness.handler.handleMessage({ type: "OPEN_OPTIONS" }),
    { ok: true }
  );
  assert.equal(noSessionHarness.log.openOptionsCalls, 1);

  // OPEN_OPTIONS failure returns { ok: false }
  const failOptHarness = createHandlerHarness({ failOpenOptions: true });
  assert.deepEqual(
    await failOptHarness.handler.handleMessage({ type: "OPEN_OPTIONS", sessionId: "s1" }),
    { ok: false }
  );
  assert.equal(failOptHarness.log.settled, 1);
});
