import test from "node:test";
import assert from "node:assert/strict";
import { createOptionsController } from "../src/options/options.js";

function createFakeOptionsDom() {
  class FakeElement {
    constructor(id) {
      this.id = id;
      this.checked = false;
      this.value = "";
      this.placeholder = "";
      this.disabled = false;
      this.dataset = {};
      this.focused = false;
      this.listeners = new Map();
    }
    addEventListener(type, fn) {
      if (!this.listeners.has(type)) this.listeners.set(type, []);
      this.listeners.get(type).push(fn);
    }
    removeEventListener(type, fn) {
      const list = this.listeners.get(type);
      if (!list) return;
      const idx = list.indexOf(fn);
      if (idx >= 0) list.splice(idx, 1);
    }
    async dispatch(type, extra = {}) {
      let prevented = false;
      let stopped = false;
      const event = {
        type,
        preventDefault() {
          prevented = true;
        },
        stopPropagation() {
          stopped = true;
        },
        ...extra,
      };
      const handlers = [...(this.listeners.get(type) ?? [])];
      await Promise.all(handlers.map((fn) => fn(event)));
      return { prevented, stopped };
    }
    async toggle(nextChecked) {
      this.checked = nextChecked;
      await this.dispatch("change");
    }
    async focus() {
      this.focused = true;
      await this.dispatch("focus");
    }
    async blur() {
      this.focused = false;
      await this.dispatch("blur");
    }
  }

  const openOnNewTabInput = new FakeElement("setting-open-on-new-tab");
  const openOnExternalLinkInput = new FakeElement(
    "setting-open-on-external-link"
  );
  const autoOpenInput = new FakeElement("setting-auto-open");
  const shortcutInput = new FakeElement("setting-shortcut");
  const resetBtn = new FakeElement("shortcut-reset");
  const clearBtn = new FakeElement("shortcut-clear");
  const statusEl = {
    id: "save-status",
    textContent: "",
    className: "save-status",
  };

  const byId = new Map([
    ["setting-open-on-new-tab", openOnNewTabInput],
    ["setting-open-on-external-link", openOnExternalLinkInput],
    ["setting-auto-open", autoOpenInput],
    ["setting-shortcut", shortcutInput],
    ["shortcut-reset", resetBtn],
    ["shortcut-clear", clearBtn],
    ["save-status", statusEl],
  ]);

  const winListeners = new Map();
  const win = {
    addEventListener(type, fn) {
      if (!winListeners.has(type)) winListeners.set(type, []);
      winListeners.get(type).push(fn);
    },
    removeEventListener(type, fn) {
      const list = winListeners.get(type);
      if (!list) return;
      const idx = list.indexOf(fn);
      if (idx >= 0) list.splice(idx, 1);
    },
    async dispatchFocus() {
      const handlers = [...(winListeners.get("focus") ?? [])];
      await Promise.all(handlers.map((fn) => fn({ type: "focus" })));
    },
  };

  const doc = {
    getElementById: (id) => byId.get(id) ?? null,
  };

  return {
    doc,
    win,
    winListeners,
    openOnNewTabInput,
    openOnExternalLinkInput,
    autoOpenInput,
    shortcutInput,
    resetBtn,
    clearBtn,
    statusEl,
  };
}

