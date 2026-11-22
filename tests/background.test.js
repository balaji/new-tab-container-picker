import test from "node:test";
import assert from "node:assert/strict";
import { createBackgroundController } from "../src/background.js";

function createEventEmitter() {
  const listeners = new Set();
  return {
    addListener(fn) {
      listeners.add(fn);
    },
    removeListener(fn) {
      listeners.delete(fn);
    },
    hasListener(fn) {
      return listeners.has(fn);
    },
    async emit(...args) {
      const results = [];
      for (const fn of [...listeners]) {
        results.push(await fn(...args));
      }
      return results;
    },
  };
}

function createMockBrowser(initial = {}) {
  let nextTabId = 100;
  let nextWindowId = 200;

  const tabsMap = new Map();
  const windowsMap = new Map();

  const initialTabs = initial.tabs ?? [
    {
      id: 1,
      windowId: 10,
      index: 0,
      url: "https://mozilla.org",
      cookieStoreId: "firefox-default",
      active: true,
      incognito: false,
      pinned: false,
    },
  ];
  for (const t of initialTabs) {
    tabsMap.set(t.id, { ...t });
  }

  const initialWindows = initial.windows ?? [
    {
      id: 10,
      type: "normal",
      focused: true,
      left: 100,
      top: 50,
      width: 1200,
      height: 800,
    },
  ];
  for (const w of initialWindows) {
    windowsMap.set(w.id, { ...w });
  }

  const localStore = { ...(initial.localStorage ?? {}) };
  const sessionStore = { ...(initial.sessionStorage ?? {}) };

  const badgeState = {
    text: "",
    backgroundColor: null,
    textColor: null,
    title: "",
  };

  const createdTabsLog = [];
  const createdWindowsLog = [];
  const removedTabsLog = [];
  const removedWindowsLog = [];
  const recentlyClosed = (initial.recentlyClosed ?? []).map((entry) =>
    structuredClone(entry)
  );
  const forgottenWindowsLog = [];
  const forgottenTabsLog = [];
  let nextSessionId = 1;
  let openOptionsCalls = 0;

  const tabsOnCreated = createEventEmitter();
  const tabsOnUpdated = createEventEmitter();
  const tabsOnRemoved = createEventEmitter();
  const windowsOnFocusChanged = createEventEmitter();
  const windowsOnRemoved = createEventEmitter();
  const sessionsOnChanged = createEventEmitter();
  const actionOnClicked = createEventEmitter();
  const storageOnChanged = createEventEmitter();
  const runtimeOnMessage = createEventEmitter();
  const runtimeOnInstalled = createEventEmitter();
  const runtimeOnStartup = createEventEmitter();

  let containersMode = initial.containersMode ?? "enabled";
  const containersList = initial.containers ?? [
    {
      cookieStoreId: "firefox-container-1",
      name: "Personal",
      color: "blue",
      colorCode: "#37adff",
      icon: "fingerprint",
      iconUrl: "resource://usercontext-content/fingerprint.svg",
    },
    {
      cookieStoreId: "firefox-container-2",
      name: "Work",
      color: "orange",
      colorCode: "#ff9f00",
      icon: "briefcase",
      iconUrl: "resource://usercontext-content/briefcase.svg",
    },
  ];

  const browser = {
    tabs: {
      onCreated: tabsOnCreated,
      onUpdated: tabsOnUpdated,
      onRemoved: tabsOnRemoved,
      async get(tabId) {
        const tab = tabsMap.get(tabId);
        if (!tab) throw new Error(`No tab ${tabId}`);
        return { ...tab };
      },
      async create(props) {
        const id = nextTabId++;
        const existingInWin = [...tabsMap.values()].filter(
          (t) => t.windowId === props.windowId
        );
        const tab = {
          id,
          windowId: props.windowId ?? 10,
          index: props.index ?? existingInWin.length,
          url: props.url ?? "about:newtab",
          cookieStoreId: props.cookieStoreId ?? "firefox-default",
          active: props.active ?? true,
          incognito: false,
          pinned: false,
          openerTabId: props.openerTabId,
        };
        tabsMap.set(id, tab);
        createdTabsLog.push({ props: { ...props }, tab: { ...tab } });
        await tabsOnCreated.emit({ ...tab });
        return { ...tab };
      },
      async update(tabId, props) {
        const tab = tabsMap.get(tabId);
        if (!tab) throw new Error(`No tab ${tabId}`);
        Object.assign(tab, props);
        return { ...tab };
      },
      async remove(tabId) {
        if (!tabsMap.has(tabId)) throw new Error(`No tab ${tabId}`);
        tabsMap.delete(tabId);
        removedTabsLog.push(tabId);
        await tabsOnRemoved.emit(tabId);
      },
    },
    windows: {
      WINDOW_ID_NONE: -1,
      onFocusChanged: windowsOnFocusChanged,
      onRemoved: windowsOnRemoved,
      async get(windowId, opts = {}) {
        const win = windowsMap.get(windowId);
        if (!win) throw new Error(`No window ${windowId}`);
        const copy = { ...win };
        if (opts.populate) {
          copy.tabs = [...tabsMap.values()]
            .filter((t) => t.windowId === windowId)
            .map((t) => ({ ...t }));
        }
        return copy;
      },
      async create(props) {
        const id = nextWindowId++;
        const win = {
          id,
          type: props.type ?? "normal",
          focused: props.focused ?? true,
          left: props.left ?? 0,
          top: props.top ?? 0,
          width: props.width ?? 360,
          height: props.height ?? 300,
        };
        windowsMap.set(id, win);
        createdWindowsLog.push({ props: { ...props }, win: { ...win } });

        const popupTabId = nextTabId++;
        const popupTab = {
          id: popupTabId,
          windowId: id,
          index: 0,
          url: props.url ?? "about:blank",
          cookieStoreId: "firefox-default",
          active: true,
          incognito: false,
          pinned: false,
        };
        tabsMap.set(popupTabId, popupTab);
        await tabsOnCreated.emit({ ...popupTab });
        return { ...win, tabs: [{ ...popupTab }] };
      },
      async update(windowId, props) {
        const win = windowsMap.get(windowId);
        if (!win) throw new Error(`No window ${windowId}`);
        Object.assign(win, props);
        return { ...win };
      },
      async remove(windowId) {
        const win = windowsMap.get(windowId);
        if (!win) throw new Error(`No window ${windowId}`);
        const winTabs = [];
        for (const [tId, t] of [...tabsMap.entries()]) {
          if (t.windowId === windowId) {
            winTabs.push({ ...t });
            tabsMap.delete(tId);
          }
        }
        windowsMap.delete(windowId);
        removedWindowsLog.push(windowId);
        recentlyClosed.unshift({
          window: {
            ...win,
            sessionId: `win-sess-${nextSessionId++}`,
            tabs: winTabs,
          },
        });
        await windowsOnRemoved.emit(windowId);
        await sessionsOnChanged.emit();
      },
    },
    contextualIdentities: {
      async query() {
        if (containersMode === "disabled-throw") {
          throw new Error("Contextual identities are disabled");
        }
        if (containersMode === "disabled-false") {
          return false;
        }
        if (containersMode === "empty") {
          return [];
        }
        return containersList.map((c) => ({ ...c }));
      },
    },
    storage: {
      onChanged: storageOnChanged,
      local: {
        async get(key) {
          if (typeof key === "string") {
            return key in localStore ? { [key]: localStore[key] } : {};
          }
          if (Array.isArray(key)) {
            const out = {};
            for (const k of key) {
              if (k in localStore) out[k] = localStore[k];
            }
            return out;
          }
          if (key && typeof key === "object") {
            const out = {};
            for (const [k, fallback] of Object.entries(key)) {
              out[k] = k in localStore ? localStore[k] : fallback;
            }
            return out;
          }
          return { ...localStore };
        },
        async set(obj) {
          const changes = {};
          for (const [k, v] of Object.entries(obj)) {
            const hadKey = k in localStore;
            const oldValue = localStore[k];
            localStore[k] = v;
            if (!hadKey || oldValue !== v) {
              changes[k] = { oldValue, newValue: v };
            }
          }
          if (Object.keys(changes).length > 0) {
            await storageOnChanged.emit(changes, "local");
          }
        },
      },
      session: {
        async get(key) {
          if (typeof key === "string") {
            return key in sessionStore ? { [key]: sessionStore[key] } : {};
          }
          return { ...sessionStore };
        },
        async set(obj) {
          Object.assign(sessionStore, obj);
        },
        async remove(key) {
          delete sessionStore[key];
        },
      },
    },
    action: {
      onClicked: actionOnClicked,
      async setBadgeText({ text }) {
        badgeState.text = text;
      },
      async setBadgeBackgroundColor({ color }) {
        badgeState.backgroundColor = color;
      },
      async setBadgeTextColor({ color }) {
        badgeState.textColor = color;
      },
      async setTitle({ title }) {
        badgeState.title = title;
      },
    },
    sessions: {
      onChanged: sessionsOnChanged,
      async getRecentlyClosed() {
        return recentlyClosed.map((entry) => structuredClone(entry));
      },
      async forgetClosedWindow(sessionId) {
        const idx = recentlyClosed.findIndex(
          (entry) => entry.window?.sessionId === sessionId
        );
        if (idx !== -1) {
          recentlyClosed.splice(idx, 1);
        }
        forgottenWindowsLog.push(sessionId);
        void sessionsOnChanged.emit();
      },
      async forgetClosedTab(windowId, sessionId) {
        const idx = recentlyClosed.findIndex(
          (entry) =>
            entry.tab?.windowId === windowId &&
            entry.tab?.sessionId === sessionId
        );
        if (idx !== -1) {
          recentlyClosed.splice(idx, 1);
        }
        forgottenTabsLog.push({ windowId, sessionId });
        void sessionsOnChanged.emit();
      },
    },
    runtime: {
      onMessage: runtimeOnMessage,
      onInstalled: runtimeOnInstalled,
      onStartup: runtimeOnStartup,
      getURL(path) {
        return `moz-extension://test-uuid/${path}`;
      },
      async openOptionsPage() {
        openOptionsCalls += 1;
      },
      async sendMessage(msg) {
        const results = await runtimeOnMessage.emit(msg);
        return results[0];
      },
    },
  };

  return {
    browser,
    tabsMap,
    windowsMap,
    localStore,
    sessionStore,
    badgeState,
    createdTabsLog,
    createdWindowsLog,
    removedTabsLog,
    removedWindowsLog,
    recentlyClosed,
    forgottenWindowsLog,
    forgottenTabsLog,
    getOpenOptionsCalls: () => openOptionsCalls,
    setContainersMode(mode) {
      containersMode = mode;
    },
    async simulateClosedUserTab(url = "https://example.com", windowId = 10) {
      const tabSession = {
        tab: {
          windowId,
          sessionId: `tab-sess-${nextSessionId++}`,
          url,
        },
      };
      recentlyClosed.unshift(tabSession);
      await sessionsOnChanged.emit();
      return structuredClone(tabSession);
    },
    async simulateNewTab(overrides = {}) {
      const id = nextTabId++;
      const existingInWin = [...tabsMap.values()].filter(
        (t) => t.windowId === (overrides.windowId ?? 10)
      );
      const tab = {
        id,
        windowId: 10,
        index: existingInWin.length,
        url: "about:newtab",
        cookieStoreId: "firefox-default",
        active: true,
        incognito: false,
        pinned: false,
        ...overrides,
      };
      tabsMap.set(id, tab);
      await tabsOnCreated.emit({ ...tab });
      return { ...tab };
    },
    async simulateTabUpdate(tabId, changeInfo) {
      const tab = tabsMap.get(tabId);
      if (tab) {
        Object.assign(tab, changeInfo);
      }
      await tabsOnUpdated.emit(tabId, changeInfo, tab ? { ...tab } : undefined);
    },
  };
}

