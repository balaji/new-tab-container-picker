import test from "node:test";
import assert from "node:assert/strict";
import { UNAVAILABLE_MESSAGES, createPickerController } from "../src/picker/picker.js";

function createFakeDom(search = "") {
  class FakeClassList {
    constructor(el) {
      this.el = el;
    }
    contains(token) {
      return (this.el.className || "").split(/\s+/).includes(token);
    }
  }

  class FakeStyle {
    constructor() {
      this.props = new Map();
    }
    setProperty(k, v) {
      this.props.set(k, v);
    }
    getPropertyValue(k) {
      return this.props.get(k) ?? "";
    }
  }

  class FakeElement {
    constructor(tagName) {
      this.tagName = tagName.toLowerCase();
      this.id = "";
      this.className = "";
      this.classList = new FakeClassList(this);
      this.style = new FakeStyle();
      this.dataset = {};
      this.attributes = new Map();
      this.children = [];
      this.listeners = new Map();
      this.hidden = false;
      this.disabled = false;
      this.value = "";
      this._textContent = "";
      this.focused = false;
      this.scrolledIntoView = 0;
    }
    set textContent(val) {
      this._textContent = String(val);
    }
    get textContent() {
      if (this.children.length === 0) return this._textContent;
      return this._textContent + this.children.map((c) => c.textContent).join("");
    }
    setAttribute(k, v) {
      this.attributes.set(k, String(v));
      if (k === "class") this.className = String(v);
      if (k === "id") this.id = String(v);
    }
    getAttribute(k) {
      return this.attributes.get(k) ?? null;
    }
    removeAttribute(k) {
      this.attributes.delete(k);
    }
    append(...nodes) {
      this.children.push(...nodes);
    }
    replaceChildren(...nodes) {
      this.children = [...nodes];
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
    dispatchEvent(event) {
      for (const fn of this.listeners.get(event.type) ?? []) {
        fn(event);
      }
    }
    focus() {
      if (this.disabled) return;
      this.focused = true;
      doc.activeElement = this;
    }
    scrollIntoView() {
      this.scrolledIntoView += 1;
    }
    querySelectorAll(selector) {
      if (selector === ".container-item") {
        return this.children.filter((c) => c.classList.contains("container-item"));
      }
      return [];
    }
  }

  const documentElement = new FakeElement("html");
  const searchInput = new FakeElement("input");
  searchInput.id = "container-search";
  const listEl = new FakeElement("ul");
  listEl.id = "container-list";
  const emptyStateEl = new FakeElement("p");
  emptyStateEl.id = "empty-state";
  emptyStateEl.hidden = true;
  const announcerEl = new FakeElement("div");
  announcerEl.id = "status-announcer";
  const settingsBtn = new FakeElement("button");
  settingsBtn.id = "open-settings";
  const targetUrlBanner = new FakeElement("div");
  targetUrlBanner.id = "target-url-banner";
  targetUrlBanner.hidden = true;
  const targetUrlText = new FakeElement("span");
  targetUrlText.id = "target-url-text";
  const errorEl = new FakeElement("p");
  errorEl.id = "picker-error";
  errorEl.hidden = true;

  const elementsById = new Map([
    ["container-search", searchInput],
    ["container-list", listEl],
    ["empty-state", emptyStateEl],
    ["status-announcer", announcerEl],
    ["open-settings", settingsBtn],
    ["target-url-banner", targetUrlBanner],
    ["target-url-text", targetUrlText],
    ["picker-error", errorEl],
  ]);

  const docListeners = new Map();
  const winListeners = new Map();

  const doc = {
    documentElement,
    activeElement: null,
    getElementById: (id) => elementsById.get(id) ?? null,
    createElement: (tag) => new FakeElement(tag),
    createElementNS: (_ns, tag) => new FakeElement(tag),
    createDocumentFragment: () => {
      const frag = new FakeElement("fragment");
      return {
        append: (...nodes) => frag.children.push(...nodes),
        get children() {
          return frag.children;
        },
        [Symbol.iterator]: () => frag.children[Symbol.iterator](),
      };
    },
    hasFocus: () => true,
    addEventListener(type, fn) {
      if (!docListeners.has(type)) docListeners.set(type, []);
      docListeners.get(type).push(fn);
    },
    removeEventListener(type, fn) {
      const list = docListeners.get(type);
      if (!list) return;
      const idx = list.indexOf(fn);
      if (idx >= 0) list.splice(idx, 1);
    },
    dispatchKeyDown(key, extra = {}) {
      let prevented = false;
      const evt = {
        type: "keydown",
        key,
        ctrlKey: false,
        metaKey: false,
        altKey: false,
        target: doc.activeElement ?? searchInput,
        preventDefault() {
          prevented = true;
        },
        ...extra,
      };
      for (const fn of docListeners.get("keydown") ?? []) {
        fn(evt);
      }
      return prevented;
    },
  };

  const origReplace = listEl.replaceChildren.bind(listEl);
  listEl.replaceChildren = (fragment) => {
    origReplace(...(fragment.children ?? [fragment]));
  };

  const win = {
    location: { search },
    closed: false,
    close() {
      this.closed = true;
    },
    requestAnimationFrame(cb) {
      cb();
    },
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
  };

  return { doc, win, searchInput, listEl, emptyStateEl, announcerEl, settingsBtn, errorEl };
}

const SAMPLE_IDENTITIES = [
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
    name: "Play",
    color: "turquoise",
    colorCode: "#00c79a",
    icon: "circle",
    iconUrl: "resource://usercontext-content/circle.svg",
  },
  {
    cookieStoreId: "firefox-container-3",
    name: "Work",
    color: "orange",
    colorCode: "#ff9f00",
    icon: "briefcase",
    iconUrl: "resource://usercontext-content/briefcase.svg",
  },
];

