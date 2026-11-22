import test from "node:test";
import assert from "node:assert/strict";
import {
  STORAGE_KEY_SESSION,
  createSessionManager,
} from "../src/background/session-manager.js";

function createMockSessionBrowser(overrides = {}) {
  const sessionStore = { ...(overrides.sessionStore ?? {}) };
  const removedWindows = [];
  let nextWinId = 500;
  let createCalls = 0;

  return {
    sessionStore,
    removedWindows,
    getCreateCalls: () => createCalls,
    api: {
      windows: {
        WINDOW_ID_NONE: -1,
        async get(windowId) {
          if (overrides.getWindow) {
            return overrides.getWindow(windowId);
          }
          return {
            id: windowId,
            type: "normal",
            left: 0,
            top: 0,
            width: 1000,
            height: 800,
            tabs: [{ id: 1 }, { id: 2 }],
          };
        },
        async create(props) {
          createCalls += 1;
          if (overrides.createWindow) {
            return overrides.createWindow(props, createCalls);
          }
          return { id: nextWinId++, ...props };
        },
        async remove(id) {
          removedWindows.push(id);
        },
      },
      contextualIdentities: {
        async query() {
          if (overrides.queryContainers) {
            return overrides.queryContainers();
          }
          return [
            {
              cookieStoreId: "firefox-container-1",
              name: "Personal",
              color: "blue",
              colorCode: "#37adff",
              icon: "fingerprint",
            },
          ];
        },
      },
      storage: {
        session: {
          async get(key) {
            return key in sessionStore ? { [key]: sessionStore[key] } : {};
          },
          async set(obj) {
            Object.assign(sessionStore, obj);
          },
          async remove(key) {
            delete sessionStore[key];
          },
        },
      },
      runtime: {
        getURL: (p) => `moz-extension://test/${p}`,
      },
    },
  };
}

test("restore recovers persisted activeSession without overwriting an existing one", async () => {
  const persisted = { sessionId: "s-restored", popupWindowId: 777, settled: false };
  const mock = createMockSessionBrowser({
    sessionStore: { [STORAGE_KEY_SESSION]: persisted },
  });
  const manager = createSessionManager(mock.api);

  await manager.restore();
  assert.deepEqual(manager.getActiveSession(), persisted);
  assert.equal(manager.getActivePopupWindowId(), 777);
  assert.equal(manager.matchSession("s-restored")?.popupWindowId, 777);
  assert.equal(manager.matchSession("wrong-id"), null);
});

test("triggerForTab enforces window/container guards and closes orphan popup on race cancellation", async () => {
  let seqId = 0;
  let notifyFirstQueryStarted;
  const firstQueryStarted = new Promise((resolve) => {
    notifyFirstQueryStarted = resolve;
  });
  let resolveFirstContainers;
  let callIndex = 0;

  const mock = createMockSessionBrowser({
    queryContainers: () => {
      callIndex += 1;
      if (callIndex === 1) {
        notifyFirstQueryStarted();
        return new Promise((resolve) => {
          resolveFirstContainers = resolve;
        });
      }
      return [{ cookieStoreId: "c1", name: "Work", color: "orange" }];
    },
  });

  const manager = createSessionManager(mock.api, {
    generateId: () => `id-${++seqId}`,
    now: () => 1000,
  });

  // Start first trigger and wait until it is paused at contextualIdentities.query
  const p1 = manager.triggerForTab({ id: 2, windowId: 10, index: 1 });
  await firstQueryStarted;

  // Start second trigger that advances triggerSeq and finishes first
  await manager.triggerForTab({ id: 3, windowId: 10, index: 2 });

  assert.equal(manager.getActiveSession()?.placeholderTabId, 3);
  const activeWinId = manager.getActivePopupWindowId();

  // Resolve stalled first trigger: should bail cleanly without replacing active session
  resolveFirstContainers([{ cookieStoreId: "c1", name: "Work", color: "orange" }]);
  await p1;

  assert.equal(manager.getActiveSession()?.placeholderTabId, 3);
  assert.equal(manager.getActivePopupWindowId(), activeWinId);

  // If disabled mid-create, created orphan popup window must be closed immediately
  let enabled = true;
  const orphanMock = createMockSessionBrowser({
    createWindow: async () => {
      enabled = false;
      return { id: 888 };
    },
  });
  const orphanManager = createSessionManager(orphanMock.api, {
    isEnabled: () => enabled,
  });
  await orphanManager.triggerForTab({ id: 4, windowId: 10, index: 0 });
  assert.deepEqual(orphanMock.removedWindows, [888]);
  assert.equal(orphanManager.getActiveSession(), null);
});

test("handleWindowFocusChanged, handleTabRemoved, and handleWindowRemoved manage session lifecycle", async () => {
  let currentNow = 2000;
  const mock = createMockSessionBrowser();
  const manager = createSessionManager(mock.api, {
    blurGraceMs: 250,
    now: () => currentNow,
    generateId: () => "sess-1",
  });

  await manager.triggerForTab({ id: 42, windowId: 10, index: 1 });
  const popupId = manager.getActivePopupWindowId();
  assert.ok(mock.sessionStore[STORAGE_KEY_SESSION]);

  // Inside grace period -> ignore blur
  currentNow = 2100;
  await manager.handleWindowFocusChanged(10);
  assert.notEqual(manager.getActiveSession(), null);

  // Focusing popup itself or WINDOW_ID_NONE -> keep open
  currentNow = 2500;
  await manager.handleWindowFocusChanged(popupId);
  await manager.handleWindowFocusChanged(-1);
  assert.notEqual(manager.getActiveSession(), null);

  // Focusing another window past grace period -> blur dismisses and removes popup
  await manager.handleWindowFocusChanged(10);
  assert.equal(manager.getActiveSession(), null);
  assert.equal(mock.removedWindows.at(-1), popupId);
  assert.equal(STORAGE_KEY_SESSION in mock.sessionStore, false);

  // Placeholder tab removed -> closes popup
  await manager.triggerForTab({ id: 43, windowId: 10, index: 1 });
  const popupId2 = manager.getActivePopupWindowId();
  await manager.handleTabRemoved(43);
  assert.equal(manager.getActiveSession(), null);
  assert.equal(mock.removedWindows.at(-1), popupId2);

  // External popup window removal -> settles without calling windows.remove again
  await manager.triggerForTab({ id: 44, windowId: 10, index: 1 });
  const popupId3 = manager.getActivePopupWindowId();
  const removeCountBefore = mock.removedWindows.length;
  await manager.handleWindowRemoved(popupId3);
  assert.equal(manager.getActiveSession(), null);
  assert.equal(mock.removedWindows.length, removeCountBefore);
});