test("1. about:newtab opens centered popup window with Default + Firefox containers", async () => {
  const mock = createMockBrowser();
  const controller = createBackgroundController(mock.browser, {
    pendingTimeoutMs: 25,
    blurGraceMs: 250,
  });
  await controller.ensureInitialized();

  const newTab = await mock.simulateNewTab({ url: "about:newtab" });
  assert.equal(mock.createdWindowsLog.length, 1);

  const popupProps = mock.createdWindowsLog[0].props;
  assert.equal(popupProps.type, "popup");
  assert.equal(popupProps.focused, true);
  assert.equal(popupProps.width, 360);
  assert.match(popupProps.url, /^moz-extension:\/\/test-uuid\/src\/picker\/picker\.html\?session=/);

  const state = await mock.browser.runtime.sendMessage({
    type: "GET_PICKER_STATE",
  });
  assert.equal(state.containers.length, 3);
  assert.equal(state.containers[0].name, "Default");
  assert.equal(state.containers[0].colorCode, null);
  assert.equal(state.containers[1].name, "Personal");
  assert.equal(state.containers[1].colorCode, "#37adff");
  assert.equal(state.containers[2].name, "Work");
  assert.equal(state.containers[2].colorCode, "#ff9f00");
  assert.equal(controller.getActiveSession().placeholderTabId, newTab.id);

  controller.destroy();
});