function createTestPickerApi({
  identities = SAMPLE_IDENTITIES,
  incognito = false,
  autoOpenSingleMatch = false,
  containersMode = "enabled",
} = {}) {
  const createdTabs = [];
  let openOptionsCalls = 0;

  const browserApi = {
    windows: {
      async getCurrent() {
        return { id: 1, incognito };
      },
    },
    contextualIdentities: {
      async query() {
        if (containersMode === "throw") {
          throw new Error("Contextual identities disabled");
        }
        if (containersMode === "empty") {
          return [];
        }
        return identities.map((c) => ({ ...c }));
      },
    },
    storage: {
      local: {
        async get() {
          return { autoOpenSingleMatch };
        },
      },
    },
    tabs: {
      async create(props) {
        createdTabs.push(props);
        return { id: 100 + createdTabs.length, ...props };
      },
    },
    runtime: {
      async openOptionsPage() {
        openOptionsCalls += 1;
      },
    },
  };

  return {
    browserApi,
    createdTabs,
    getOpenOptionsCalls: () => openOptionsCalls,
  };
}

test("picker highlights first container initially, puts Default last, navigates, filters, and opens tab on Enter", async () => {
  const { doc, win, searchInput, listEl, emptyStateEl } = createFakeDom();
  const { browserApi, createdTabs } = createTestPickerApi({
    identities: [SAMPLE_IDENTITIES[0], SAMPLE_IDENTITIES[2]],
  });

  const controller = await createPickerController({
    browserApi,
    doc,
    win,
  });

  assert.equal(doc.documentElement.getAttribute("data-mode"), null);
  assert.equal(searchInput.focused, true);
  assert.equal(listEl.children.length, 3);
  assert.equal(listEl.children[0].classList.contains("container-item--colored"), true);
  assert.equal(listEl.children[0].style.getPropertyValue("--container-color"), "#37adff");
  assert.equal(listEl.children[0].getAttribute("aria-selected"), "true");
  assert.equal(listEl.children[2].classList.contains("container-item--default"), true);

  doc.dispatchKeyDown("ArrowDown");
  assert.equal(controller.getState().activeIndex, 1);
  assert.equal(listEl.children[1].getAttribute("aria-selected"), "true");

  doc.dispatchKeyDown("ArrowUp");
  doc.dispatchKeyDown("ArrowUp");
  assert.equal(controller.getState().activeIndex, 2);
  assert.equal(listEl.children[2].getAttribute("aria-selected"), "true");

  searchInput.value = "per";
  searchInput.dispatchEvent({ type: "input" });
  assert.equal(listEl.children.length, 1);
  assert.equal(controller.getState().activeIndex, 0);
  assert.equal(emptyStateEl.hidden, true);

  searchInput.value = "nope";
  searchInput.dispatchEvent({ type: "input" });
  assert.equal(listEl.children.length, 0);
  assert.equal(emptyStateEl.hidden, false);

  searchInput.value = "";
  searchInput.dispatchEvent({ type: "input" });
  doc.dispatchKeyDown("ArrowDown");
  doc.dispatchKeyDown("Enter");
  await Promise.resolve();

  assert.deepEqual(createdTabs, [
    { cookieStoreId: "firefox-container-3", active: true },
  ]);
  assert.equal(win.closed, true);

  controller.destroy();
});

