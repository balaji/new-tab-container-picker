import { filterContainers, getNextIndex } from "../lib/filter.js";
import { createStatusAnnouncer } from "./announcer.js";
import { createKeyboardHandler } from "./keyboard-handler.js";
import { createListRenderer } from "./list-renderer.js";
import { createPickerClient } from "./picker-client.js";

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

  let allContainers = [];
  let filteredContainers = [];
  let activeIndex = 0;
  let autoOpenSingleMatch = false;
  let isComposing = false;

  const announcer = createStatusAnnouncer(announcerEl);

  function focusSearchInput() {
    if (searchInput && typeof searchInput.focus === "function") {
      searchInput.focus();
    }
  }

  const client = createPickerClient({
    browserApi,
    win,
    announcer,
    onPreviewReset: () => {
      searchInput.value = "";
      applyFilter();
    },
  });

  function pickContainer(cookieStoreId) {
    const chosen = allContainers.find((c) => c.cookieStoreId === cookieStoreId);
    return client.pickContainer(cookieStoreId, chosen?.name);
  }

  const listRenderer = createListRenderer({
    doc,
    listEl,
    emptyStateEl,
    searchInput,
    onHoverIndex(index) {
      if (activeIndex !== index) {
        activeIndex = index;
        listRenderer.updateActiveHighlight(activeIndex, { scroll: false });
      }
    },
    onSelectContainer: pickContainer,
  });

  function applyFilter(event) {
    if (client.isSettled()) {
      return;
    }
    const query = searchInput.value;
    const hasQuery = query.trim().length > 0;
    filteredContainers = filterContainers(allContainers, query);
    activeIndex = filteredContainers.length > 0 ? 0 : -1;
    listRenderer.render(filteredContainers, activeIndex);

    const composing = isComposing || Boolean(event?.isComposing);
    if (
      autoOpenSingleMatch &&
      hasQuery &&
      !composing &&
      filteredContainers.length === 1
    ) {
      announcer.clear();
      pickContainer(filteredContainers[0].cookieStoreId);
      return;
    }

    announcer.announceFilterCount(filteredContainers.length, hasQuery);
  }

  function handleCompositionStart() {
    isComposing = true;
  }

  function handleCompositionEnd() {
    isComposing = false;
    applyFilter();
  }

  const handleKeyDown = createKeyboardHandler({
    doc,
    searchInput,
    settingsBtn,
    focusSearchInput,
    getItemCount: () => filteredContainers.length,
    onMove(delta) {
      activeIndex = getNextIndex(activeIndex, delta, filteredContainers.length);
      listRenderer.updateActiveHighlight(activeIndex, { scroll: true });
    },
    onJump(edge) {
      activeIndex = edge === "start" ? 0 : filteredContainers.length - 1;
      listRenderer.updateActiveHighlight(activeIndex, { scroll: true });
    },
    onConfirm() {
      if (activeIndex >= 0 && filteredContainers[activeIndex]) {
        pickContainer(filteredContainers[activeIndex].cookieStoreId);
      }
    },
    onCancel: () => client.cancelEscape(),
  });

  searchInput.addEventListener("input", applyFilter);
  searchInput.addEventListener("compositionstart", handleCompositionStart);
  searchInput.addEventListener("compositionend", handleCompositionEnd);
  settingsBtn?.addEventListener("click", client.openSettings);
  doc.addEventListener("keydown", handleKeyDown);
  win.addEventListener("focus", focusSearchInput);

  focusSearchInput();
  if (typeof win.requestAnimationFrame === "function") {
    win.requestAnimationFrame(focusSearchInput);
  }

  function cleanup() {
    announcer.clear();
    searchInput.removeEventListener("input", applyFilter);
    searchInput.removeEventListener("compositionstart", handleCompositionStart);
    searchInput.removeEventListener("compositionend", handleCompositionEnd);
    settingsBtn?.removeEventListener("click", client.openSettings);
    doc.removeEventListener("keydown", handleKeyDown);
    win.removeEventListener("focus", focusSearchInput);
  }

  const loaded = await client.loadState();
  if (!loaded) {
    cleanup();
    win.close?.();
    return null;
  }

  allContainers = loaded.containers;
  autoOpenSingleMatch = loaded.autoOpenSingleMatch;

  if (!loaded.isPreview && searchInput.value.length > 0) {
    applyFilter();
  } else {
    filteredContainers = allContainers.slice();
    activeIndex = filteredContainers.length > 0 ? 0 : -1;
    listRenderer.render(filteredContainers, activeIndex);
  }

  if (!loaded.isPreview && !client.isSettled()) {
    focusSearchInput();
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