test("2. about:blank transitions to about:newtab vs navigating to real URL", async () => {
  const mock = createMockBrowser();
  const controller = createBackgroundController(mock.browser, {
    pendingTimeoutMs: 40,
  });
  await controller.ensureInitialized();

  // Case A: about:blank -> real URL cancels picker
  const realTab = await mock.simulateNewTab({ url: "about:blank" });
  assert.equal(mock.createdWindowsLog.length, 0);
  await mock.simulateTabUpdate(realTab.id, { url: "https://example.com" });
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(mock.createdWindowsLog.length, 0);

  // Case B: about:blank -> about:newtab opens picker
  const blankToNewTab = await mock.simulateNewTab({ url: "about:blank" });
  assert.equal(mock.createdWindowsLog.length, 0);
  await mock.simulateTabUpdate(blankToNewTab.id, { url: "about:newtab" });
  assert.equal(mock.createdWindowsLog.length, 1);

  controller.destroy();
});

test("3. Picking Default closes popup, focuses parent window, and keeps placeholder tab", async () => {
  const mock = createMockBrowser();
  const controller = createBackgroundController(mock.browser);
  await controller.ensureInitialized();

  const placeholder = await mock.simulateNewTab({ url: "about:newtab" });
  const state = await mock.browser.runtime.sendMessage({ type: "GET_PICKER_STATE" });
  const popupId = controller.getActiveSession().popupWindowId;

  const res = await mock.browser.runtime.sendMessage({
    type: "PICK_CONTAINER",
    sessionId: state.sessionId,
    cookieStoreId: "firefox-default",
  });

  assert.equal(res.ok, true);
  assert.equal(mock.windowsMap.has(popupId), false);
  assert.equal(mock.tabsMap.has(placeholder.id), true);
  assert.equal(mock.createdTabsLog.length, 0);
  assert.equal(mock.windowsMap.get(10).focused, true);
  assert.equal(controller.getActiveSession(), null);

  controller.destroy();
});