test("picker closes on Escape without creating a tab and opens Default tab on click", async () => {
  const domA = createFakeDom();
  const apiA = createTestPickerApi({
    identities: [SAMPLE_IDENTITIES[0]],
  });

  const controllerA = await createPickerController({
    browserApi: apiA.browserApi,
    doc: domA.doc,
    win: domA.win,
  });
  domA.doc.dispatchKeyDown("Escape");
  await Promise.resolve();
  assert.deepEqual(apiA.createdTabs, []);
  assert.equal(domA.win.closed, true);
  controllerA.destroy();

  const domB = createFakeDom();
  const apiB = createTestPickerApi({
    identities: [SAMPLE_IDENTITIES[0]],
  });
  const controllerB = await createPickerController({
    browserApi: apiB.browserApi,
    doc: domB.doc,
    win: domB.win,
  });
  domB.listEl.children[1].dispatchEvent({
    type: "click",
    preventDefault() {},
  });
  await Promise.resolve();
  assert.deepEqual(apiB.createdTabs, [{ active: true }]);
  assert.equal(domB.win.closed, true);
  controllerB.destroy();
});

test("autoOpenSingleMatch disabled does not auto-open when narrowed to 1 match", async () => {
  const { doc, win, searchInput, listEl } = createFakeDom();
  const { browserApi, createdTabs } = createTestPickerApi({
    autoOpenSingleMatch: false,
  });
  const controller = await createPickerController({ browserApi, doc, win });

  searchInput.value = "wo";
  searchInput.dispatchEvent({ type: "input" });
  await Promise.resolve();

  assert.equal(listEl.children.length, 1);
  assert.equal(createdTabs.length, 0);
  assert.equal(win.closed, false);
  controller.destroy();
});

test("autoOpenSingleMatch auto-opens named container or Default when search narrows to 1 result", async () => {
  const dom1 = createFakeDom();
  const api1 = createTestPickerApi({ autoOpenSingleMatch: true });
  const ctrl1 = await createPickerController({
    browserApi: api1.browserApi,
    doc: dom1.doc,
    win: dom1.win,
  });

  dom1.searchInput.value = "p";
  dom1.searchInput.dispatchEvent({ type: "input" });
  await Promise.resolve();
  assert.equal(dom1.listEl.children.length, 2);
  assert.equal(api1.createdTabs.length, 0);

  dom1.searchInput.value = "pe";
  dom1.searchInput.dispatchEvent({ type: "input" });
  await Promise.resolve();
  assert.deepEqual(api1.createdTabs, [
    { cookieStoreId: "firefox-container-1", active: true },
  ]);
  assert.equal(dom1.win.closed, true);
  ctrl1.destroy();

  const dom2 = createFakeDom();
  const api2 = createTestPickerApi({ autoOpenSingleMatch: true });
  const ctrl2 = await createPickerController({
    browserApi: api2.browserApi,
    doc: dom2.doc,
    win: dom2.win,
  });

  dom2.searchInput.value = "def";
  dom2.searchInput.dispatchEvent({ type: "input" });
  await Promise.resolve();
  assert.deepEqual(api2.createdTabs, [{ active: true }]);
  assert.equal(dom2.win.closed, true);
  ctrl2.destroy();
});

