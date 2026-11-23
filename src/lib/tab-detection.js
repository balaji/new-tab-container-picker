import { DEFAULT_COOKIE_STORE_ID } from "./containers.js";

/**
 * Determine whether a newly created tab should be ignored by the container picker.
 * @param {object} tab
 * @param {{ enabled?: boolean, ignoredTabIds?: Set<number> }} [context]
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

  return false;
}

/**
 * Return the tab's pending navigation URL when present, otherwise its current URL.
 * Prevents an initial "about:blank" URL from shadowing a real pendingUrl.
 * @param {object | null | undefined} tab
 * @returns {unknown}
 */
export function getEffectiveTabUrl(tab) {
  if (!tab || typeof tab !== "object") {
    return undefined;
  }

  if (typeof tab.pendingUrl === "string" && tab.pendingUrl.length > 0) {
    return tab.pendingUrl;
  }

  return tab.url;
}

/**
 * Validate and normalize an HTTP(S) URL string, returning null for non-HTTP(S) or invalid values.
 * @param {unknown} rawUrl
 * @returns {string | null}
 */
export function parseHttpUrl(rawUrl) {
  if (typeof rawUrl !== "string" || rawUrl.length === 0) {
    return null;
  }

  try {
    const parsed = new URL(rawUrl);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return null;
    }
    return parsed.href;
  } catch {
    return null;
  }
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
