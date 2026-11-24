import test from "node:test";
import assert from "node:assert/strict";
import {
  createContainerIconElement,
  createListRenderer,
} from "../src/picker/list-renderer.js";

function createMinimalDom() {
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

  class FakeEl {
    constructor(tag) {
      this.tagName = tag.toLowerCase();
      this.id = "";
      this.className = "";
      this.style = new FakeStyle();
      this.dataset = {};
      this.attrs = new Map();
      this.children = [];
      this.listeners = new Map();
      this.hidden = false;
      this.textContent = "";
      this.scrollCalls = [];
    }
    setAttribute(k, v) {
      this.attrs.set(k, String(v));
      if (k === "id") this.id = String(v);
      if (k === "class") this.className = String(v);
    }
    getAttribute(k) {
      return this.attrs.get(k) ?? null;
    }
    removeAttribute(k) {
      this.attrs.delete(k);
    }
    append(...nodes) {
      this.children.push(...nodes);
    }
    replaceChildren(fragment) {
      this.children = [...(fragment.children ?? [fragment])];
    }
    addEventListener(type, fn) {
      if (!this.listeners.has(type)) this.listeners.set(type, []);
      this.listeners.get(type).push(fn);
    }
    dispatchEvent(evt) {
      for (const fn of this.listeners.get(evt.type) ?? []) {
        fn(evt);
      }
    }
    scrollIntoView(opts) {
      this.scrollCalls.push(opts);
    }
    querySelectorAll(sel) {
      if (sel === ".container-item") {
        return this.children;
      }
      return [];
    }
  }

  const doc = {
    createElement: (tag) => new FakeEl(tag),
    createElementNS: (ns, tag) => {
      const el = new FakeEl(tag);
      el.ns = ns;
      return el;
    },
    createDocumentFragment: () => ({
      children: [],
      append(...nodes) {
        this.children.push(...nodes);
      },
    }),
  };

  return {
    doc,
    listEl: new FakeEl("ul"),
    emptyStateEl: new FakeEl("p"),
    searchInput: new FakeEl("input"),
  };
}

test("createContainerIconElement creates default SVG, safe masked icon, and dot fallback for unsafe URLs", () => {
  const { doc } = createMinimalDom();

  const defaultIcon = createContainerIconElement(doc, { isDefault: true });
  assert.equal(defaultIcon.tagName, "svg");
  assert.equal(defaultIcon.getAttribute("class"), "container-icon container-icon--default");
  assert.equal(defaultIcon.children.length, 2);

  const safeIcon = createContainerIconElement(doc, {
    isDefault: false,
    iconUrl: "resource://usercontext-content/fingerprint.svg",
  });
  assert.equal(safeIcon.className, "container-icon container-icon--masked");
  assert.equal(
    safeIcon.style.getPropertyValue("--container-icon-url"),
    'url("resource://usercontext-content/fingerprint.svg")'
  );

  const unsafeIcon = createContainerIconElement(doc, {
    isDefault: false,
    iconUrl: "https://evil.example/icon.svg",
  });
  assert.equal(unsafeIcon.className, "container-icon container-icon--dot");
});

test("createListRenderer renders rows, updates ARIA highlight/scroll, toggles empty state, and fires callbacks", () => {
  const { doc, listEl, emptyStateEl, searchInput } = createMinimalDom();
  const hovered = [];
  const selected = [];

  const renderer = createListRenderer({
    doc,
    listEl,
    emptyStateEl,
    searchInput,
    onHoverIndex: (idx) => hovered.push(idx),
    onSelectContainer: (id) => selected.push(id),
  });

  const items = [
    { cookieStoreId: "firefox-default", name: "Default", isDefault: true },
    {
      cookieStoreId: "firefox-container-1",
      name: "Work",
      colorCode: "#ff9f00",
      iconUrl: "resource://usercontext-content/briefcase.svg",
      isDefault: false,
    },
  ];

  renderer.render(items, 0);
  assert.equal(listEl.hidden, false);
  assert.equal(emptyStateEl.hidden, true);
  assert.equal(listEl.children.length, 2);
  assert.equal(listEl.children[0].className, "container-item container-item--default");
  assert.equal(listEl.children[0].children.at(-1).textContent, "firefox-default");
  assert.equal(listEl.children[1].style.getPropertyValue("--container-color"), "#ff9f00");
  assert.equal(searchInput.getAttribute("aria-activedescendant"), "container-option-0");

  renderer.updateActiveHighlight(1, { scroll: true });
  assert.equal(listEl.children[0].getAttribute("aria-selected"), "false");
  assert.equal(listEl.children[1].getAttribute("aria-selected"), "true");
  assert.equal(searchInput.getAttribute("aria-activedescendant"), "container-option-1");
  assert.deepEqual(listEl.children[1].scrollCalls, [{ block: "nearest" }]);

  listEl.children[0].dispatchEvent({ type: "mouseenter" });
  let prevented = false;
  listEl.children[1].dispatchEvent({
    type: "click",
    preventDefault: () => {
      prevented = true;
    },
  });
  assert.deepEqual(hovered, [0]);
  assert.deepEqual(selected, ["firefox-container-1"]);
  assert.equal(prevented, true);

  renderer.render([], -1);
  assert.equal(listEl.hidden, true);
  assert.equal(emptyStateEl.hidden, false);
  assert.equal(searchInput.getAttribute("aria-activedescendant"), null);
});