test("autoOpenSingleMatch does not auto-open on initial render, whitespace query, 2+ matches, or 0 matches", async () => {
  const { doc, win, searchInput } = createFakeDom();
  const { browserApi, createdTabs } = createTestPickerApi({
    autoOpenSingleMatch: true,
  });
  const controller = await createPickerController({ browserApi, doc, win });

  assert.equal(createdTabs.length, 0);

  searchInput.value = "   ";
  searchInput.dispatchEvent({ type: "input" });
  await Promise.resolve();
  assert.equal(createdTabs.length, 0);

  searchInput.value = "zzz";
  searchInput.dispatchEvent({ type: "input" });
  await Promise.resolve();
  assert.equal(createdTabs.length, 0);

  controller.destroy();
});

test("autoOpenSingleMatch defers during IME composition and triggers on compositionend", async () => {
  const { doc, win, searchInput } = createFakeDom();
  const { browserApi, createdTabs } = createTestPickerApi({
    autoOpenSingleMatch: true,
  });
  const controller = await createPickerController({ browserApi, doc, win });

  searchInput.dispatchEvent({ type: "compositionstart" });
  searchInput.value = "wo";
  searchInput.dispatchEvent({ type: "input", isComposing: true });
  await Promise.resolve();
  assert.equal(createdTabs.length, 0);

  searchInput.dispatchEvent({ type: "compositionend" });
  await Promise.resolve();
  assert.deepEqual(createdTabs, [
    { cookieStoreId: "firefox-container-3", active: true },
  ]);
  assert.equal(win.closed, true);

  controller.destroy();
});

test("autoOpenSingleMatch honors typing entered before loadState resolves", async () => {
  const { doc, win, searchInput } = createFakeDom();
  const createdTabs = [];
  let notifyQueryStarted;
  const queryStarted = new Promise((resolve) => {
    notifyQueryStarted = resolve;
  });
  let resolveQuery;
  const browserApi = {
    windows: { getCurrent: async () => ({ incognito: false }) },
    contextualIdentities: {
      query: () => {
        notifyQueryStarted();
        return new Promise((resolve) => {
          resolveQuery = resolve;
        });
      },
    },
    storage: {
      local: { get: async () => ({ autoOpenSingleMatch: true }) },
    },
    tabs: {
      async create(props) {
        createdTabs.push(props);
        return { id: 101, ...props };
      },
    },
  };

  const controllerPromise = createPickerController({ browserApi, doc, win });
  await queryStarted;

  searchInput.value = "work";
  searchInput.dispatchEvent({ type: "input" });
  assert.equal(createdTabs.length, 0);

  resolveQuery(SAMPLE_IDENTITIES);
  const controller = await controllerPromise;
  await Promise.resolve();

  assert.deepEqual(createdTabs, [
    { cookieStoreId: "firefox-container-3", active: true },
  ]);
  assert.equal(win.closed, true);
  controller.destroy();
});

test("settings button opens options page, closes popup, and keeps keyboard accessibility", async () => {
  const domA = createFakeDom();
  const apiA = createTestPickerApi();
  const ctrlA = await createPickerController({
    browserApi: apiA.browserApi,
    doc: domA.doc,
    win: domA.win,
  });

  domA.settingsBtn.focus();
  assert.equal(domA.doc.dispatchKeyDown("Enter"), false);
  assert.equal(domA.doc.dispatchKeyDown(" "), false);
  assert.equal(apiA.getOpenOptionsCalls(), 0);

  domA.settingsBtn.dispatchEvent({ type: "click" });
  await Promise.resolve();
  assert.equal(apiA.getOpenOptionsCalls(), 1);
  assert.equal(domA.win.closed, true);
  ctrlA.destroy();

  const domB = createFakeDom();
  const apiB = createTestPickerApi();
  const ctrlB = await createPickerController({
    browserApi: apiB.browserApi,
    doc: domB.doc,
    win: domB.win,
  });

  domB.settingsBtn.focus();
  domB.doc.dispatchKeyDown("ArrowDown");
  assert.equal(domB.doc.activeElement, domB.searchInput);

  domB.settingsBtn.focus();
  domB.doc.dispatchKeyDown("Escape");
  await Promise.resolve();
  assert.equal(domB.win.closed, true);
  ctrlB.destroy();
});