test("4. Picking a named container opens native new tab at exact index, removes placeholder, and does not re-trigger", async () => {
  const mock = createMockBrowser();
  const controller = createBackgroundController(mock.browser);
  await controller.ensureInitialized();

  const placeholder = await mock.simulateNewTab({ url: "about:newtab", index: 1 });
  const state = await mock.browser.runtime.sendMessage({ type: "GET_PICKER_STATE" });
  const popupId = controller.getActiveSession().popupWindowId;

  const res = await mock.browser.runtime.sendMessage({
    type: "PICK_CONTAINER",
    sessionId: state.sessionId,
    cookieStoreId: "firefox-container-2",
  });

  assert.equal(res.ok, true);
  assert.equal(mock.createdTabsLog.length, 1);
  assert.equal(mock.createdTabsLog[0].props.cookieStoreId, "firefox-container-2");
  assert.equal(mock.createdTabsLog[0].props.index, 1);
  assert.equal("url" in mock.createdTabsLog[0].props, false); // preserves Firefox native about:newtab
  assert.equal(mock.tabsMap.has(placeholder.id), false);
  assert.equal(mock.windowsMap.has(popupId), false);
  // Must NOT re-open another popup
  assert.equal(mock.createdWindowsLog.length, 1);

  controller.destroy();
});

test("5. Pressing Escape closes popup and keeps placeholder tab open as Default", async () => {
  const mock = createMockBrowser();
  const controller = createBackgroundController(mock.browser);
  await controller.ensureInitialized();

  const placeholder = await mock.simulateNewTab({ url: "about:newtab" });
  const state = await mock.browser.runtime.sendMessage({ type: "GET_PICKER_STATE" });
  const popupId = controller.getActiveSession().popupWindowId;

  const res = await mock.browser.runtime.sendMessage({
    type: "CANCEL_ESCAPE",
    sessionId: state.sessionId,
  });

  assert.equal(res.ok, true);
  assert.equal(mock.windowsMap.has(popupId), false);
  assert.equal(mock.tabsMap.has(placeholder.id), true);
  assert.equal(mock.removedTabsLog.length, 0);
  assert.equal(mock.windowsMap.get(10).focused, true);
  assert.equal(mock.tabsMap.get(placeholder.id).active, true);
  assert.equal(controller.getActiveSession(), null);

  controller.destroy();
});

