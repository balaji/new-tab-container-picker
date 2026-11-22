import { filterContainers, getNextIndex } from "../lib/filter.js";

const SAFE_ICON_URL_RE = /^resource:\/\/usercontext-content\/[a-z0-9_-]+\.svg$/i;

const PREVIEW_CONTAINERS = [
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
  {
    cookieStoreId: "firefox-container-2",
    name: "Work",
    color: "orange",
    colorCode: "#ff9f00",
    icon: "briefcase",
    iconUrl: null,
    isDefault: false,
  },
  {
    cookieStoreId: "firefox-container-3",
    name: "Banking",
    color: "green",
    colorCode: "#51cd00",
    icon: "dollar",
    iconUrl: null,
    isDefault: false,
  },
  {
    cookieStoreId: "firefox-container-4",
    name: "Shopping",
    color: "pink",
    colorCode: "#ff4bda",
    icon: "cart",
    iconUrl: null,
    isDefault: false,
  },
];

function createDefaultIconElement(doc) {
  const svgNs = "http://www.w3.org/2000/svg";
  const svg = doc.createElementNS(svgNs, "svg");
  svg.setAttribute("class", "container-icon container-icon--default");
  svg.setAttribute("viewBox", "0 0 16 16");
  svg.setAttribute("fill", "none");
  svg.setAttribute("aria-hidden", "true");

  const rect = doc.createElementNS(svgNs, "rect");
  rect.setAttribute("x", "2.25");
  rect.setAttribute("y", "3");
  rect.setAttribute("width", "11.5");
  rect.setAttribute("height", "10");
  rect.setAttribute("rx", "2");
  rect.setAttribute("stroke", "currentColor");
  rect.setAttribute("stroke-width", "1.4");

  const path = doc.createElementNS(svgNs, "path");
  path.setAttribute("d", "M2.5 6.25H13.5");
  path.setAttribute("stroke", "currentColor");
  path.setAttribute("stroke-width", "1.3");

  svg.append(rect, path);
  return svg;
}

function createContainerIconElement(doc, container) {
  if (container.isDefault) {
    return createDefaultIconElement(doc);
  }

  const iconEl = doc.createElement("span");
  iconEl.setAttribute("aria-hidden", "true");

  if (typeof container.iconUrl === "string" && SAFE_ICON_URL_RE.test(container.iconUrl)) {
    iconEl.className = "container-icon container-icon--masked";
    iconEl.style.setProperty("--container-icon-url", `url("${container.iconUrl}")`);
  } else {
    iconEl.className = "container-icon container-icon--dot";
  }

  return iconEl;
}

/**
 * Initialize and control the floating container picker popup UI.
 * @param {{ browserApi?: object, doc?: Document, win?: Window }} [deps]
 */
