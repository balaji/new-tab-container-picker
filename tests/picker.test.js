import test from "node:test";
import assert from "node:assert/strict";
import { createPickerController } from "../src/picker/picker.js";

function createFakeDom() {
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

  const elementsById = new Map([
    ["container-search", searchInput],
    ["container-list", listEl],
    ["empty-state", emptyStateEl],
    ["status-announcer", announcerEl],
    ["open-settings", settingsBtn],
  ]);

  const docListeners = new Map();
  const winListeners = new Map();

  const doc = {
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

  // Override replaceChildren for DocumentFragment objects
  const origReplace = listEl.replaceChildren.bind(listEl);
  listEl.replaceChildren = (fragment) => {
    origReplace(...(fragment.children ?? [fragment]));
  };

  const win = {
    location: { search: "?session=sess-1" },
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

  return { doc, win, searchInput, listEl, emptyStateEl, settingsBtn };
}

test("picker renders Default transparent row + colored containers, navigates with arrows, filters, and picks on Enter/click/Escape", async () => {
  const { doc, win, searchInput, listEl, emptyStateEl } = createFakeDom();
  const sentMessages = [];

  const browserApi = {
    runtime: {
      async sendMessage(msg) {
        sentMessages.push(msg);
        if (msg.type === "GET_PICKER_STATE") {
          return {
            sessionId: "sess-1",
            containers: [
              {
                cookieStoreId: "firefox-default",
                name: "Default",
                color: "transparent",
                colorCode: null,
                icon: null,
                iconUrl: null,
                isDefault: true,
              },
              {
                cookieStoreId: "firefox-container-1",
                name: "Personal",
                color: "blue",
                colorCode: "#37adff",
                icon: "fingerprint",
                iconUrl: "resource://usercontext-content/fingerprint.svg",
                isDefault: false,
              },
              {
                cookieStoreId: "firefox-container-2",
                name: "Work",
                color: "orange",
                colorCode: "#ff9f00",
                icon: "briefcase",
                iconUrl: "resource://usercontext-content/briefcase.svg",
                isDefault: false,
              },
            ],
          };
        }
        return { ok: true };
      },
    },
  };

  const controller = await createPickerController({
    browserApi,
    doc,
    win,
  });

  // Search box autofocused, Default initially highlighted
  assert.equal(searchInput.focused, true);
  assert.equal(listEl.children.length, 3);
  assert.equal(listEl.children[0].classList.contains("container-item--default"), true);
  assert.equal(listEl.children[0].getAttribute("aria-selected"), "true");
  assert.equal(listEl.children[1].classList.contains("container-item--colored"), true);
  assert.equal(listEl.children[1].style.getPropertyValue("--container-color"), "#37adff");

  // ArrowDown moves to Personal, ArrowUp wraps back to Work
  doc.dispatchKeyDown("ArrowDown");
  assert.equal(controller.getState().activeIndex, 1);
  assert.equal(listEl.children[1].getAttribute("aria-selected"), "true");

  doc.dispatchKeyDown("ArrowUp");
  doc.dispatchKeyDown("ArrowUp");
  assert.equal(controller.getState().activeIndex, 2);
  assert.equal(listEl.children[2].getAttribute("aria-selected"), "true");

  // Typing filters list and resets activeIndex to top match (0)
  searchInput.value = "per";
  searchInput.dispatchEvent({ type: "input" });
  assert.equal(listEl.children.length, 1);
  assert.equal(controller.getState().activeIndex, 0);
  assert.equal(emptyStateEl.hidden, true);

  // Non-matching query displays empty state
  searchInput.value = "nope";
  searchInput.dispatchEvent({ type: "input" });
  assert.equal(listEl.children.length, 0);
  assert.equal(emptyStateEl.hidden, false);

  // Clear filter and press Enter -> picks Work after moving down twice
  searchInput.value = "";
  searchInput.dispatchEvent({ type: "input" });
  doc.dispatchKeyDown("ArrowDown");
  doc.dispatchKeyDown("ArrowDown");
  doc.dispatchKeyDown("Enter");

  assert.deepEqual(sentMessages.at(-1), {
    type: "PICK_CONTAINER",
    sessionId: "sess-1",
    cookieStoreId: "firefox-container-2",
  });

  controller.destroy();
});

test("picker sends CANCEL_ESCAPE on Escape and PICK_CONTAINER on click", async () => {
  const { doc, win, listEl } = createFakeDom();
  const sentMessages = [];

  const browserApi = {
    runtime: {
      async sendMessage(msg) {
        sentMessages.push(msg);
        if (msg.type === "GET_PICKER_STATE") {
          return {
            sessionId: "sess-2",
            containers: [
              {
                cookieStoreId: "firefox-default",
                name: "Default",
                color: "transparent",
                colorCode: null,
                icon: null,
                iconUrl: null,
                isDefault: true,
              },
              {
                cookieStoreId: "firefox-container-1",
                name: "Personal",
                color: "blue",
                colorCode: "#37adff",
                icon: "fingerprint",
                iconUrl: null,
                isDefault: false,
              },
            ],
          };
        }
        return { ok: true };
      },
    },
  };

  const controllerA = await createPickerController({ browserApi, doc, win });
  doc.dispatchKeyDown("Escape");
  assert.deepEqual(sentMessages.at(-1), {
    type: "CANCEL_ESCAPE",
    sessionId: "sess-2",
  });
  controllerA.destroy();

  const dom2 = createFakeDom();
  const controllerB = await createPickerController({
    browserApi,
    doc: dom2.doc,
    win: dom2.win,
  });
  dom2.listEl.children[1].dispatchEvent({
    type: "click",
    preventDefault() {},
  });
  assert.deepEqual(sentMessages.at(-1), {
    type: "PICK_CONTAINER",
    sessionId: "sess-2",
    cookieStoreId: "firefox-container-1",
  });
  controllerB.destroy();
});

const SAMPLE_CONTAINERS = [
  {
    cookieStoreId: "firefox-default",
    name: "Default",
    color: "transparent",
    colorCode: null,
    icon: null,
    iconUrl: null,
    isDefault: true,
  },
  {
    cookieStoreId: "firefox-container-1",
    name: "Personal",
    color: "blue",
    colorCode: "#37adff",
    icon: "fingerprint",
    iconUrl: "resource://usercontext-content/fingerprint.svg",
    isDefault: false,
  },
  {
    cookieStoreId: "firefox-container-2",
    name: "Play",
    color: "turquoise",
    colorCode: "#00c79a",
    icon: "circle",
    iconUrl: "resource://usercontext-content/circle.svg",
    isDefault: false,
  },
  {
    cookieStoreId: "firefox-container-3",
    name: "Work",
    color: "orange",
    colorCode: "#ff9f00",
    icon: "briefcase",
    iconUrl: "resource://usercontext-content/briefcase.svg",
    isDefault: false,
  },
];

function createTestPickerApi({
  sessionId = "sess-auto",
  containers = SAMPLE_CONTAINERS,
  settings,
} = {}) {
  const sentMessages = [];
  const browserApi = {
    runtime: {
      async sendMessage(msg) {
        sentMessages.push(msg);
        if (msg.type === "GET_PICKER_STATE") {
          const response = { sessionId, containers };
          if (settings !== undefined) {
            response.settings = settings;
          }
          return response;
        }
        return { ok: true };
      },
    },
  };
  return { browserApi, sentMessages };
}

test("autoOpenSingleMatch disabled or omitted does not auto-open when narrowed to 1 match", async () => {
  for (const settings of [undefined, { autoOpenSingleMatch: false }]) {
    const { doc, win, searchInput, listEl } = createFakeDom();
    const { browserApi, sentMessages } = createTestPickerApi({ settings });
    const controller = await createPickerController({ browserApi, doc, win });

    searchInput.value = "wo";
    searchInput.dispatchEvent({ type: "input" });
    await Promise.resolve();

    assert.equal(listEl.children.length, 1);
    assert.equal(sentMessages.length, 1); // only GET_PICKER_STATE
    controller.destroy();
  }
});

test("autoOpenSingleMatch auto-opens named container or Default when search narrows to 1 result", async () => {
  const dom1 = createFakeDom();
  const api1 = createTestPickerApi({
    sessionId: "sess-named",
    settings: { autoOpenSingleMatch: true },
  });
  const ctrl1 = await createPickerController({
    browserApi: api1.browserApi,
    doc: dom1.doc,
    win: dom1.win,
  });

  // "p" matches Personal and Play (2 matches) -> should NOT auto-open
  dom1.searchInput.value = "p";
  dom1.searchInput.dispatchEvent({ type: "input" });
  await Promise.resolve();
  assert.equal(dom1.listEl.children.length, 2);
  assert.equal(api1.sentMessages.length, 1);

  // "pe" narrows to Personal (1 match) -> auto-opens
  dom1.searchInput.value = "pe";
  dom1.searchInput.dispatchEvent({ type: "input" });
  await Promise.resolve();
  assert.deepEqual(api1.sentMessages.at(-1), {
    type: "PICK_CONTAINER",
    sessionId: "sess-named",
    cookieStoreId: "firefox-container-1",
  });
  ctrl1.destroy();

  // Narrowing to Default also auto-opens Default
  const dom2 = createFakeDom();
  const api2 = createTestPickerApi({
    sessionId: "sess-default",
    settings: { autoOpenSingleMatch: true },
  });
  const ctrl2 = await createPickerController({
    browserApi: api2.browserApi,
    doc: dom2.doc,
    win: dom2.win,
  });

  dom2.searchInput.value = "def";
  dom2.searchInput.dispatchEvent({ type: "input" });
  await Promise.resolve();
  assert.deepEqual(api2.sentMessages.at(-1), {
    type: "PICK_CONTAINER",
    sessionId: "sess-default",
    cookieStoreId: "firefox-default",
  });
  ctrl2.destroy();
});

test("autoOpenSingleMatch does not auto-open on initial render, whitespace query, 2+ matches, or 0 matches", async () => {
  const domSingle = createFakeDom();
  const apiSingle = createTestPickerApi({
    containers: [SAMPLE_CONTAINERS[0]],
    settings: { autoOpenSingleMatch: true },
  });
  const ctrlSingle = await createPickerController({
    browserApi: apiSingle.browserApi,
    doc: domSingle.doc,
    win: domSingle.win,
  });
  assert.equal(apiSingle.sentMessages.length, 1);
  ctrlSingle.destroy();

  const { doc, win, searchInput } = createFakeDom();
  const { browserApi, sentMessages } = createTestPickerApi({
    settings: { autoOpenSingleMatch: true },
  });
  const controller = await createPickerController({ browserApi, doc, win });

  searchInput.value = "   ";
  searchInput.dispatchEvent({ type: "input" });
  await Promise.resolve();
  assert.equal(sentMessages.length, 1);

  searchInput.value = "zzz";
  searchInput.dispatchEvent({ type: "input" });
  await Promise.resolve();
  assert.equal(sentMessages.length, 1);

  controller.destroy();
});

test("autoOpenSingleMatch defers during IME composition and triggers on compositionend", async () => {
  const { doc, win, searchInput } = createFakeDom();
  const { browserApi, sentMessages } = createTestPickerApi({
    sessionId: "sess-ime",
    settings: { autoOpenSingleMatch: true },
  });
  const controller = await createPickerController({ browserApi, doc, win });

  searchInput.dispatchEvent({ type: "compositionstart" });
  searchInput.value = "wo";
  searchInput.dispatchEvent({ type: "input", isComposing: true });
  await Promise.resolve();
  assert.equal(sentMessages.length, 1); // still composing

  searchInput.dispatchEvent({ type: "compositionend" });
  await Promise.resolve();
  assert.deepEqual(sentMessages.at(-1), {
    type: "PICK_CONTAINER",
    sessionId: "sess-ime",
    cookieStoreId: "firefox-container-3",
  });

  controller.destroy();
});

test("autoOpenSingleMatch honors typing entered before GET_PICKER_STATE resolves", async () => {
  const { doc, win, searchInput } = createFakeDom();
  const sentMessages = [];
  let resolveState;
  const browserApi = {
    runtime: {
      sendMessage(msg) {
        sentMessages.push(msg);
        if (msg.type === "GET_PICKER_STATE") {
          return new Promise((resolve) => {
            resolveState = resolve;
          });
        }
        return Promise.resolve({ ok: true });
      },
    },
  };

  const controllerPromise = createPickerController({ browserApi, doc, win });

  // User types before GET_PICKER_STATE completes
  searchInput.value = "work";
  searchInput.dispatchEvent({ type: "input" });
  assert.equal(sentMessages.length, 1);

  resolveState({
    sessionId: "sess-early",
    containers: SAMPLE_CONTAINERS,
    settings: { autoOpenSingleMatch: true },
  });
  const controller = await controllerPromise;
  await Promise.resolve();

  assert.deepEqual(sentMessages.at(-1), {
    type: "PICK_CONTAINER",
    sessionId: "sess-early",
    cookieStoreId: "firefox-container-3",
  });
  controller.destroy();
});

test("settings button sends OPEN_OPTIONS on click and keeps keyboard accessibility", async () => {
  const domA = createFakeDom();
  const apiA = createTestPickerApi({ sessionId: "sess-opt-1" });
  const ctrlA = await createPickerController({
    browserApi: apiA.browserApi,
    doc: domA.doc,
    win: domA.win,
  });

  // Focusing settingsBtn should NOT swallow Enter or Space in global keydown
  domA.settingsBtn.focus();
  assert.equal(domA.doc.dispatchKeyDown("Enter"), false);
  assert.equal(domA.doc.dispatchKeyDown(" "), false);
  assert.equal(apiA.sentMessages.length, 1);

  // Clicking settingsBtn sends OPEN_OPTIONS
  domA.settingsBtn.dispatchEvent({ type: "click" });
  await Promise.resolve();
  assert.deepEqual(apiA.sentMessages.at(-1), {
    type: "OPEN_OPTIONS",
    sessionId: "sess-opt-1",
  });
  ctrlA.destroy();

  // Escape still cancels even when settings button is focused; ArrowDown returns focus to searchInput
  const domB = createFakeDom();
  const apiB = createTestPickerApi({ sessionId: "sess-opt-2" });
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
  assert.deepEqual(apiB.sentMessages.at(-1), {
    type: "CANCEL_ESCAPE",
    sessionId: "sess-opt-2",
  });
  ctrlB.destroy();
});
