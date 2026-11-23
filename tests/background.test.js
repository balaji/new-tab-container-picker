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
  const recentlyClosed = (initial.recentlyClosed ?? []).map((entry) =>
    structuredClone(entry)
  );

  const createdTabsLog = [];
  const removedTabsLog = [];
  const forgottenWindowsLog = [];
  const forgottenTabsLog = [];
  const commandsUpdateLog = [];
  let commandShortcut = initial.shortcut ?? "Ctrl+Shift+Y";

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
  };

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
      async remove(tabId) {
        const tab = tabsMap.get(tabId);
        if (!tab) throw new Error(`No tab ${tabId}`);
        tabsMap.delete(tabId);
        removedTabsLog.push(tabId);
        if (tab.url && tab.url !== "about:newtab" && tab.url !== "about:blank") {
          recentlyClosed.unshift({
            tab: {
              ...tab,
              sessionId: `tab-sess-${nextSessionId++}`,
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
        for (const [tId, t] of [...tabsMap.entries()]) {
          if (t.windowId === windowId) {
            winTabs.push({ ...t });
            tabsMap.delete(tId);
          }
        }
        windowsMap.delete(windowId);
        recentlyClosed.unshift({
          window: {
            ...win,
            sessionId: `win-sess-${nextSessionId++}`,
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
      async contains({ permissions = [] } = {}) {
        return permissions.every((p) => grantedPermissions.has(p));
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
      getURL(path) {
        return `moz-extension://test-uuid/${path}`;
      },
    },
  };

  if (!initial.omitSessions) {
    browser.sessions = sessionsApi;
  }

  return {
    browser,
    tabsMap,
    windowsMap,
    localStore,
    createdTabsLog,
    removedTabsLog,
    recentlyClosed,
    forgottenWindowsLog,
    forgottenTabsLog,
    commandsUpdateLog,
    getCommandShortcut: () => commandShortcut,
    setContainersMode(mode) {
      containersMode = mode;
    },
    async grantPermissions(perms) {
      for (const p of perms) grantedPermissions.add(p);
      if (perms.includes("sessions")) {
        browser.sessions = sessionsApi;
      }
      await permissionsOnAdded.emit({ permissions: perms });
    },
    async revokePermissions(perms) {
      for (const p of perms) grantedPermissions.delete(p);
      await permissionsOnRemoved.emit({ permissions: perms });
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

test("7. Optional permissions lifecycle handles startup without tabs without deadlocking, dynamic sessions grant, and tabs revocation without touching shortcut", async () => {
  const startupMock = createMockBrowser({
    localStorage: { openOnNewTab: true },
    shortcut: "Ctrl+Shift+U",
    permissions: [],
    omitSessions: true,
  });
  const startupCtrl = createBackgroundController(startupMock.browser);
  await startupCtrl.ensureInitialized();

  assert.equal(startupCtrl.isNewTabModeEnabled(), false);
  assert.equal(startupMock.localStore.openOnNewTab, false);
  assert.equal(startupMock.commandsUpdateLog.length, 0);
  assert.equal(startupMock.getCommandShortcut(), "Ctrl+Shift+U");

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
    shortcut: "Ctrl+Shift+U",
    permissions: ["tabs", "sessions"],
  });
  const revokeCtrl = createBackgroundController(revokeMock.browser);
  await revokeCtrl.ensureInitialized();

  await revokeMock.revokePermissions(["tabs"]);
  assert.equal(revokeCtrl.isNewTabModeEnabled(), false);
  assert.equal(revokeMock.localStore.openOnNewTab, false);
  assert.equal(revokeMock.commandsUpdateLog.length, 0);
  assert.equal(revokeMock.getCommandShortcut(), "Ctrl+Shift+U");

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