test("6. Clicking another Firefox window dismisses popup (keeps Default tab); Cmd+Tab (WINDOW_ID_NONE) and startup jitter keep popup open", async () => {
  let fakeNow = 1000;
  const mock = createMockBrowser();
  const controller = createBackgroundController(mock.browser, {
    blurGraceMs: 250,
    now: () => fakeNow,
  });
  await controller.ensureInitialized();

  const placeholder = await mock.simulateNewTab({ url: "about:newtab" });
  const popupId = controller.getActiveSession().popupWindowId;

  // Jitter inside grace period (100ms < 250ms) -> stays open
  fakeNow = 1100;
  await mock.browser.windows.onFocusChanged.emit(10);
  assert.equal(mock.windowsMap.has(popupId), true);

  // Switching to another app via Cmd+Tab (WINDOW_ID_NONE = -1) after grace -> stays open
  fakeNow = 1300;
  await mock.browser.windows.onFocusChanged.emit(-1);
  assert.equal(mock.windowsMap.has(popupId), true);
  assert.notEqual(controller.getActiveSession(), null);

  // Focusing the Firefox window after grace period -> dismisses popup, keeps Default tab
  fakeNow = 1400;
  await mock.browser.windows.onFocusChanged.emit(10);
  assert.equal(mock.windowsMap.has(popupId), false);
  assert.equal(mock.tabsMap.has(placeholder.id), true);
  assert.equal(controller.getActiveSession(), null);

  controller.destroy();
});

test("7. Closing popup window externally clears session and keeps Default tab", async () => {
  const mock = createMockBrowser();
  const controller = createBackgroundController(mock.browser);
  await controller.ensureInitialized();

  const placeholder = await mock.simulateNewTab({ url: "about:newtab" });
  const popupId = controller.getActiveSession().popupWindowId;

  await mock.browser.windows.remove(popupId);
  assert.equal(controller.getActiveSession(), null);
  assert.equal(mock.tabsMap.has(placeholder.id), true);

  controller.destroy();
});

test("8. Rapid second Cmd+T dismisses previous popup and opens picker for newest tab", async () => {
  const mock = createMockBrowser();
  const controller = createBackgroundController(mock.browser);
  await controller.ensureInitialized();

  const firstTab = await mock.simulateNewTab({ url: "about:newtab" });
  const firstPopupId = controller.getActiveSession().popupWindowId;

  const secondTab = await mock.simulateNewTab({ url: "about:newtab" });
  const secondPopupId = controller.getActiveSession().popupWindowId;

  assert.notEqual(secondPopupId, firstPopupId);
  assert.equal(mock.windowsMap.has(firstPopupId), false);
  assert.equal(mock.tabsMap.has(firstTab.id), true);
  assert.equal(controller.getActiveSession().placeholderTabId, secondTab.id);

  controller.destroy();
});

test("9. Containers disabled or empty never opens popup", async () => {
  const mock = createMockBrowser({ containersMode: "disabled-throw" });
  const controller = createBackgroundController(mock.browser);
  await controller.ensureInitialized();

  await mock.simulateNewTab({ url: "about:newtab" });
  assert.equal(mock.createdWindowsLog.length, 0);

  mock.setContainersMode("empty");
  await mock.simulateNewTab({ url: "about:newtab" });
  assert.equal(mock.createdWindowsLog.length, 0);

  controller.destroy();
});

test("10. Toolbar icon toggles paused (OFF badge) and suppresses picker until resumed", async () => {
  const mock = createMockBrowser();
  const controller = createBackgroundController(mock.browser);
  await controller.ensureInitialized();

  assert.equal(mock.badgeState.text, "");

  // Click toolbar icon -> pause
  await mock.browser.action.onClicked.emit();
  assert.equal(controller.isEnabled(), false);
  assert.equal(mock.badgeState.text, "OFF");
  assert.equal(mock.localStore.enabled, false);

  await mock.simulateNewTab({ url: "about:newtab" });
  assert.equal(mock.createdWindowsLog.length, 0);

  // Click toolbar icon -> resume
  await mock.browser.action.onClicked.emit();
  assert.equal(controller.isEnabled(), true);
  assert.equal(mock.badgeState.text, "");
  assert.equal(mock.localStore.enabled, true);

  await mock.simulateNewTab({ url: "about:newtab" });
  assert.equal(mock.createdWindowsLog.length, 1);

  controller.destroy();
});

