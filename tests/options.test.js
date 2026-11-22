import test from "node:test";
import assert from "node:assert/strict";
import { createOptionsController } from "../src/options/options.js";

function createFakeOptionsDom() {
  class FakeInput {
    constructor(id) {
      this.id = id;
      this.checked = false;
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
    async toggle(nextChecked) {
      this.checked = nextChecked;
      const handlers = [...(this.listeners.get("change") ?? [])];
      await Promise.all(handlers.map((fn) => fn({ type: "change" })));
    }
  }

  const enabledInput = new FakeInput("setting-enabled");
  const autoOpenInput = new FakeInput("setting-auto-open");
  const statusEl = {
    id: "save-status",
    textContent: "",
    className: "save-status",
  };

  const byId = new Map([
    ["setting-enabled", enabledInput],
    ["setting-auto-open", autoOpenInput],
    ["save-status", statusEl],
  ]);

  const doc = {
    getElementById: (id) => byId.get(id) ?? null,
  };

  return { doc, enabledInput, autoOpenInput, statusEl };
}

function createMockOptionsBrowser(initialStore = {}, options = {}) {
  const localStore = { ...initialStore };
  const onChangedListeners = new Set();

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
  };

  return {
    browserApi,
    localStore,
    onChangedListeners,
    emitExternalChange(changes, areaName = "local") {
      for (const fn of [...onChangedListeners]) {
        fn(changes, areaName);
      }
    },
  };
}

test("options page loads defaults and stored values", async () => {
  const domA = createFakeOptionsDom();
  const mockA = createMockOptionsBrowser();
  const ctrlA = await createOptionsController({
    browserApi: mockA.browserApi,
    doc: domA.doc,
  });

  assert.equal(domA.enabledInput.checked, true);
  assert.equal(domA.autoOpenInput.checked, false);
  assert.deepEqual(ctrlA.getState(), {
    enabled: true,
    autoOpenSingleMatch: false,
  });
  ctrlA.destroy();

  const domB = createFakeOptionsDom();
  const mockB = createMockOptionsBrowser({
    enabled: false,
    autoOpenSingleMatch: true,
  });
  const ctrlB = await createOptionsController({
    browserApi: mockB.browserApi,
    doc: domB.doc,
  });

  assert.equal(domB.enabledInput.checked, false);
  assert.equal(domB.autoOpenInput.checked, true);
  assert.deepEqual(ctrlB.getState(), {
    enabled: false,
    autoOpenSingleMatch: true,
  });
  ctrlB.destroy();
});

test("toggling settings persists to storage.local and displays Saved status", async () => {
  const { doc, enabledInput, autoOpenInput, statusEl } = createFakeOptionsDom();
  const mock = createMockOptionsBrowser();
  const controller = await createOptionsController({
    browserApi: mock.browserApi,
    doc,
    statusDurationMs: 25,
  });

  await autoOpenInput.toggle(true);
  assert.equal(mock.localStore.autoOpenSingleMatch, true);
  assert.equal(controller.getState().autoOpenSingleMatch, true);
  assert.equal(statusEl.textContent, "Saved");
  assert.equal(statusEl.className, "save-status");

  await enabledInput.toggle(false);
  assert.equal(mock.localStore.enabled, false);
  assert.equal(controller.getState().enabled, false);
  assert.equal(statusEl.textContent, "Saved");

  await new Promise((r) => setTimeout(r, 40));
  assert.equal(statusEl.textContent, "");

  controller.destroy();
});

test("external storage.onChanged updates checkboxes and state dynamically", async () => {
  const { doc, enabledInput, autoOpenInput } = createFakeOptionsDom();
  const mock = createMockOptionsBrowser();
  const controller = await createOptionsController({
    browserApi: mock.browserApi,
    doc,
  });

  mock.emitExternalChange(
    {
      enabled: { oldValue: true, newValue: false },
      autoOpenSingleMatch: { oldValue: false, newValue: true },
    },
    "local"
  );

  assert.equal(enabledInput.checked, false);
  assert.equal(autoOpenInput.checked, true);
  assert.deepEqual(controller.getState(), {
    enabled: false,
    autoOpenSingleMatch: true,
  });

  // Changes in non-local areas (e.g. session/sync) are ignored
  mock.emitExternalChange(
    {
      enabled: { oldValue: false, newValue: true },
    },
    "session"
  );
  assert.equal(enabledInput.checked, false);

  controller.destroy();
});

test("write failure reverts checkbox and shows error status", async () => {
  const { doc, autoOpenInput, statusEl } = createFakeOptionsDom();
  const mock = createMockOptionsBrowser(
    { enabled: true, autoOpenSingleMatch: false },
    { failWrite: true }
  );
  const controller = await createOptionsController({
    browserApi: mock.browserApi,
    doc,
    statusDurationMs: 100,
  });

  await autoOpenInput.toggle(true);
  assert.equal(autoOpenInput.checked, false);
  assert.equal(controller.getState().autoOpenSingleMatch, false);
  assert.equal(statusEl.textContent, "Could not save setting");
  assert.match(statusEl.className, /save-status--error/);

  controller.destroy();
});

test("destroy unregisters DOM and storage listeners", async () => {
  const { doc, enabledInput, autoOpenInput } = createFakeOptionsDom();
  const mock = createMockOptionsBrowser();
  const controller = await createOptionsController({
    browserApi: mock.browserApi,
    doc,
  });

  assert.equal(enabledInput.listeners.get("change").length, 1);
  assert.equal(autoOpenInput.listeners.get("change").length, 1);
  assert.equal(mock.onChangedListeners.size, 1);

  controller.destroy();

  assert.equal(enabledInput.listeners.get("change").length, 0);
  assert.equal(autoOpenInput.listeners.get("change").length, 0);
  assert.equal(mock.onChangedListeners.size, 0);
});