export async function createPickerController(deps = {}) {
  const doc = deps.doc ?? document;
  const win = deps.win ?? window;
  const browserApi = deps.browserApi ?? globalThis.browser;

  const searchInput = doc.getElementById("container-search");
  const listEl = doc.getElementById("container-list");
  const emptyStateEl = doc.getElementById("empty-state");
  const announcerEl = doc.getElementById("status-announcer");
  const settingsBtn = doc.getElementById("open-settings");

  const params = new URLSearchParams(win.location?.search ?? "");
  const requestedSessionId = params.get("session") ?? "";
  const isPreviewMode = !browserApi?.runtime?.sendMessage && params.get("preview") === "1";

  let sessionId = requestedSessionId;
  let allContainers = [];
  let filteredContainers = [];
  let activeIndex = 0;
  let autoOpenSingleMatch = false;
  let isComposing = false;
  let settled = false;
  let announceTimer = null;

  function focusSearchInput() {
    if (searchInput && typeof searchInput.focus === "function") {
      searchInput.focus();
    }
  }

  function scheduleAnnouncement(count, hasQuery) {
    if (!announcerEl) {
      return;
    }
    clearTimeout(announceTimer);
    announceTimer = setTimeout(() => {
      if (!hasQuery && count > 0) {
        announcerEl.textContent = "";
        return;
      }
      if (count === 0) {
        announcerEl.textContent = "No matching containers";
      } else if (count === 1) {
        announcerEl.textContent = "1 matching container";
      } else {
        announcerEl.textContent = `${count} matching containers`;
      }
    }, 180);
  }

  function updateActiveHighlight({ scroll = true } = {}) {
    const items = listEl.querySelectorAll(".container-item");
    let activeId = "";

    items.forEach((el, idx) => {
      const isSelected = idx === activeIndex;
      el.setAttribute("aria-selected", isSelected ? "true" : "false");
      if (isSelected) {
        activeId = el.id;
        if (scroll && typeof el.scrollIntoView === "function") {
          el.scrollIntoView({ block: "nearest" });
        }
      }
    });

    if (activeId) {
      searchInput.setAttribute("aria-activedescendant", activeId);
    } else {
      searchInput.removeAttribute("aria-activedescendant");
    }
  }

  function renderList() {
    const fragment = doc.createDocumentFragment();

    filteredContainers.forEach((container, index) => {
      const li = doc.createElement("li");
      li.id = `container-option-${index}`;
      li.setAttribute("role", "option");
      li.setAttribute("aria-selected", index === activeIndex ? "true" : "false");
      li.dataset.cookieStoreId = container.cookieStoreId;

      if (container.isDefault) {
        li.className = "container-item container-item--default";
      } else {
        li.className = "container-item container-item--colored";
        if (container.colorCode) {
          li.style.setProperty("--container-color", container.colorCode);
        }
      }

      const iconEl = createContainerIconElement(doc, container);
      const nameEl = doc.createElement("span");
      nameEl.className = "container-name";
      nameEl.textContent = container.name;

      li.append(iconEl, nameEl);

      if (container.isDefault) {
        const badgeEl = doc.createElement("span");
        badgeEl.className = "container-badge";
        badgeEl.textContent = "No container";
        li.append(badgeEl);
      }

      li.addEventListener("mouseenter", () => {
        if (activeIndex !== index) {
          activeIndex = index;
          updateActiveHighlight({ scroll: false });
        }
      });

      li.addEventListener("click", (event) => {
        event.preventDefault();
        pickContainer(container.cookieStoreId);
      });

      fragment.append(li);
    });

    listEl.replaceChildren(fragment);

    const isEmpty = filteredContainers.length === 0;
    listEl.hidden = isEmpty;
    emptyStateEl.hidden = !isEmpty;

    updateActiveHighlight({ scroll: false });
  }

  async function pickContainer(cookieStoreId) {
    if (settled) {
      return;
    }
    settled = true;
    clearTimeout(announceTimer);

    if (isPreviewMode) {
      const chosen = allContainers.find((c) => c.cookieStoreId === cookieStoreId);
      if (announcerEl && chosen) {
        announcerEl.textContent = `Preview selected: ${chosen.name}`;
      }
      settled = false;
      return;
    }

    try {
      await browserApi?.runtime?.sendMessage({
        type: "PICK_CONTAINER",
        sessionId,
        cookieStoreId,
      });
    } catch {
      win.close?.();
    }
  }

  async function cancelEscape() {
    if (settled) {
      return;
    }
    settled = true;
    clearTimeout(announceTimer);

    if (isPreviewMode) {
      searchInput.value = "";
      applyFilter();
      settled = false;
      return;
    }

    try {
      await browserApi?.runtime?.sendMessage({
        type: "CANCEL_ESCAPE",
        sessionId,
      });
    } catch {
      win.close?.();
    }
  }

  async function openSettings() {
    if (settled) {
      return;
    }

    if (isPreviewMode) {
      if (announcerEl) {
        announcerEl.textContent = "Preview mode: settings unavailable";
      }
      return;
    }

    settled = true;
    clearTimeout(announceTimer);

    try {
      await browserApi?.runtime?.sendMessage({
        type: "OPEN_OPTIONS",
        sessionId,
      });
    } catch {
      try {
        await browserApi?.runtime?.openOptionsPage?.();
      } catch {
        // Ignore fallback openOptionsPage failures
      } finally {
        win.close?.();
      }
    }
  }

  function applyFilter(event) {
    if (settled) {
      return;
    }
    const query = searchInput.value;
    const hasQuery = query.trim().length > 0;
    filteredContainers = filterContainers(allContainers, query);
    activeIndex = filteredContainers.length > 0 ? 0 : -1;
    renderList();

    const composing = isComposing || Boolean(event?.isComposing);
    if (
      autoOpenSingleMatch &&
      hasQuery &&
      !composing &&
      filteredContainers.length === 1
    ) {
      clearTimeout(announceTimer);
      pickContainer(filteredContainers[0].cookieStoreId);
      return;
    }

    scheduleAnnouncement(filteredContainers.length, hasQuery);
  }

  function handleCompositionStart() {
    isComposing = true;
  }

  function handleCompositionEnd() {
    isComposing = false;
    applyFilter();
  }

  function handleKeyDown(event) {
    if (event.key === "Escape") {
      event.preventDefault();
      cancelEscape();
      return;
    }

    const isSettingsFocused = Boolean(
      settingsBtn && doc.activeElement === settingsBtn
    );
    if (isSettingsFocused && (event.key === "Enter" || event.key === " ")) {
      return;
    }

    if (event.key === "ArrowDown" || (event.ctrlKey && event.key.toLowerCase() === "n")) {
      event.preventDefault();
      if (isSettingsFocused) {
        focusSearchInput();
      }
      activeIndex = getNextIndex(activeIndex, 1, filteredContainers.length);
      updateActiveHighlight({ scroll: true });
      return;
    }

    if (event.key === "ArrowUp" || (event.ctrlKey && event.key.toLowerCase() === "p")) {
      event.preventDefault();
      if (isSettingsFocused) {
        focusSearchInput();
      }
      activeIndex = getNextIndex(activeIndex, -1, filteredContainers.length);
      updateActiveHighlight({ scroll: true });
      return;
    }

    if (
      (event.key === "Home" || event.key === "End") &&
      filteredContainers.length > 0 &&
      (doc.activeElement !== searchInput || searchInput.value === "")
    ) {
      event.preventDefault();
      activeIndex = event.key === "Home" ? 0 : filteredContainers.length - 1;
      updateActiveHighlight({ scroll: true });
      return;
    }

    if (event.key === "Enter") {
      event.preventDefault();
      if (activeIndex >= 0 && filteredContainers[activeIndex]) {
        pickContainer(filteredContainers[activeIndex].cookieStoreId);
      }
      return;
    }

    if (
      event.key.length === 1 &&
      !event.ctrlKey &&
      !event.metaKey &&
      !event.altKey &&
      doc.activeElement !== searchInput
    ) {
      focusSearchInput();
    }
  }

  searchInput.addEventListener("input", applyFilter);
  searchInput.addEventListener("compositionstart", handleCompositionStart);
  searchInput.addEventListener("compositionend", handleCompositionEnd);
  settingsBtn?.addEventListener("click", openSettings);
  doc.addEventListener("keydown", handleKeyDown);
  win.addEventListener("focus", focusSearchInput);

  focusSearchInput();
  if (typeof win.requestAnimationFrame === "function") {
    win.requestAnimationFrame(focusSearchInput);
  }

  function cleanup() {
    clearTimeout(announceTimer);
    searchInput.removeEventListener("input", applyFilter);
    searchInput.removeEventListener("compositionstart", handleCompositionStart);
    searchInput.removeEventListener("compositionend", handleCompositionEnd);
    settingsBtn?.removeEventListener("click", openSettings);
    doc.removeEventListener("keydown", handleKeyDown);
    win.removeEventListener("focus", focusSearchInput);
  }

  if (isPreviewMode) {
    allContainers = PREVIEW_CONTAINERS.slice();
    filteredContainers = allContainers.slice();
    activeIndex = 0;
    autoOpenSingleMatch = params.get("autoOpen") === "1";
    renderList();
    return {
      getState: () => ({
        allContainers,
        filteredContainers,
        activeIndex,
        autoOpenSingleMatch,
      }),
      destroy: cleanup,
    };
  }

  try {
    const state = await browserApi?.runtime?.sendMessage({
      type: "GET_PICKER_STATE",
      sessionId: requestedSessionId,
    });
    if (!state || !Array.isArray(state.containers)) {
      cleanup();
      win.close?.();
      return null;
    }
    sessionId = state.sessionId || requestedSessionId;
    allContainers = state.containers;
    autoOpenSingleMatch = Boolean(state.settings?.autoOpenSingleMatch);
    if (searchInput.value.length > 0) {
      applyFilter();
    } else {
      filteredContainers = allContainers.slice();
      activeIndex = filteredContainers.length > 0 ? 0 : -1;
      renderList();
    }
    if (!settled) {
      focusSearchInput();
    }
  } catch {
    cleanup();
    win.close?.();
    return null;
  }

  return {
    getState: () => ({
      allContainers,
      filteredContainers,
      activeIndex,
      autoOpenSingleMatch,
    }),
    destroy: cleanup,
  };
}

if (typeof document !== "undefined" && document.getElementById("container-search")) {
  createPickerController();
}