test("11. GET_PICKER_STATE defaults autoOpenSingleMatch to false and reflects stored true", async () => {
  const mockDefault = createMockBrowser();
  const controllerDefault = createBackgroundController(mockDefault.browser);
  await controllerDefault.ensureInitialized();

  await mockDefault.simulateNewTab({ url: "about:newtab" });
  const defaultState = await mockDefault.browser.runtime.sendMessage({
    type: "GET_PICKER_STATE",
  });
  assert.deepEqual(defaultState.settings, { autoOpenSingleMatch: false });
  assert.deepEqual(controllerDefault.getSettings(), {
    enabled: true,
    autoOpenSingleMatch: false,
  });
  controllerDefault.destroy();

  const mockEnabled = createMockBrowser({
    localStorage: { autoOpenSingleMatch: true },
  });
  const controllerEnabled = createBackgroundController(mockEnabled.browser);
  await controllerEnabled.ensureInitialized();

  await mockEnabled.simulateNewTab({ url: "about:newtab" });
  const enabledState = await mockEnabled.browser.runtime.sendMessage({
    type: "GET_PICKER_STATE",
  });
  assert.deepEqual(enabledState.settings, { autoOpenSingleMatch: true });
  assert.deepEqual(controllerEnabled.getSettings(), {
    enabled: true,
    autoOpenSingleMatch: true,
  });
  controllerEnabled.destroy();
});

test("12. Changing autoOpenSingleMatch in storage.local updates controller and GET_PICKER_STATE", async () => {
  const mock = createMockBrowser();
  const controller = createBackgroundController(mock.browser);
  await controller.ensureInitialized();

  await mock.browser.storage.local.set({ autoOpenSingleMatch: true });
  assert.equal(controller.getSettings().autoOpenSingleMatch, true);

  await mock.simulateNewTab({ url: "about:newtab" });
  const state = await mock.browser.runtime.sendMessage({
    type: "GET_PICKER_STATE",
  });
  assert.equal(state.settings.autoOpenSingleMatch, true);

  controller.destroy();
});

test("13. Changing enabled to false via storage.onChanged updates badge, dismisses popup, and suppresses new tabs", async () => {
  const mock = createMockBrowser();
  const controller = createBackgroundController(mock.browser);
  await controller.ensureInitialized();

  const placeholder = await mock.simulateNewTab({ url: "about:newtab" });
  const popupId = controller.getActiveSession().popupWindowId;

  await mock.browser.storage.local.set({ enabled: false });
  assert.equal(controller.isEnabled(), false);
  assert.equal(mock.badgeState.text, "OFF");
  assert.equal(mock.windowsMap.has(popupId), false);
  assert.equal(mock.tabsMap.has(placeholder.id), true);
  assert.equal(controller.getActiveSession(), null);

  await mock.simulateNewTab({ url: "about:newtab" });
  assert.equal(mock.createdWindowsLog.length, 1);

  controller.destroy();
});

test("14. OPEN_OPTIONS closes popup, focuses parent window, keeps placeholder tab, clears session, and opens options page", async () => {
  const mock = createMockBrowser();
  const controller = createBackgroundController(mock.browser);
  await controller.ensureInitialized();

  const placeholder = await mock.simulateNewTab({ url: "about:newtab" });
  const state = await mock.browser.runtime.sendMessage({
    type: "GET_PICKER_STATE",
  });
  const popupId = controller.getActiveSession().popupWindowId;

  await mock.browser.windows.update(10, { focused: false });

  const res = await mock.browser.runtime.sendMessage({
    type: "OPEN_OPTIONS",
    sessionId: state.sessionId,
  });

  assert.equal(res.ok, true);
  assert.equal(mock.getOpenOptionsCalls(), 1);
  assert.equal(mock.windowsMap.has(popupId), false);
  assert.equal(mock.windowsMap.get(10).focused, true);
  assert.equal(mock.tabsMap.has(placeholder.id), true);
  assert.equal(controller.getActiveSession(), null);

  controller.destroy();
});

