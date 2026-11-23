import { filterContainers, getNextIndex } from "../lib/filter.js";
import { createStatusAnnouncer } from "./announcer.js";
import { createKeyboardHandler } from "./keyboard-handler.js";
import { createListRenderer } from "./list-renderer.js";
import { createPickerClient } from "./picker-client.js";

const FOCUS_FALLBACK_DELAY_MS = 50;
const DEFAULT_EMPTY_STATE_TEXT = "No matching containers";

export const UNAVAILABLE_MESSAGES = Object.freeze({
  "private-window": "Container tabs aren\u2019t available in Private Windows.",
  "containers-disabled":
    "Container Tabs are disabled or no containers exist. Enable Container Tabs in Firefox Settings (General \u2192 Tabs).",
});

/**
 * Initialize and control the container picker toolbar popup UI.
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
  const targetUrlBanner = doc.getElementById("target-url-banner");
  const targetUrlText = doc.getElementById("target-url-text");
  const errorEl = doc.getElementById("picker-error");

  let allContainers = [];
  let filteredContainers = [];
  let activeIndex = 0;
  let autoOpenSingleMatch = false;
  let unavailableReason = null;
  let isComposing = false;
  let focusTimerId = null;
  let destroyed = false;

  const announcer = createStatusAnnouncer(announcerEl);

  function focusSearchInput() {
    if (
      !destroyed &&
      !unavailableReason &&
      !client.isSettled() &&
      searchInput &&
      !searchInput.disabled &&
      typeof searchInput.focus === "function"
    ) {
      searchInput.focus();
    }
  }

  function setErrorMessage(message) {
    if (!errorEl) {
      return;
    }
    errorEl.textContent = message ?? "";
    errorEl.hidden = !message;
  }

  const client = createPickerClient({
    browserApi,
    win,
    announcer,
    onPreviewReset: () => {
      searchInput.value = "";
      applyFilter();
    },
    onError: (message) => {
      setErrorMessage(message);
      focusSearchInput();
    },
  });

  if (client.isInTabMode) {
    doc.documentElement?.setAttribute?.("data-mode", "tab");
  }

  if (client.targetUrl) {
    if (targetUrlBanner) {
      targetUrlBanner.hidden = false;
      targetUrlBanner.setAttribute?.("title", client.targetUrl);
    }
    if (targetUrlText) {
      targetUrlText.textContent = client.targetUrl;
    }
    try {
      const { host } = new URL(client.targetUrl);
      if (host) {
        doc.title = `Open ${host} in Container`;
      }
    } catch {
      // Keep default document title
    }
  }

  function pickContainer(cookieStoreId) {
    setErrorMessage("");
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
    if (client.isSettled() || unavailableReason) {
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

  const scheduleTimeout =
    typeof win.setTimeout === "function"
      ? win.setTimeout.bind(win)
      : setTimeout;
  const cancelTimeout =
    typeof win.clearTimeout === "function"
      ? win.clearTimeout.bind(win)
      : clearTimeout;

  focusTimerId = scheduleTimeout(() => {
    focusTimerId = null;
    if (doc.activeElement !== settingsBtn) {
      focusSearchInput();
    }
  }, FOCUS_FALLBACK_DELAY_MS);

  function cleanup() {
    destroyed = true;
    if (focusTimerId !== null) {
      cancelTimeout(focusTimerId);
      focusTimerId = null;
    }
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

  if (loaded.unavailableReason) {
    unavailableReason = loaded.unavailableReason;
    allContainers = [];
    filteredContainers = [];
    activeIndex = -1;
    autoOpenSingleMatch = false;

    if (searchInput) {
      searchInput.disabled = true;
      searchInput.setAttribute?.("aria-disabled", "true");
    }
    listRenderer.render([], -1);

    const message =
      UNAVAILABLE_MESSAGES[unavailableReason] ?? DEFAULT_EMPTY_STATE_TEXT;
    if (emptyStateEl) {
      emptyStateEl.textContent = message;
      emptyStateEl.hidden = false;
    }
    announcer.announceImmediate(message);
  } else {
    unavailableReason = null;
    if (searchInput) {
      searchInput.disabled = false;
      searchInput.removeAttribute?.("aria-disabled");
    }
    if (emptyStateEl) {
      emptyStateEl.textContent = DEFAULT_EMPTY_STATE_TEXT;
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
  }

  return {
    getState: () => ({
      allContainers,
      filteredContainers,
      activeIndex,
      autoOpenSingleMatch,
      unavailableReason,
    }),
    destroy: cleanup,
  };
}

if (typeof document !== "undefined" && document.getElementById("container-search")) {
  createPickerController();
}