test("unavailable states (private window and disabled containers) display notice and keep Escape and Settings working", async () => {
  const privDom = createFakeDom();
  const privApi = createTestPickerApi({ incognito: true });
  const privCtrl = await createPickerController({
    browserApi: privApi.browserApi,
    doc: privDom.doc,
    win: privDom.win,
  });

  assert.equal(privDom.win.closed, false);
  assert.equal(privDom.searchInput.disabled, true);
  assert.equal(privDom.emptyStateEl.hidden, false);
  assert.equal(
    privDom.emptyStateEl.textContent,
    UNAVAILABLE_MESSAGES["private-window"]
  );
  assert.equal(privCtrl.getState().unavailableReason, "private-window");
  assert.equal(privCtrl.getState().activeIndex, -1);

  privDom.doc.dispatchKeyDown("Escape");
  await Promise.resolve();
  assert.equal(privDom.win.closed, true);
  privCtrl.destroy();

  const disDom = createFakeDom();
  const disApi = createTestPickerApi({ containersMode: "throw" });
  const disCtrl = await createPickerController({
    browserApi: disApi.browserApi,
    doc: disDom.doc,
    win: disDom.win,
  });

  assert.equal(disDom.win.closed, false);
  assert.equal(disDom.searchInput.disabled, true);
  assert.equal(disDom.emptyStateEl.hidden, false);
  assert.equal(
    disDom.emptyStateEl.textContent,
    UNAVAILABLE_MESSAGES["containers-disabled"]
  );
  assert.equal(disCtrl.getState().unavailableReason, "containers-disabled");

  disDom.settingsBtn.dispatchEvent({ type: "click" });
  await Promise.resolve();
  assert.equal(disApi.getOpenOptionsCalls(), 1);
  assert.equal(disDom.win.closed, true);
  disCtrl.destroy();
});