test("15. All popup close paths purge popup window from sessions.recentlyClosed and keep user tab at index 0", async () => {
  let fakeNow = 1000;
  const mock = createMockBrowser();
  const controller = createBackgroundController(mock.browser, {
    blurGraceMs: 250,
    now: () => fakeNow,
  });
  await controller.ensureInitialized();

  await mock.simulateClosedUserTab("https://example.com");
  assert.equal(mock.recentlyClosed.length, 1);
  assert.equal(mock.recentlyClosed[0].tab.url, "https://example.com");

  // 1) Picking Default
  await mock.simulateNewTab({ url: "about:newtab" });
  const s1 = await mock.browser.runtime.sendMessage({ type: "GET_PICKER_STATE" });
  await mock.browser.runtime.sendMessage({
    type: "PICK_CONTAINER",
    sessionId: s1.sessionId,
    cookieStoreId: "firefox-default",
  });
  assert.equal(mock.recentlyClosed.length, 1);
  assert.equal(mock.recentlyClosed[0].tab.url, "https://example.com");

  // 2) Picking a named container
  await mock.simulateNewTab({ url: "about:newtab" });
  const s2 = await mock.browser.runtime.sendMessage({ type: "GET_PICKER_STATE" });
  await mock.browser.runtime.sendMessage({
    type: "PICK_CONTAINER",
    sessionId: s2.sessionId,
    cookieStoreId: "firefox-container-2",
  });
  assert.equal(mock.recentlyClosed.length, 1);
  assert.equal(mock.recentlyClosed[0].tab.url, "https://example.com");

  // 3) Pressing Escape
  await mock.simulateNewTab({ url: "about:newtab" });
  const s3 = await mock.browser.runtime.sendMessage({ type: "GET_PICKER_STATE" });
  await mock.browser.runtime.sendMessage({
    type: "CANCEL_ESCAPE",
    sessionId: s3.sessionId,
  });
  assert.equal(mock.recentlyClosed.length, 1);
  assert.equal(mock.recentlyClosed[0].tab.url, "https://example.com");

  // 4) Blur-dismiss by focusing parent window past grace period
  await mock.simulateNewTab({ url: "about:newtab" });
  fakeNow += 300;
  await mock.browser.windows.onFocusChanged.emit(10);
  assert.equal(mock.recentlyClosed.length, 1);
  assert.equal(mock.recentlyClosed[0].tab.url, "https://example.com");

  // 5) External popup window close
  await mock.simulateNewTab({ url: "about:newtab" });
  const popupId = controller.getActiveSession().popupWindowId;
  await mock.browser.windows.remove(popupId);
  assert.equal(mock.recentlyClosed.length, 1);
  assert.equal(mock.recentlyClosed[0].tab.url, "https://example.com");

  assert.equal(mock.forgottenWindowsLog.length, 5);
  assert.equal(new Set(mock.forgottenWindowsLog).size, 5);

  controller.destroy();
});

test("16. Initialization sweeps pre-existing closed picker popups without touching user sessions or deadlocking", async () => {
  const mock = createMockBrowser({
    recentlyClosed: [
      {
        window: {
          sessionId: "stale-picker-win",
          tabs: [
            {
              url: "moz-extension://test-uuid/src/picker/picker.html?session=old",
            },
          ],
        },
      },
      {
        window: {
          sessionId: "user-win",
          tabs: [{ url: "https://mozilla.org" }],
        },
      },
      {
        tab: {
          windowId: 10,
          sessionId: "user-tab",
          url: "https://example.com",
        },
      },
    ],
  });

  const controller = createBackgroundController(mock.browser);
  await controller.ensureInitialized();

  assert.deepEqual(mock.forgottenWindowsLog, ["stale-picker-win"]);
  assert.equal(mock.recentlyClosed.length, 2);
  assert.equal(mock.recentlyClosed[0].window.sessionId, "user-win");
  assert.equal(mock.recentlyClosed[1].tab.sessionId, "user-tab");

  // Late sessions.onChanged event for an external picker closure also sweeps cleanly
  mock.recentlyClosed.unshift({
    window: {
      sessionId: "late-picker-win",
      tabs: [
        {
          url: "moz-extension://test-uuid/src/picker/picker.html?session=late",
        },
      ],
    },
  });
  await mock.browser.sessions.onChanged.emit();
  assert.deepEqual(mock.forgottenWindowsLog, [
    "stale-picker-win",
    "late-picker-win",
  ]);
  assert.equal(mock.recentlyClosed.length, 2);

  controller.destroy();
});