function createMockOptionsBrowser(initialStore = {}, options = {}) {
  const localStore = { ...initialStore };
  const onChangedListeners = new Set();
  let commandShortcut = options.shortcut ?? "Ctrl+Shift+U";
  const updateCalls = [];
  const resetCalls = [];
  const permissionRequestCalls = [];
  const permissionRemoveCalls = [];
  const callOrder = [];
  let hasOptionalPerms = options.hasOptionalPerms ?? true;

  const browserApi = {
    storage: {
      local: {
        async get(keys) {
          if (Array.isArray(keys)) {
            const out = {};
            for (const k of keys) {
              if (k in localStore) out[k] = localStore[k];
            }
            return out;
          }
          return { ...localStore };
        },
        async set(updates) {
          callOrder.push(["storage.set", updates]);
          if (options.failWrite) {
            throw new Error("Write failed");
          }
          const changes = {};
          for (const [k, v] of Object.entries(updates)) {
            const oldValue = localStore[k];
            localStore[k] = v;
            changes[k] = { oldValue, newValue: v };
          }
          for (const fn of [...onChangedListeners]) {
            fn(changes, "local");
          }
        },
      },
      onChanged: {
        addListener(fn) {
          onChangedListeners.add(fn);
        },
        removeListener(fn) {
          onChangedListeners.delete(fn);
        },
      },
    },
    permissions: {
      async contains() {
        return hasOptionalPerms;
      },
      async request(req) {
        callOrder.push(["permissions.request", req]);
        permissionRequestCalls.push(req);
        if (options.throwPermission) {
          throw new Error("Gesture missing");
        }
        if (options.grantPermission === false) {
          return false;
        }
        hasOptionalPerms = true;
        return true;
      },
      async remove(req) {
        callOrder.push(["permissions.remove", req]);
        permissionRemoveCalls.push(req);
        return true;
      },
    },
    commands: {
      async getAll() {
        return [{ name: "_execute_action", shortcut: commandShortcut }];
      },
      async update({ name, shortcut }) {
        callOrder.push(["commands.update", { name, shortcut }]);
        if (options.failCommandUpdate) {
          throw new Error("Shortcut in use by Firefox");
        }
        updateCalls.push({ name, shortcut });
        commandShortcut = shortcut;
      },
      async reset(name) {
        if (options.failCommandReset) {
          throw new Error("Reset failed");
        }
        resetCalls.push(name);
        commandShortcut = "Ctrl+Shift+U";
      },
    },
  };

  return {
    browserApi,
    localStore,
    onChangedListeners,
    updateCalls,
    resetCalls,
    permissionRequestCalls,
    permissionRemoveCalls,
    callOrder,
    setCommandShortcut(val) {
      commandShortcut = val;
    },
    emitExternalChange(changes, areaName = "local") {
      for (const fn of [...onChangedListeners]) {
        fn(changes, areaName);
      }
    },
  };
}

test("options page loads shortcut and toggle defaults, stored values, and permission fallback", async () => {
  const domA = createFakeOptionsDom();
  const mockA = createMockOptionsBrowser();
  const ctrlA = await createOptionsController({
    browserApi: mockA.browserApi,
    doc: domA.doc,
    win: domA.win,
    isMac: true,
  });

  assert.equal(domA.openOnNewTabInput.checked, false);
  assert.equal(domA.openOnExternalLinkInput.checked, false);
  assert.equal(domA.autoOpenInput.checked, false);
  assert.equal(domA.shortcutInput.disabled, false);
  assert.equal(domA.shortcutInput.value, "Command+Shift+U");
  assert.deepEqual(ctrlA.getState(), {
    openOnNewTab: false,
    openOnExternalLink: false,
    autoOpenSingleMatch: false,
    extensionEnabled: true,
    shortcut: "Ctrl+Shift+U",
  });
  ctrlA.destroy();

  // Stored toggles with permissions keep shortcut controls enabled alongside toggles
  const domB = createFakeOptionsDom();
  const mockB = createMockOptionsBrowser(
    {
      openOnNewTab: true,
      openOnExternalLink: true,
      autoOpenSingleMatch: true,
    },
    { shortcut: "Ctrl+Shift+Y", hasOptionalPerms: true }
  );
  const ctrlB = await createOptionsController({
    browserApi: mockB.browserApi,
    doc: domB.doc,
    win: domB.win,
    isMac: false,
  });

  assert.equal(domB.openOnNewTabInput.checked, true);
  assert.equal(domB.openOnExternalLinkInput.checked, true);
  assert.equal(domB.autoOpenInput.checked, true);
  assert.equal(domB.shortcutInput.disabled, false);
  assert.equal(domB.resetBtn.disabled, false);
  assert.equal(domB.clearBtn.disabled, false);
  assert.equal(domB.shortcutInput.value, "Ctrl+Shift+Y");
  ctrlB.destroy();

  // Stored openOnNewTab=true and openOnExternalLink=true without optional permissions fall back to false
  const domC = createFakeOptionsDom();
  const mockC = createMockOptionsBrowser(
    { openOnNewTab: true, openOnExternalLink: true },
    { hasOptionalPerms: false }
  );
  const ctrlC = await createOptionsController({
    browserApi: mockC.browserApi,
    doc: domC.doc,
    win: domC.win,
    isMac: false,
  });
  assert.equal(domC.openOnNewTabInput.checked, false);
  assert.equal(domC.openOnExternalLinkInput.checked, false);
  assert.equal(mockC.localStore.openOnNewTab, false);
  assert.equal(mockC.localStore.openOnExternalLink, false);
  ctrlC.destroy();
});

