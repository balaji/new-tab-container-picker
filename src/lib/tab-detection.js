import { DEFAULT_COOKIE_STORE_ID } from "./containers.js";

/**
 * Determine whether a newly created tab should be ignored by the container picker.
 * @param {object} tab
 * @param {{ enabled?: boolean, ignoredTabIds?: Set<number>, activePopupWindowId?: number | null }} context
 * @returns {boolean}
 */
export function shouldIgnoreCreatedTab(tab, context = {}) {
  if (!context.enabled) {
    return true;
  }

  if (!tab || typeof tab.id !== "number") {
    return true;
  }

  if (tab.incognito === true || tab.pinned === true) {
    return true;
  }

  if (tab.openerTabId !== undefined) {
    return true;
  }

  if (tab.cookieStoreId && tab.cookieStoreId !== DEFAULT_COOKIE_STORE_ID) {
    return true;
  }

  if (context.ignoredTabIds && context.ignoredTabIds.has(tab.id)) {
    return true;
  }

  if (
    context.activePopupWindowId != null &&
    tab.windowId === context.activePopupWindowId
  ) {
    return true;
  }

  return false;
}

/**
 * Classify a tab URL into "newtab", "pending", or "other".
 * @param {unknown} url
 * @returns {"newtab" | "pending" | "other"}
 */
export function classifyTabUrl(url) {
  if (url === "about:newtab") {
    return "newtab";
  }

  if (url === "" || url === undefined || url === null || url === "about:blank") {
    return "pending";
  }

  return "other";
}

/**
 * Only trigger the picker in normal browser windows that already have >1 tab
 * (avoiding browser startup, Cmd+N new windows, and popups).
 * @param {object | null | undefined} win
 * @returns {boolean}
 */
export function shouldTriggerForWindow(win) {
  return Boolean(
    win &&
      win.type === "normal" &&
      Array.isArray(win.tabs) &&
      win.tabs.length > 1
  );
}
