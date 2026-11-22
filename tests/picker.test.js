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

  const elementsById = new Map([
    ["container-search", searchInput],
    ["container-list", listEl],
    ["empty-state", emptyStateEl],
    ["status-announcer", announcerEl],
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

  return { doc, win, searchInput, listEl, emptyStateEl };
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