test("picker in-tab mode (?mode=tab) sets data-mode=tab, replaces current tab on pick/Escape, and closes tab on Settings", async () => {
  const flushMicrotasks = async () => {
    for (let i = 0; i < 6; i += 1) {
      await Promise.resolve();
    }
  };

  const createdA = [];
  const removedA = [];
  const domA = createFakeDom("?mode=tab");
  const apiA = createTestPickerApi();
  apiA.browserApi.tabs = {
    async getCurrent() {
      return { id: 42, windowId: 10, index: 2 };
    },
    async create(props) {
      createdA.push(props);
      return { id: 43, ...props };
    },
    async remove(id) {
      removedA.push(id);
    },
  };

  const ctrlA = await createPickerController({
    browserApi: apiA.browserApi,
    doc: domA.doc,
    win: domA.win,
  });
  assert.equal(domA.doc.documentElement.getAttribute("data-mode"), "tab");
  domA.doc.dispatchKeyDown("Enter");
  await flushMicrotasks();
  assert.deepEqual(createdA, [
    {
      windowId: 10,
      index: 2,
      cookieStoreId: "firefox-container-1",
      active: true,
    },
  ]);
  assert.deepEqual(removedA, [42]);
  assert.equal(domA.win.closed, false);
  ctrlA.destroy();

  // Escape in in-tab mode opens Default tab with openerTabId and removes picker tab
  const createdB = [];
  const removedB = [];
  const domB = createFakeDom("?mode=tab");
  const apiB = createTestPickerApi();
  apiB.browserApi.tabs = {
    async getCurrent() {
      return { id: 50, windowId: 10, index: 1 };
    },
    async create(props) {
      createdB.push(props);
      return { id: 51, ...props };
    },
    async remove(id) {
      removedB.push(id);
    },
  };

  const ctrlB = await createPickerController({
    browserApi: apiB.browserApi,
    doc: domB.doc,
    win: domB.win,
  });
  domB.doc.dispatchKeyDown("Escape");
  await flushMicrotasks();
  assert.deepEqual(createdB, [
    { windowId: 10, index: 1, active: true, openerTabId: 50 },
  ]);
  assert.deepEqual(removedB, [50]);
  ctrlB.destroy();

  // Clicking Settings in in-tab mode opens options page and removes picker tab
  const removedC = [];
  const domC = createFakeDom("?mode=tab");
  const apiC = createTestPickerApi();
  apiC.browserApi.tabs.getCurrent = async () => ({ id: 60, windowId: 10, index: 0 });
  apiC.browserApi.tabs.remove = async (id) => {
    removedC.push(id);
  };

  const ctrlC = await createPickerController({
    browserApi: apiC.browserApi,
    doc: domC.doc,
    win: domC.win,
  });
  domC.settingsBtn.dispatchEvent({ type: "click" });
  await flushMicrotasks();
  assert.equal(apiC.getOpenOptionsCalls(), 1);
  assert.deepEqual(removedC, [60]);
  ctrlC.destroy();

  // In-tab mode with target URL displays banner, updates title, and opens URL in chosen container
  const targetUrl = "https://docs.example.com/guide?ref=slack";
  const createdD = [];
  const removedD = [];
  const domD = createFakeDom(
    `?mode=tab&url=${encodeURIComponent(targetUrl)}`
  );
  const apiD = createTestPickerApi();
  apiD.browserApi.tabs = {
    async getCurrent() {
      return { id: 70, windowId: 10, index: 3 };
    },
    async create(props) {
      createdD.push(props);
      return { id: 71, ...props };
    },
    async remove(id) {
      removedD.push(id);
    },
  };

  const ctrlD = await createPickerController({
    browserApi: apiD.browserApi,
    doc: domD.doc,
    win: domD.win,
  });
  const banner = domD.doc.getElementById("target-url-banner");
  const bannerText = domD.doc.getElementById("target-url-text");
  assert.equal(banner.hidden, false);
  assert.equal(banner.getAttribute("title"), targetUrl);
  assert.equal(bannerText.textContent, targetUrl);
  assert.equal(domD.doc.title, "Open docs.example.com in Container");

  domD.doc.dispatchKeyDown("Enter");
  await flushMicrotasks();
  assert.deepEqual(createdD, [
    {
      windowId: 10,
      index: 3,
      url: targetUrl,
      cookieStoreId: "firefox-container-1",
      active: true,
    },
  ]);
  assert.deepEqual(removedD, [70]);
  ctrlD.destroy();
});

test("picker shows a visible error and stays usable when opening the tab fails", async () => {
  const flushMicrotasks = async () => {
    for (let i = 0; i < 8; i += 1) {
      await Promise.resolve();
    }
  };

  const target = "https://example.com/external";
  const dom = createFakeDom(`?mode=tab&url=${encodeURIComponent(target)}`);
  const api = createTestPickerApi();
  const created = [];
  const removed = [];
  let failNext = true;
  api.browserApi.runtime.sendMessage = async () => ({ ok: true });
  api.browserApi.tabs = {
    async getCurrent() {
      return { id: 50, windowId: 10, index: 1 };
    },
    async create(props) {
      if (failNext) {
        failNext = false;
        throw new Error("container removed");
      }
      created.push(props);
      return { id: 51, ...props };
    },
    async remove(id) {
      removed.push(id);
    },
  };

  const ctrl = await createPickerController({
    browserApi: api.browserApi,
    doc: dom.doc,
    win: dom.win,
  });

  dom.doc.dispatchKeyDown("Enter");
  await flushMicrotasks();
  assert.deepEqual(removed, []);
  assert.equal(dom.errorEl.hidden, false);
  assert.match(dom.errorEl.textContent, /Couldn.t open the tab/);

  // Retrying clears the error and completes normally
  dom.doc.dispatchKeyDown("Enter");
  await flushMicrotasks();
  assert.equal(dom.errorEl.hidden, true);
  assert.equal(created.length, 1);
  assert.equal(created[0].url, target);
  assert.deepEqual(removed, [50]);

  ctrl.destroy();
});
