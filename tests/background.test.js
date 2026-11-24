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
  let nextSessionId = 1;

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
  const grantedPermissions = new Set(
    initial.permissions ?? ["tabs", "sessions"]
  );
  const grantedOrigins = new Set(initial.origins ?? []);
  const recentlyClosed = (initial.recentlyClosed ?? []).map((entry) =>
    structuredClone(entry)
  );
  const tabSessionValues = new Map();
  const closedSessionValues = new Map();

  const createdTabsLog = [];
  const updatedTabsLog = [];
  const removedTabsLog = [];
  const forgottenWindowsLog = [];
  const forgottenTabsLog = [];
  const commandsUpdateLog = [];
  let commandShortcut = initial.shortcut ?? "Ctrl+Shift+U";

  const tabsOnCreated = createEventEmitter();
  const tabsOnUpdated = createEventEmitter();
  const tabsOnRemoved = createEventEmitter();
  const windowsOnRemoved = createEventEmitter();
  const sessionsOnChanged = createEventEmitter();
  const permissionsOnAdded = createEventEmitter();
  const permissionsOnRemoved = createEventEmitter();
  const storageOnChanged = createEventEmitter();
  const runtimeOnInstalled = createEventEmitter();
  const runtimeOnStartup = createEventEmitter();
  const runtimeOnMessage = createEventEmitter();
  const webRequestListeners = new Map();

  const webRequestApi = {
    onBeforeRequest: {
      addListener(fn, filter, extraInfoSpec) {
        webRequestListeners.set(fn, { filter, extraInfoSpec });
      },
      removeListener(fn) {
        webRequestListeners.delete(fn);
      },
      hasListener(fn) {
        return webRequestListeners.has(fn);
      },
    },
  };

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

  const sessionsApi = {
    onChanged: sessionsOnChanged,
    async getRecentlyClosed() {
      return recentlyClosed.map((entry) => structuredClone(entry));
    },
    async setTabValue(tabId, key, value) {
      let store = tabSessionValues.get(tabId);
      if (!store) {
        store = new Map();
        tabSessionValues.set(tabId, store);
      }
      store.set(key, structuredClone(value));
    },
    async getTabValue(tabId, key) {
      return tabSessionValues.get(tabId)?.get(key);
    },
    async forgetClosedWindow(sessionId) {
      const idx = recentlyClosed.findIndex(
        (entry) => entry.window?.sessionId === sessionId
      );
      if (idx !== -1) {
        recentlyClosed.splice(idx, 1);
      }
      closedSessionValues.delete(sessionId);
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
      closedSessionValues.delete(sessionId);
      forgottenTabsLog.push({ windowId, sessionId });
      void sessionsOnChanged.emit();
    },
  };

  const browser = {
    tabs: {
      onCreated: tabsOnCreated,
      onUpdated: tabsOnUpdated,
      onRemoved: tabsOnRemoved,
      async query() {
        return [...tabsMap.values()].map((t) => ({ ...t }));
      },
      async get(tabId) {
        const tab = tabsMap.get(tabId);
        if (!tab) throw new Error(`No tab ${tabId}`);
        return { ...tab };
      },
      async create(props) {
        const id = nextTabId++;
        const windowId = props.windowId ?? 10;
        const existingInWin = [...tabsMap.values()].filter(
          (t) => t.windowId === windowId
        );
        const tab = {
          id,
          windowId,
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
        updatedTabsLog.push({ tabId, props: { ...props }, tab: { ...tab } });
        await tabsOnUpdated.emit(tabId, { ...props }, { ...tab });
        return { ...tab };
      },
      async remove(tabId) {
        const tab = tabsMap.get(tabId);
        if (!tab) throw new Error(`No tab ${tabId}`);
        tabsMap.delete(tabId);
        const savedValues = tabSessionValues.get(tabId);
        tabSessionValues.delete(tabId);
        removedTabsLog.push(tabId);
        if (tab.url && tab.url !== "about:newtab" && tab.url !== "about:blank") {
          const sessionId = `tab-sess-${nextSessionId++}`;
          if (savedValues && savedValues.size > 0) {
            closedSessionValues.set(sessionId, new Map(savedValues));
          }
          recentlyClosed.unshift({
            tab: {
              ...tab,
              sessionId,
            },
          });
        }
        await tabsOnRemoved.emit(tabId);
        if (browser.sessions) {
          await sessionsOnChanged.emit();
        }
      },
    },
    windows: {
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
      async remove(windowId) {
        const win = windowsMap.get(windowId);
        if (!win) throw new Error(`No window ${windowId}`);
        const winTabs = [];
        const winSavedValues = [];
        for (const [tId, t] of [...tabsMap.entries()]) {
          if (t.windowId === windowId) {
            winTabs.push({ ...t });
            winSavedValues.push(
              tabSessionValues.has(tId)
                ? new Map(tabSessionValues.get(tId))
                : null
            );
            tabSessionValues.delete(tId);
            tabsMap.delete(tId);
          }
        }
        windowsMap.delete(windowId);
        const sessionId = `win-sess-${nextSessionId++}`;
        closedSessionValues.set(sessionId, winSavedValues);
        recentlyClosed.unshift({
          window: {
            ...win,
            sessionId,
            tabs: winTabs,
          },
        });
        await windowsOnRemoved.emit(windowId);
        if (browser.sessions) {
          await sessionsOnChanged.emit();
        }
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
    },
    permissions: {
      onAdded: permissionsOnAdded,
      onRemoved: permissionsOnRemoved,
      async contains({ permissions = [], origins = [] } = {}) {
        return (
          permissions.every((p) => grantedPermissions.has(p)) &&
          origins.every((o) => grantedOrigins.has(o))
        );
      },
    },
    commands: {
      async getAll() {
        return [{ name: "_execute_action", shortcut: commandShortcut }];
      },
      async update(details) {
        commandsUpdateLog.push(details);
        commandShortcut = details.shortcut;
      },
    },
    runtime: {
      onInstalled: runtimeOnInstalled,
      onStartup: runtimeOnStartup,
      onMessage: runtimeOnMessage,
      async sendMessage(message) {
        const results = await runtimeOnMessage.emit(message);
        return results[0];
      },
      getURL(path) {
        return `moz-extension://test-uuid/${path}`;
      },
    },
  };

  if (!initial.omitSessions) {
    browser.sessions = sessionsApi;
  }
  if (!initial.omitWebRequest) {
    browser.webRequest = webRequestApi;
  }

  return {
    browser,
    tabsMap,
    windowsMap,
    localStore,
    createdTabsLog,
    updatedTabsLog,
    removedTabsLog,
    recentlyClosed,
    forgottenWindowsLog,
    forgottenTabsLog,
    commandsUpdateLog,
    webRequestListeners,
    getCommandShortcut: () => commandShortcut,
    setContainersMode(mode) {
      containersMode = mode;
    },
    async grantPermissions(perms, origins = []) {
      for (const p of perms) grantedPermissions.add(p);
      for (const o of origins) grantedOrigins.add(o);
      if (perms.includes("sessions")) {
        browser.sessions = sessionsApi;
      }
      if (perms.includes("webRequest")) {
        browser.webRequest = webRequestApi;
      }
      await permissionsOnAdded.emit({ permissions: perms, origins });
    },
    async revokePermissions(perms, origins = []) {
      for (const p of perms) grantedPermissions.delete(p);
      for (const o of origins) grantedOrigins.delete(o);
      await permissionsOnRemoved.emit({ permissions: perms, origins });
    },
    async simulateBeforeRequest(details) {
      const results = [];
      for (const fn of [...webRequestListeners.keys()]) {
        results.push(await fn(details));
      }
      return results;
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
    async simulateClosedUserTab(url = "https://example.com", windowId = 10) {
      const tabSession = {
        tab: {
          windowId,
          sessionId: `tab-sess-${nextSessionId++}`,
          url,
        },
      };
      recentlyClosed.unshift(tabSession);
      if (browser.sessions) {
        await sessionsOnChanged.emit();
      }
      return structuredClone(tabSession);
    },
    async simulateUndoCloseTab({ emitSessionsChangedBeforeRequest = true } = {}) {
      const idx = recentlyClosed.findIndex((entry) => entry.tab);
      if (idx === -1) {
        return null;
      }
      const [popped] = recentlyClosed.splice(idx, 1);
      const closedTab = popped.tab;
      const savedValues = closedSessionValues.get(closedTab.sessionId);
      closedSessionValues.delete(closedTab.sessionId);

      const id = nextTabId++;
      const restoredTab = {
        id,
        windowId: closedTab.windowId ?? 10,
        index: closedTab.index ?? 0,
        url: "about:blank",
        cookieStoreId: closedTab.cookieStoreId ?? "firefox-default",
        active: true,
        incognito: false,
        pinned: false,
      };
      tabsMap.set(id, restoredTab);
      if (savedValues && savedValues.size > 0) {
        tabSessionValues.set(id, new Map(savedValues));
      }
      await tabsOnCreated.emit({ ...restoredTab });
      if (emitSessionsChangedBeforeRequest && browser.sessions) {
        await sessionsOnChanged.emit();
      }
      const responses = [];
      for (const fn of [...webRequestListeners.keys()]) {
        responses.push(
          await fn({
            tabId: id,
            type: "main_frame",
            frameId: 0,
            method: "GET",
            url: closedTab.url,
            cookieStoreId: restoredTab.cookieStoreId,
          })
        );
      }
      if (!responses.some((r) => r?.cancel)) {
        restoredTab.url = closedTab.url;
        await tabsOnUpdated.emit(
          id,
          { url: closedTab.url, status: "complete" },
          { ...restoredTab }
        );
      }
      return { tab: { ...restoredTab }, responses };
    },
    async simulateUndoCloseWindow() {
      const idx = recentlyClosed.findIndex((entry) => entry.window);
      if (idx === -1) {
        return null;
      }
      const [popped] = recentlyClosed.splice(idx, 1);
      const closedWin = popped.window;
      const winSavedValues = closedSessionValues.get(closedWin.sessionId) ?? [];
      closedSessionValues.delete(closedWin.sessionId);

      windowsMap.set(closedWin.id, {
        id: closedWin.id,
        type: closedWin.type ?? "normal",
        focused: true,
      });
      if (browser.sessions) {
        await sessionsOnChanged.emit();
      }
      const restored = [];
      for (let i = 0; i < closedWin.tabs.length; i += 1) {
        const closedTab = closedWin.tabs[i];
        const id = nextTabId++;
        const tab = {
          id,
          windowId: closedWin.id,
          index: i,
          url: "about:blank",
          cookieStoreId: closedTab.cookieStoreId ?? "firefox-default",
          active: i === 0,
          incognito: false,
          pinned: false,
        };
        tabsMap.set(id, tab);
        if (winSavedValues[i]) {
          tabSessionValues.set(id, new Map(winSavedValues[i]));
        }
        await tabsOnCreated.emit({ ...tab });
        const responses = [];
        for (const fn of [...webRequestListeners.keys()]) {
          responses.push(
            await fn({
              tabId: id,
              type: "main_frame",
              frameId: 0,
              method: "GET",
              url: closedTab.url,
              cookieStoreId: tab.cookieStoreId,
            })
          );
        }
        restored.push({ tab: { ...tab }, responses });
      }
      return restored;
    },
    tabSessionValues,
  };
}

test("1. Default openOnNewTab=false leaves about:newtab untouched; openOnNewTab=true replaces about:newtab with in-tab picker at same index", async () => {
  const mock = createMockBrowser();
  const controller = createBackgroundController(mock.browser, {
    pendingTimeoutMs: 25,
  });
  await controller.ensureInitialized();

  assert.equal(controller.isNewTabModeEnabled(), false);
  await mock.simulateNewTab({ url: "about:newtab" });
  assert.equal(mock.createdTabsLog.length, 0);

  await mock.browser.storage.local.set({ openOnNewTab: true });
  assert.equal(controller.isNewTabModeEnabled(), true);

  const placeholder = await mock.simulateNewTab({ url: "about:newtab", index: 1 });
  assert.equal(mock.createdTabsLog.length, 1);
  assert.deepEqual(mock.createdTabsLog[0].props, {
    windowId: 10,
    index: 1,
    url: "moz-extension://test-uuid/src/picker/picker.html?mode=tab",
    active: true,
  });
  assert.equal(mock.tabsMap.has(placeholder.id), false);
  const pickerTabId = mock.createdTabsLog[0].tab.id;
  assert.equal(mock.tabsMap.has(pickerTabId), true);

  controller.destroy();
});

test("2. about:blank transitions to about:newtab trigger picker, while external links and Customize Toolbar are never hijacked", async () => {
  const mock = createMockBrowser({
    localStorage: { openOnNewTab: true },
  });
  const controller = createBackgroundController(mock.browser, {
    pendingTimeoutMs: 40,
  });
  await controller.ensureInitialized();

  // Fast external link: about:blank -> https://example.com
  const fastExternalTab = await mock.simulateNewTab({ url: "about:blank" });
  assert.equal(mock.createdTabsLog.length, 0);
  await mock.simulateTabUpdate(fastExternalTab.id, { url: "https://example.com" });
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(mock.createdTabsLog.length, 0);
  assert.equal(mock.tabsMap.has(fastExternalTab.id), true);

  // Slow external app link: stays about:blank past pendingTimeoutMs before redirecting/committing
  const slowExternalTab = await mock.simulateNewTab({
    url: "about:blank",
    status: "loading",
  });
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(mock.createdTabsLog.length, 0);
  assert.equal(mock.tabsMap.has(slowExternalTab.id), true);
  await mock.simulateTabUpdate(slowExternalTab.id, {
    url: "https://docs.example.com/landing",
    status: "complete",
  });
  assert.equal(mock.createdTabsLog.length, 0);
  assert.equal(mock.tabsMap.has(slowExternalTab.id), true);

  // External link with pendingUrl already set alongside about:blank
  const pendingUrlTab = await mock.simulateNewTab({
    url: "about:blank",
    pendingUrl: "https://external.example.org",
  });
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(mock.createdTabsLog.length, 0);
  assert.equal(mock.tabsMap.has(pendingUrlTab.id), true);

  // Firefox "Customize Toolbar" tab: remains about:blank and fires status=complete
  const customizeTab = await mock.simulateNewTab({
    url: "about:blank",
    title: "Customize Firefox",
  });
  await mock.simulateTabUpdate(customizeTab.id, { status: "complete" });
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(mock.createdTabsLog.length, 0);
  assert.equal(mock.tabsMap.has(customizeTab.id), true);

  // Real Cmd+T new tab: about:blank (even after initial complete) -> about:newtab
  const blankToNewTab = await mock.simulateNewTab({ url: "about:blank" });
  await mock.simulateTabUpdate(blankToNewTab.id, { status: "complete" });
  assert.equal(mock.createdTabsLog.length, 0);
  await mock.simulateTabUpdate(blankToNewTab.id, { url: "about:newtab" });
  assert.equal(mock.createdTabsLog.length, 1);
  assert.equal(
    mock.createdTabsLog[0].props.url,
    "moz-extension://test-uuid/src/picker/picker.html?mode=tab"
  );
  assert.equal(mock.tabsMap.has(blankToNewTab.id), false);

  controller.destroy();
});

test("3. Closing an in-tab picker tab purges it from sessions.recentlyClosed and keeps closed user tab at index 0", async () => {
  const mock = createMockBrowser({
    localStorage: { openOnNewTab: true },
  });
  const controller = createBackgroundController(mock.browser);
  await controller.ensureInitialized();

  await mock.simulateClosedUserTab("https://example.com");
  assert.equal(mock.recentlyClosed.length, 1);
  assert.equal(mock.recentlyClosed[0].tab.url, "https://example.com");

  await mock.simulateNewTab({ url: "about:newtab" });
  const pickerTabId = mock.createdTabsLog[0].tab.id;

  await mock.browser.tabs.remove(pickerTabId);

  assert.equal(mock.forgottenTabsLog.length, 1);
  assert.equal(mock.recentlyClosed.length, 1);
  assert.equal(mock.recentlyClosed[0].tab.url, "https://example.com");

  controller.destroy();
});

test("4. Tabs created with openerTabId (Default/Escape replacement) are ignored and never re-trigger picker", async () => {
  const mock = createMockBrowser({
    localStorage: { openOnNewTab: true },
  });
  const controller = createBackgroundController(mock.browser);
  await controller.ensureInitialized();

  await mock.simulateNewTab({ url: "about:newtab" });
  const pickerTabId = mock.createdTabsLog[0].tab.id;

  const defaultTab = await mock.browser.tabs.create({
    windowId: 10,
    index: 1,
    active: true,
    openerTabId: pickerTabId,
  });
  await mock.browser.tabs.remove(pickerTabId);

  assert.equal(mock.createdTabsLog.length, 2);
  assert.equal(mock.tabsMap.has(defaultTab.id), true);
  assert.equal(mock.tabsMap.has(pickerTabId), false);

  controller.destroy();
});

test("4b. Toolbar popup choosing Default announces its own new tab, which is not replaced by the in-tab picker", async () => {
  const mock = createMockBrowser({
    localStorage: { openOnNewTab: true },
  });
  const controller = createBackgroundController(mock.browser);
  await controller.ensureInitialized();

  const response = await mock.browser.runtime.sendMessage({
    type: "expect-own-new-tab",
  });
  assert.deepEqual(response, { ok: true });

  const ownTab = await mock.simulateNewTab({ url: "about:newtab" });
  assert.equal(mock.createdTabsLog.length, 0);
  assert.equal(mock.tabsMap.has(ownTab.id), true);

  // The expectation is consumed once; a later user Cmd+T is still intercepted.
  await mock.simulateNewTab({ url: "about:newtab" });
  assert.equal(mock.createdTabsLog.length, 1);

  controller.destroy();
});

test("5. Containers disabled/empty, single-tab windows, incognito, pinned, and container tabs never trigger picker", async () => {
  const mock = createMockBrowser({
    localStorage: { openOnNewTab: true },
    containersMode: "disabled-throw",
  });
  const controller = createBackgroundController(mock.browser);
  await controller.ensureInitialized();

  await mock.simulateNewTab({ url: "about:newtab" });
  assert.equal(mock.createdTabsLog.length, 0);

  mock.setContainersMode("empty");
  await mock.simulateNewTab({ url: "about:newtab" });
  assert.equal(mock.createdTabsLog.length, 0);

  mock.setContainersMode("enabled");
  await mock.simulateNewTab({ url: "about:newtab", incognito: true });
  await mock.simulateNewTab({ url: "about:newtab", pinned: true });
  await mock.simulateNewTab({
    url: "about:newtab",
    cookieStoreId: "firefox-container-1",
  });
  assert.equal(mock.createdTabsLog.length, 0);

  mock.windowsMap.set(20, { id: 20, type: "normal", focused: true });
  await mock.simulateNewTab({ windowId: 20, url: "about:newtab" });
  assert.equal(mock.createdTabsLog.length, 0);

  controller.destroy();
});

test("6. Turning openOnNewTab off stops new-tab interception immediately", async () => {
  const mock = createMockBrowser({
    localStorage: { openOnNewTab: true },
  });
  const controller = createBackgroundController(mock.browser);
  await controller.ensureInitialized();

  assert.equal(controller.isNewTabModeEnabled(), true);
  await mock.browser.storage.local.set({ openOnNewTab: false });
  assert.equal(controller.isNewTabModeEnabled(), false);

  await mock.simulateNewTab({ url: "about:newtab" });
  assert.equal(mock.createdTabsLog.length, 0);

  controller.destroy();
});

test("6b. Global on/off switch suspends interception, keeps preferences, and shows an OFF badge", async () => {
  const mock = createMockBrowser({
    localStorage: { openOnNewTab: true, extensionEnabled: false },
  });
  const badgeLog = [];
  mock.browser.action = {
    async setBadgeText(details) {
      badgeLog.push(details.text);
    },
    async setBadgeBackgroundColor() {},
  };
  const controller = createBackgroundController(mock.browser);
  await controller.ensureInitialized();

  assert.equal(controller.isExtensionEnabled(), false);
  assert.equal(controller.isNewTabModeEnabled(), false);
  assert.equal(badgeLog.at(-1), "OFF");
  await mock.simulateNewTab({ url: "about:newtab" });
  assert.equal(mock.createdTabsLog.length, 0);

  await mock.browser.storage.local.set({ extensionEnabled: true });
  assert.equal(controller.isExtensionEnabled(), true);
  assert.equal(controller.isNewTabModeEnabled(), true);
  assert.equal(controller.getSettings().openOnNewTab, true);
  assert.equal(badgeLog.at(-1), "");

  await mock.simulateNewTab({ url: "about:newtab", index: 1 });
  assert.equal(mock.createdTabsLog.length, 1);

  controller.destroy();
});

test("7. Optional permissions lifecycle handles startup without tabs without deadlocking, dynamic sessions grant, and tabs revocation without touching shortcut", async () => {
  const startupMock = createMockBrowser({
    localStorage: { openOnNewTab: true },
    shortcut: "Ctrl+Shift+Y",
    permissions: [],
    omitSessions: true,
  });
  const startupCtrl = createBackgroundController(startupMock.browser);
  await startupCtrl.ensureInitialized();

  assert.equal(startupCtrl.isNewTabModeEnabled(), false);
  assert.equal(startupMock.localStore.openOnNewTab, false);
  assert.equal(startupMock.commandsUpdateLog.length, 0);
  assert.equal(startupMock.getCommandShortcut(), "Ctrl+Shift+Y");

  startupMock.recentlyClosed.unshift({
    tab: {
      windowId: 10,
      sessionId: "stale-picker-tab",
      url: "moz-extension://test-uuid/src/picker/picker.html?mode=tab",
    },
  });
  await startupMock.grantPermissions(["tabs", "sessions"]);
  assert.deepEqual(startupMock.forgottenTabsLog, [
    { windowId: 10, sessionId: "stale-picker-tab" },
  ]);
  startupCtrl.destroy();

  const revokeMock = createMockBrowser({
    localStorage: { openOnNewTab: true },
    shortcut: "Ctrl+Shift+Y",
    permissions: ["tabs", "sessions"],
  });
  const revokeCtrl = createBackgroundController(revokeMock.browser);
  await revokeCtrl.ensureInitialized();

  await revokeMock.revokePermissions(["tabs"]);
  assert.equal(revokeCtrl.isNewTabModeEnabled(), false);
  assert.equal(revokeMock.localStore.openOnNewTab, false);
  assert.equal(revokeMock.commandsUpdateLog.length, 0);
  assert.equal(revokeMock.getCommandShortcut(), "Ctrl+Shift+Y");

  revokeCtrl.destroy();
});

test("8. Initialization sweeps pre-existing closed picker tabs and windows without touching user sessions or deadlocking", async () => {
  const mock = createMockBrowser({
    recentlyClosed: [
      {
        tab: {
          windowId: 10,
          sessionId: "stale-picker-tab",
          url: "moz-extension://test-uuid/src/picker/picker.html?mode=tab",
        },
      },
      {
        window: {
          sessionId: "stale-picker-win",
          tabs: [
            {
              url: "moz-extension://test-uuid/src/picker/picker.html?session=legacy",
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

  assert.deepEqual(mock.forgottenTabsLog, [
    { windowId: 10, sessionId: "stale-picker-tab" },
  ]);
  assert.deepEqual(mock.forgottenWindowsLog, ["stale-picker-win"]);
  assert.equal(mock.recentlyClosed.length, 2);
  assert.equal(mock.recentlyClosed[0].window.sessionId, "user-win");
  assert.equal(mock.recentlyClosed[1].tab.sessionId, "user-tab");

  mock.recentlyClosed.unshift({
    tab: {
      windowId: 10,
      sessionId: "late-picker-tab",
      url: "moz-extension://test-uuid/src/picker/picker.html?mode=tab",
    },
  });
  await mock.browser.sessions.onChanged.emit();
  assert.deepEqual(mock.forgottenTabsLog, [
    { windowId: 10, sessionId: "stale-picker-tab" },
    { windowId: 10, sessionId: "late-picker-tab" },
  ]);
  assert.equal(mock.recentlyClosed.length, 2);

  controller.destroy();
});

test("9. Opt-in openOnExternalLink intercepts external links before loading, opens picker with target URL, and ignores Customize Toolbar, page links, and Default replacements", async () => {
  const mock = createMockBrowser({
    permissions: ["tabs", "sessions", "webRequest", "webRequestBlocking"],
    origins: ["http://*/*", "https://*/*"],
  });
  const controller = createBackgroundController(mock.browser);
  await controller.ensureInitialized();

  // Disabled by default: webRequest listener is NOT attached
  assert.equal(controller.isExternalLinkModeEnabled(), false);
  assert.equal(mock.webRequestListeners.size, 0);

  // Enable opt-in setting -> attaches blocking webRequest listener
  await mock.browser.storage.local.set({ openOnExternalLink: true });
  assert.equal(controller.isExternalLinkModeEnabled(), true);
  assert.equal(mock.webRequestListeners.size, 1);

  // External app opens a link -> starts about:blank, then main_frame GET request fires
  const externalTab = await mock.simulateNewTab({ url: "about:blank" });
  const targetUrl = "https://auth.example.com/magic?token=one-time";
  const responses = await mock.simulateBeforeRequest({
    tabId: externalTab.id,
    type: "main_frame",
    frameId: 0,
    method: "GET",
    url: targetUrl,
    cookieStoreId: "firefox-default",
  });
  assert.deepEqual(responses, [{ cancel: true }]);

  // Next tick navigates that exact tab to picker.html?mode=tab&url=...
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(mock.updatedTabsLog.length, 1);
  assert.equal(mock.updatedTabsLog[0].tabId, externalTab.id);
  assert.equal(
    mock.updatedTabsLog[0].props.url,
    `moz-extension://test-uuid/src/picker/picker.html?mode=tab&url=${encodeURIComponent(targetUrl)}`
  );

  // User picks Default (or presses Escape): tab created with openerTabId is NOT re-intercepted
  const defaultReopen = await mock.browser.tabs.create({
    windowId: 10,
    index: externalTab.index,
    url: targetUrl,
    active: true,
    openerTabId: externalTab.id,
  });
  const reopenResponses = await mock.simulateBeforeRequest({
    tabId: defaultReopen.id,
    type: "main_frame",
    frameId: 0,
    method: "GET",
    url: targetUrl,
    cookieStoreId: "firefox-default",
  });
  assert.deepEqual(reopenResponses, [{}]);

  // Customize Toolbar stays about:blank and is never touched
  const customizeTab = await mock.simulateNewTab({
    url: "about:blank",
    title: "Customize Firefox",
  });
  await mock.simulateTabUpdate(customizeTab.id, { status: "complete" });
  assert.equal(mock.tabsMap.get(customizeTab.id).url, "about:blank");

  // Normal Cmd+T (with openOnNewTab=false) followed by typing a URL is NOT intercepted
  const normalNewTab = await mock.simulateNewTab({ url: "about:blank" });
  await mock.simulateTabUpdate(normalNewTab.id, { url: "about:newtab" });
  const typedRes = await mock.simulateBeforeRequest({
    tabId: normalNewTab.id,
    type: "main_frame",
    frameId: 0,
    method: "GET",
    url: "https://mozilla.org/",
    cookieStoreId: "firefox-default",
  });
  assert.deepEqual(typedRes, [{}]);

  // Second external link opened while a container tab is active (Firefox inherits container)
  const inheritedContainerTab = await mock.simulateNewTab({
    url: "about:blank",
    cookieStoreId: "firefox-container-2",
    index: 3,
  });
  const secondUrl = "https://github.com/supernormalco/supermono/pull/2994";
  const secondResponses = await mock.simulateBeforeRequest({
    tabId: inheritedContainerTab.id,
    type: "main_frame",
    frameId: 0,
    method: "GET",
    url: secondUrl,
    cookieStoreId: "firefox-container-2",
  });
  assert.deepEqual(secondResponses, [{ cancel: true }]);

  await new Promise((r) => setTimeout(r, 10));
  // Picker opens in Default container at the same index and closes the placeholder container tab
  const createdPickerForSecond = mock.createdTabsLog.at(-1);
  assert.equal(
    createdPickerForSecond.props.url,
    `moz-extension://test-uuid/src/picker/picker.html?mode=tab&url=${encodeURIComponent(secondUrl)}`
  );
  assert.equal(createdPickerForSecond.props.index, 3);
  assert.equal(createdPickerForSecond.tab.cookieStoreId, "firefox-default");
  assert.equal(mock.tabsMap.has(inheritedContainerTab.id), false);

  // Picker notifies background before creating chosen container tab -> allowed without looping
  await mock.browser.runtime.sendMessage({
    type: "allow-external-url",
    url: secondUrl,
    cookieStoreId: "firefox-container-2",
  });
  const chosenContainerTab = await mock.browser.tabs.create({
    windowId: 10,
    index: 3,
    url: secondUrl,
    cookieStoreId: "firefox-container-2",
    active: true,
  });
  const chosenResponses = await mock.simulateBeforeRequest({
    tabId: chosenContainerTab.id,
    type: "main_frame",
    frameId: 0,
    method: "GET",
    url: secondUrl,
    cookieStoreId: "firefox-container-2",
  });
  assert.deepEqual(chosenResponses, [{}]);

  // Disabling openOnExternalLink detaches webRequest listener immediately
  await mock.browser.storage.local.set({ openOnExternalLink: false });
  assert.equal(controller.isExternalLinkModeEnabled(), false);
  assert.equal(mock.webRequestListeners.size, 0);

  controller.destroy();
});

test("10. openOnExternalLink disables cleanly when webRequest or origin permissions are missing or revoked", async () => {
  // Startup with stored openOnExternalLink=true but missing origins -> disables automatically
  const startupMock = createMockBrowser({
    localStorage: { openOnExternalLink: true },
    permissions: ["tabs", "sessions"],
    origins: [],
    omitWebRequest: true,
  });
  const startupCtrl = createBackgroundController(startupMock.browser);
  await startupCtrl.ensureInitialized();
  assert.equal(startupCtrl.isExternalLinkModeEnabled(), false);
  assert.equal(startupMock.localStore.openOnExternalLink, false);
  assert.equal(startupMock.webRequestListeners.size, 0);
  startupCtrl.destroy();

  // Revoking host origins at runtime disables openOnExternalLink and detaches listener
  const revokeMock = createMockBrowser({
    localStorage: { openOnExternalLink: true, openOnNewTab: true },
    permissions: ["tabs", "sessions", "webRequest", "webRequestBlocking"],
    origins: ["http://*/*", "https://*/*"],
  });
  const revokeCtrl = createBackgroundController(revokeMock.browser);
  await revokeCtrl.ensureInitialized();
  assert.equal(revokeCtrl.isExternalLinkModeEnabled(), true);
  assert.equal(revokeMock.webRequestListeners.size, 1);

  await revokeMock.revokePermissions([], ["https://*/*"]);
  assert.equal(revokeCtrl.isExternalLinkModeEnabled(), false);
  assert.equal(revokeMock.localStore.openOnExternalLink, false);
  assert.equal(revokeMock.webRequestListeners.size, 0);
  // openOnNewTab remains unaffected when only host origins are revoked
  assert.equal(revokeCtrl.isNewTabModeEnabled(), true);

  revokeCtrl.destroy();
});

test("11. webRequest listener attaches synchronously at startup for MV3 wake-up and intercepts even when onBeforeRequest beats tabs.onCreated or sessions purge is slow", async () => {
  const mock = createMockBrowser({
    localStorage: { openOnExternalLink: true },
    permissions: ["tabs", "sessions", "webRequest", "webRequestBlocking"],
    origins: ["http://*/*", "https://*/*"],
  });

  // Make sessions.getRecentlyClosed hang until released to verify onBeforeRequest does not block on it
  let releaseSessions;
  mock.browser.sessions.getRecentlyClosed = () =>
    new Promise((resolve) => {
      releaseSessions = () => resolve([]);
    });

  // Listener MUST be attached synchronously right inside createBackgroundController (before any await)
  const controller = createBackgroundController(mock.browser);
  assert.equal(mock.webRequestListeners.size, 1);

  // Cold wake-up: external link fires BEFORE ensureInitialized() / sessions purge completes
  const coldTabId = 500;
  mock.tabsMap.set(coldTabId, {
    id: coldTabId,
    windowId: 10,
    index: 1,
    url: "about:blank",
    cookieStoreId: "firefox-default",
    active: true,
    incognito: false,
    pinned: false,
  });
  const coldUrl = "https://slack.example.com/cold-wake";
  const coldRes = await mock.simulateBeforeRequest({
    tabId: coldTabId,
    type: "main_frame",
    frameId: 0,
    method: "GET",
    url: coldUrl,
    cookieStoreId: "firefox-default",
  });
  assert.deepEqual(coldRes, [{ cancel: true }]);

  // Release sessions purge and finish initialization
  releaseSessions();
  await controller.ensureInitialized();

  // Warm race: onBeforeRequest arrives BEFORE tabs.onCreated for a brand-new about:blank tab
  const warmRaceTabId = 501;
  mock.tabsMap.set(warmRaceTabId, {
    id: warmRaceTabId,
    windowId: 10,
    index: 2,
    url: "about:blank",
    cookieStoreId: "firefox-default",
    active: true,
    incognito: false,
    pinned: false,
  });
  const warmUrl = "https://github.com/org/repo/issues/42";
  const warmRes = await mock.simulateBeforeRequest({
    tabId: warmRaceTabId,
    type: "main_frame",
    frameId: 0,
    method: "GET",
    url: warmUrl,
    cookieStoreId: "firefox-default",
  });
  assert.deepEqual(warmRes, [{ cancel: true }]);

  await new Promise((r) => setTimeout(r, 10));
  assert.equal(mock.updatedTabsLog.length, 2);
  assert.equal(mock.updatedTabsLog[0].tabId, coldTabId);
  assert.equal(
    mock.updatedTabsLog[0].props.url,
    `moz-extension://test-uuid/src/picker/picker.html?mode=tab&url=${encodeURIComponent(coldUrl)}`
  );
  assert.equal(mock.updatedTabsLog[1].tabId, warmRaceTabId);
  assert.equal(
    mock.updatedTabsLog[1].props.url,
    `moz-extension://test-uuid/src/picker/picker.html?mode=tab&url=${encodeURIComponent(warmUrl)}`
  );

  controller.destroy();
});

test("12. If the picker cannot be shown after cancelling an external link, the original URL is restored instead of lost", async () => {
  const mock = createMockBrowser({
    localStorage: { openOnExternalLink: true },
    permissions: ["tabs", "sessions", "webRequest", "webRequestBlocking"],
    origins: ["http://*/*", "https://*/*"],
  });
  const controller = createBackgroundController(mock.browser);
  await controller.ensureInitialized();

  // Navigating to the picker page fails (e.g. tab is in a transient state)
  const originalUpdate = mock.browser.tabs.update;
  mock.browser.tabs.update = async (tabId, props) => {
    if (String(props.url).startsWith("moz-extension://")) {
      throw new Error("Cannot navigate to picker");
    }
    return originalUpdate(tabId, props);
  };

  const externalTab = await mock.simulateNewTab({ url: "about:blank" });
  const targetUrl = "https://docs.example.com/shared/doc-1";
  const responses = await mock.simulateBeforeRequest({
    tabId: externalTab.id,
    type: "main_frame",
    frameId: 0,
    method: "GET",
    url: targetUrl,
    cookieStoreId: "firefox-default",
  });
  assert.deepEqual(responses, [{ cancel: true }]);

  await new Promise((r) => setTimeout(r, 10));
  assert.equal(mock.updatedTabsLog.length, 1);
  assert.equal(mock.updatedTabsLog[0].tabId, externalTab.id);
  assert.equal(mock.updatedTabsLog[0].props.url, targetUrl);

  // The restored navigation is allowed through rather than intercepted again
  const restoredResponses = await mock.simulateBeforeRequest({
    tabId: externalTab.id,
    type: "main_frame",
    frameId: 0,
    method: "GET",
    url: targetUrl,
    cookieStoreId: "firefox-default",
  });
  assert.deepEqual(restoredResponses, [{}]);

  controller.destroy();
});

test("13. Container-inherited external link restores the URL in its original tab when the picker tab cannot be created", async () => {
  const mock = createMockBrowser({
    localStorage: { openOnExternalLink: true },
    permissions: ["tabs", "sessions", "webRequest", "webRequestBlocking"],
    origins: ["http://*/*", "https://*/*"],
  });
  const controller = createBackgroundController(mock.browser);
  await controller.ensureInitialized();

  const externalTab = await mock.simulateNewTab({
    url: "about:blank",
    cookieStoreId: "firefox-container-2",
  });

  mock.browser.tabs.create = async () => {
    throw new Error("Cannot create picker tab");
  };

  const targetUrl = "https://jira.example.com/browse/ABC-1";
  const responses = await mock.simulateBeforeRequest({
    tabId: externalTab.id,
    type: "main_frame",
    frameId: 0,
    method: "GET",
    url: targetUrl,
    cookieStoreId: "firefox-container-2",
  });
  assert.deepEqual(responses, [{ cancel: true }]);

  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(mock.removedTabsLog, []);
  assert.equal(mock.updatedTabsLog.length, 1);
  assert.equal(mock.updatedTabsLog[0].tabId, externalTab.id);
  assert.equal(mock.updatedTabsLog[0].props.url, targetUrl);

  controller.destroy();
});

test("14. Cmd+Shift+T on closed container or Default tabs restores them directly without triggering the external-link picker or looping", async () => {
  const mock = createMockBrowser({
    localStorage: { openOnNewTab: true, openOnExternalLink: true },
    permissions: ["tabs", "sessions", "webRequest", "webRequestBlocking"],
    origins: ["http://*/*", "https://*/*"],
  });
  const controller = createBackgroundController(mock.browser);
  await controller.ensureInitialized();

  // Open a tab in Social container (firefox-container-2), settle on about:newtab, visit reddit.com, then close it
  const socialTab = await mock.browser.tabs.create({
    windowId: 10,
    cookieStoreId: "firefox-container-2",
    url: "about:blank",
    active: true,
  });
  await mock.simulateTabUpdate(socialTab.id, { url: "about:newtab" });
  const typedUrl = "https://www.reddit.com/";
  const navRes = await mock.simulateBeforeRequest({
    tabId: socialTab.id,
    type: "main_frame",
    frameId: 0,
    method: "GET",
    url: typedUrl,
    cookieStoreId: "firefox-container-2",
  });
  assert.deepEqual(navRes, [{}]);
  await mock.simulateTabUpdate(socialTab.id, {
    url: typedUrl,
    status: "complete",
  });

  // Close the container tab
  await mock.browser.tabs.remove(socialTab.id);
  assert.equal(mock.recentlyClosed.length, 1);

  const createdBefore = mock.createdTabsLog.length;
  const updatedBefore = mock.updatedTabsLog.length;

  // Cmd+Shift+T (even when onBeforeRequest races ahead of sessions.onChanged)
  const restored = await mock.simulateUndoCloseTab({
    emitSessionsChangedBeforeRequest: false,
  });
  assert.ok(restored);
  assert.deepEqual(restored.responses, [{}]);
  await new Promise((r) => setTimeout(r, 10));

  // No picker tab was opened, restored tab was NOT removed, and recentlyClosed is now empty (no infinite loop!)
  assert.equal(mock.createdTabsLog.length, createdBefore);
  assert.equal(mock.updatedTabsLog.length, updatedBefore);
  assert.equal(mock.tabsMap.has(restored.tab.id), true);
  assert.equal(mock.recentlyClosed.length, 0);

  // Second Cmd+Shift+T has nothing left to restore
  assert.equal(await mock.simulateUndoCloseTab(), null);

  // Closing and restoring a Default tab also works without hijacking
  const defaultTab = await mock.simulateNewTab({
    url: "about:blank",
    cookieStoreId: "firefox-default",
    openerTabId: 1,
  });
  await mock.simulateTabUpdate(defaultTab.id, {
    url: "https://news.ycombinator.com/",
    status: "complete",
  });
  await mock.browser.tabs.remove(defaultTab.id);

  const restoredDefault = await mock.simulateUndoCloseTab();
  assert.deepEqual(restoredDefault.responses, [{}]);
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(mock.updatedTabsLog.length, updatedBefore);
  assert.equal(mock.recentlyClosed.length, 0);

  controller.destroy();
});

test("15. Cmd+Shift+T for a tab closed before extension startup and Cmd+Shift+N closed windows are never hijacked", async () => {
  const mock = createMockBrowser({
    localStorage: { openOnExternalLink: true },
    permissions: ["tabs", "sessions", "webRequest", "webRequestBlocking"],
    origins: ["http://*/*", "https://*/*"],
    recentlyClosed: [
      {
        tab: {
          windowId: 10,
          sessionId: "pre-existing-closed-tab",
          url: "https://preexisting.example.com/article",
          cookieStoreId: "firefox-container-2",
        },
      },
    ],
  });
  const controller = createBackgroundController(mock.browser);
  await controller.ensureInitialized();

  // Tab closed before startup has no ntcp_seen tab value, but snapshot diff catches Cmd+Shift+T
  const restoredPreExisting = await mock.simulateUndoCloseTab({
    emitSessionsChangedBeforeRequest: false,
  });
  assert.deepEqual(restoredPreExisting.responses, [{}]);
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(mock.createdTabsLog.length, 0);
  assert.equal(mock.recentlyClosed.length, 0);

  // Close a second window with two tabs and restore it via Cmd+Shift+N
  mock.windowsMap.set(20, { id: 20, type: "normal", focused: false });
  const wTab1 = await mock.simulateNewTab({
    windowId: 20,
    url: "about:blank",
    openerTabId: 1,
    cookieStoreId: "firefox-container-1",
  });
  await mock.simulateTabUpdate(wTab1.id, {
    url: "https://win-a.example.com/",
    status: "complete",
  });
  const wTab2 = await mock.simulateNewTab({
    windowId: 20,
    url: "about:blank",
    openerTabId: 1,
    cookieStoreId: "firefox-default",
  });
  await mock.simulateTabUpdate(wTab2.id, {
    url: "https://win-b.example.com/",
    status: "complete",
  });
  await mock.browser.windows.remove(20);

  const restoredWindowTabs = await mock.simulateUndoCloseWindow();
  assert.equal(restoredWindowTabs.length, 2);
  assert.deepEqual(restoredWindowTabs[0].responses, [{}]);
  assert.deepEqual(restoredWindowTabs[1].responses, [{}]);

  controller.destroy();
});

test("16. External link for the same URL as a recently closed tab is still intercepted, and cancelled container placeholder tabs are purged from Recently Closed Tabs", async () => {
  const mock = createMockBrowser({
    localStorage: { openOnExternalLink: true },
    permissions: ["tabs", "sessions", "webRequest", "webRequestBlocking"],
    origins: ["http://*/*", "https://*/*"],
  });
  const controller = createBackgroundController(mock.browser);
  await controller.ensureInitialized();

  const targetUrl = "https://github.com/org/repo/pull/99";

  // User had targetUrl open in container 2, then closed it (WITHOUT pressing Cmd+Shift+T)
  const closedUserTab = await mock.browser.tabs.create({
    windowId: 10,
    cookieStoreId: "firefox-container-2",
    url: "about:blank",
  });
  await mock.simulateTabUpdate(closedUserTab.id, { url: "about:newtab" });
  await mock.simulateTabUpdate(closedUserTab.id, {
    url: targetUrl,
    status: "complete",
  });
  await mock.browser.tabs.remove(closedUserTab.id);
  assert.equal(mock.recentlyClosed.length, 1);

  // Now Slack opens the EXACT SAME URL in a brand-new container-inherited tab -> MUST still show picker!
  const slackTab = await mock.simulateNewTab({
    url: targetUrl,
    cookieStoreId: "firefox-container-2",
    index: 2,
  });
  const slackRes = await mock.simulateBeforeRequest({
    tabId: slackTab.id,
    type: "main_frame",
    frameId: 0,
    method: "GET",
    url: targetUrl,
    cookieStoreId: "firefox-container-2",
  });
  assert.deepEqual(slackRes, [{ cancel: true }]);

  await new Promise((r) => setTimeout(r, 15));
  // Cancelled container placeholder tab was removed AND forgotten from Recently Closed Tabs,
  // leaving only the user's originally closed tab (no duplicate closed entry!)
  assert.equal(mock.tabsMap.has(slackTab.id), false);
  assert.equal(mock.recentlyClosed.length, 1);
  assert.equal(mock.recentlyClosed[0].tab.url, targetUrl);
  assert.equal(mock.forgottenTabsLog.length, 1);

  controller.destroy();
});