test("openOnExternalLink toggle requests webRequest and origin permissions synchronously and handles denial", async () => {
  const denyDom = createFakeOptionsDom();
  const denyMock = createMockOptionsBrowser({}, { grantPermission: false });
  const denyCtrl = await createOptionsController({
    browserApi: denyMock.browserApi,
    doc: denyDom.doc,
    win: denyDom.win,
  });

  await denyDom.openOnExternalLinkInput.toggle(true);
  assert.deepEqual(denyMock.permissionRequestCalls, [
    {
      permissions: ["tabs", "sessions", "webRequest", "webRequestBlocking"],
      origins: ["http://*/*", "https://*/*"],
    },
  ]);
  assert.equal(denyDom.openOnExternalLinkInput.checked, false);
  assert.equal(denyCtrl.getState().openOnExternalLink, false);
  assert.equal(denyMock.localStore.openOnExternalLink, undefined);
  assert.equal(
    denyDom.statusEl.textContent,
    "Permission is required to intercept external links"
  );
  assert.match(denyDom.statusEl.className, /save-status--error/);
  denyCtrl.destroy();

  const dom = createFakeOptionsDom();
  const mock = createMockOptionsBrowser();
  const ctrl = await createOptionsController({
    browserApi: mock.browserApi,
    doc: dom.doc,
    win: dom.win,
  });

  await dom.openOnExternalLinkInput.toggle(true);
  assert.equal(mock.callOrder[0][0], "permissions.request");
  assert.equal(dom.openOnExternalLinkInput.checked, true);
  assert.equal(mock.localStore.openOnExternalLink, true);
  assert.equal(dom.statusEl.textContent, "Saved");

  await dom.openOnExternalLinkInput.toggle(false);
  assert.equal(dom.openOnExternalLinkInput.checked, false);
  assert.equal(mock.localStore.openOnExternalLink, false);
  assert.equal(mock.permissionRequestCalls.length, 1);
  // Revokes all external-link optional permissions when openOnNewTab is off
  assert.deepEqual(mock.permissionRemoveCalls, [
    {
      permissions: ["tabs", "sessions", "webRequest", "webRequestBlocking"],
      origins: ["http://*/*", "https://*/*"],
    },
  ]);
  ctrl.destroy();

  // When openOnNewTab is enabled, disabling openOnExternalLink revokes only webRequest + origins and keeps tabs/sessions
  const keepDom = createFakeOptionsDom();
  const keepMock = createMockOptionsBrowser({
    openOnNewTab: true,
    openOnExternalLink: true,
  });
  const keepCtrl = await createOptionsController({
    browserApi: keepMock.browserApi,
    doc: keepDom.doc,
    win: keepDom.win,
  });

  await keepDom.openOnExternalLinkInput.toggle(false);
  assert.equal(keepDom.openOnExternalLinkInput.checked, false);
  assert.equal(keepMock.localStore.openOnExternalLink, false);
  assert.deepEqual(keepMock.permissionRemoveCalls, [
    {
      permissions: ["webRequest", "webRequestBlocking"],
      origins: ["http://*/*", "https://*/*"],
    },
  ]);
  keepCtrl.destroy();
});

test("openOnNewTab toggle requests optional permissions synchronously, handles denial, and coexists with shortcut", async () => {
  const denyDom = createFakeOptionsDom();
  const denyMock = createMockOptionsBrowser({}, { grantPermission: false });
  const denyCtrl = await createOptionsController({
    browserApi: denyMock.browserApi,
    doc: denyDom.doc,
    win: denyDom.win,
    isMac: true,
  });

  await denyDom.openOnNewTabInput.toggle(true);
  assert.deepEqual(denyMock.permissionRequestCalls, [
    { permissions: ["tabs", "sessions"] },
  ]);
  assert.equal(denyDom.openOnNewTabInput.checked, false);
  assert.equal(denyCtrl.getState().openOnNewTab, false);
  assert.equal(denyMock.localStore.openOnNewTab, undefined);
  assert.equal(denyDom.statusEl.textContent, "Permission is required to open on new tabs");
  assert.match(denyDom.statusEl.className, /save-status--error/);
  denyCtrl.destroy();

  const dom = createFakeOptionsDom();
  const mock = createMockOptionsBrowser({}, { shortcut: "Ctrl+Shift+Y" });
  const controller = await createOptionsController({
    browserApi: mock.browserApi,
    doc: dom.doc,
    win: dom.win,
    isMac: true,
  });

  await dom.openOnNewTabInput.toggle(true);
  assert.equal(mock.callOrder[0][0], "permissions.request");
  assert.equal(dom.openOnNewTabInput.checked, true);
  assert.equal(mock.localStore.openOnNewTab, true);
  // Shortcut remains enabled and completely untouched
  assert.equal(mock.updateCalls.length, 0);
  assert.equal(dom.shortcutInput.disabled, false);
  assert.equal(dom.shortcutInput.value, "Command+Shift+Y");
  assert.equal(dom.statusEl.textContent, "Saved");

  await dom.openOnNewTabInput.toggle(false);
  assert.equal(dom.openOnNewTabInput.checked, false);
  assert.equal(mock.localStore.openOnNewTab, false);
  assert.equal(mock.permissionRequestCalls.length, 1);
  assert.equal(dom.statusEl.textContent, "Saved");

  controller.destroy();
});

test("shortcut recorder captures valid combos on macOS, handles Escape/Tab/errors, and supports Reset and Clear", async () => {
  const dom = createFakeOptionsDom();
  const mock = createMockOptionsBrowser();
  const controller = await createOptionsController({
    browserApi: mock.browserApi,
    doc: dom.doc,
    win: dom.win,
    isMac: true,
    statusDurationMs: 25,
  });

  await dom.shortcutInput.focus();
  assert.equal(dom.shortcutInput.dataset.recording, "true");
  assert.equal(dom.shortcutInput.value, "");
  assert.equal(dom.shortcutInput.placeholder, "Press shortcut…");

  await dom.shortcutInput.dispatch("keydown", {
    altKey: true,
    code: "AltLeft",
    key: "Alt",
  });
  assert.equal(mock.updateCalls.length, 0);

  await dom.shortcutInput.dispatch("keydown", {
    shiftKey: true,
    code: "KeyY",
    key: "Y",
  });
  assert.equal(mock.updateCalls.length, 0);
  assert.match(dom.statusEl.className, /save-status--error/);

  const saveRes = await dom.shortcutInput.dispatch("keydown", {
    metaKey: true,
    shiftKey: true,
    code: "KeyY",
    key: "Y",
  });
  assert.equal(saveRes.prevented, true);
  assert.equal(saveRes.stopped, true);
  assert.deepEqual(mock.updateCalls, [
    { name: "_execute_action", shortcut: "Command+Shift+Y" },
  ]);
  assert.equal(dom.shortcutInput.value, "Command+Shift+Y");
  assert.equal(dom.statusEl.textContent, "Shortcut saved");

  await dom.shortcutInput.focus();
  const tabRes = await dom.shortcutInput.dispatch("keydown", { key: "Tab" });
  assert.equal(tabRes.prevented, false);

  await dom.shortcutInput.dispatch("keydown", { key: "Escape", code: "Escape" });
  assert.equal(dom.shortcutInput.value, "Command+Shift+Y");

  await dom.clearBtn.dispatch("click");
  assert.deepEqual(mock.updateCalls.at(-1), {
    name: "_execute_action",
    shortcut: "",
  });
  assert.equal(dom.shortcutInput.value, "Not set");
  assert.equal(dom.clearBtn.disabled, true);
  assert.equal(dom.statusEl.textContent, "Shortcut cleared");

  await dom.resetBtn.dispatch("click");
  assert.deepEqual(mock.resetCalls, ["_execute_action"]);
  assert.equal(dom.shortcutInput.value, "Command+Shift+U");
  assert.equal(dom.clearBtn.disabled, false);
  assert.equal(dom.statusEl.textContent, "Shortcut reset to default");

  mock.setCommandShortcut("MacCtrl+T");
  await dom.win.dispatchFocus();
  assert.equal(dom.shortcutInput.value, "Control+T");
  assert.equal(controller.getState().shortcut, "MacCtrl+T");

  controller.destroy();
});

test("shortcut recorder surfaces Firefox commands.update rejections cleanly", async () => {
  const dom = createFakeOptionsDom();
  const mock = createMockOptionsBrowser({}, { failCommandUpdate: true });
  const controller = await createOptionsController({
    browserApi: mock.browserApi,
    doc: dom.doc,
    win: dom.win,
    isMac: false,
  });

  await dom.shortcutInput.focus();
  await dom.shortcutInput.dispatch("keydown", {
    ctrlKey: true,
    shiftKey: true,
    code: "KeyK",
    key: "K",
  });
  assert.equal(dom.statusEl.textContent, "Shortcut in use by Firefox");
  assert.match(dom.statusEl.className, /save-status--error/);
  assert.equal(controller.getState().shortcut, "Ctrl+Shift+U");

  controller.destroy();
});

test("toggling autoOpenSingleMatch persists and external storage.onChanged updates both toggles", async () => {
  const dom = createFakeOptionsDom();
  const mock = createMockOptionsBrowser();
  const controller = await createOptionsController({
    browserApi: mock.browserApi,
    doc: dom.doc,
    win: dom.win,
    statusDurationMs: 25,
  });

  await dom.autoOpenInput.toggle(true);
  assert.equal(mock.localStore.autoOpenSingleMatch, true);
  assert.equal(controller.getState().autoOpenSingleMatch, true);
  assert.equal(dom.statusEl.textContent, "Saved");

  await new Promise((r) => setTimeout(r, 40));
  assert.equal(dom.statusEl.textContent, "");

  mock.emitExternalChange(
    {
      openOnNewTab: { oldValue: false, newValue: true },
      autoOpenSingleMatch: { oldValue: true, newValue: false },
    },
    "local"
  );
  assert.equal(dom.openOnNewTabInput.checked, true);
  assert.equal(dom.autoOpenInput.checked, false);

  mock.emitExternalChange(
    { autoOpenSingleMatch: { oldValue: false, newValue: true } },
    "session"
  );
  assert.equal(dom.autoOpenInput.checked, false);
  controller.destroy();

  const failDom = createFakeOptionsDom();
  const failMock = createMockOptionsBrowser(
    { autoOpenSingleMatch: false },
    { failWrite: true }
  );
  const failCtrl = await createOptionsController({
    browserApi: failMock.browserApi,
    doc: failDom.doc,
    win: failDom.win,
  });

  await failDom.autoOpenInput.toggle(true);
  assert.equal(failDom.autoOpenInput.checked, false);
  assert.equal(failDom.statusEl.textContent, "Could not save setting");
  assert.match(failDom.statusEl.className, /save-status--error/);
  failCtrl.destroy();
});

test("destroy unregisters all DOM, window, and storage listeners", async () => {
  const dom = createFakeOptionsDom();
  const mock = createMockOptionsBrowser();
  const controller = await createOptionsController({
    browserApi: mock.browserApi,
    doc: dom.doc,
    win: dom.win,
  });

  assert.equal(dom.openOnNewTabInput.listeners.get("change").length, 1);
  assert.equal(dom.openOnExternalLinkInput.listeners.get("change").length, 1);
  assert.equal(dom.autoOpenInput.listeners.get("change").length, 1);
  assert.equal(dom.shortcutInput.listeners.get("focus").length, 1);
  assert.equal(dom.shortcutInput.listeners.get("click").length, 1);
  assert.equal(dom.shortcutInput.listeners.get("blur").length, 1);
  assert.equal(dom.shortcutInput.listeners.get("keydown").length, 1);
  assert.equal(dom.resetBtn.listeners.get("click").length, 1);
  assert.equal(dom.clearBtn.listeners.get("click").length, 1);
  assert.equal(dom.winListeners.get("focus").length, 1);
  assert.equal(mock.onChangedListeners.size, 1);

  controller.destroy();

  assert.equal(dom.openOnNewTabInput.listeners.get("change").length, 0);
  assert.equal(dom.openOnExternalLinkInput.listeners.get("change").length, 0);
  assert.equal(dom.autoOpenInput.listeners.get("change").length, 0);
  assert.equal(dom.shortcutInput.listeners.get("focus").length, 0);
  assert.equal(dom.shortcutInput.listeners.get("click").length, 0);
  assert.equal(dom.shortcutInput.listeners.get("blur").length, 0);
  assert.equal(dom.shortcutInput.listeners.get("keydown").length, 0);
  assert.equal(dom.resetBtn.listeners.get("click").length, 0);
  assert.equal(dom.clearBtn.listeners.get("click").length, 0);
  assert.equal(dom.winListeners.get("focus").length, 0);
  assert.equal(mock.onChangedListeners.size, 0);
});
