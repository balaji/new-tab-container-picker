import { parseHttpUrl } from "../lib/tab-detection.js";

export const TAB_SESSION_SEEN_KEY = "ntcp_seen";
export const DEFAULT_RESTORED_TTL_MS = 5000;
export const DEFAULT_FORGOTTEN_TTL_MS = 5000;
export const DEFAULT_SYNC_TIMEOUT_MS = 100;

/**
 * Normalize an HTTP(S) URL into an exact hashless key and a scheme-agnostic key
 * (so http -> https HSTS upgrades on restore still match).
 * @param {unknown} rawUrl
 * @returns {{ urlKey: string, looseKey: string } | null}
 */
export function normalizeSessionUrlKeys(rawUrl) {
  const normalized = parseHttpUrl(rawUrl);
  if (!normalized) {
    return null;
  }
  try {
    const parsed = new URL(normalized);
    parsed.hash = "";
    return {
      urlKey: parsed.href,
      looseKey: `${parsed.host}${parsed.pathname}${parsed.search}`,
    };
  } catch {
    return {
      urlKey: normalized,
      looseKey: normalized,
    };
  }
}

function normalizeStoreKey(cookieStoreId) {
  return typeof cookieStoreId === "string" && cookieStoreId.length > 0
    ? cookieStoreId
    : null;
}

function extractTabEntry(tab) {
  const keys = normalizeSessionUrlKeys(tab?.url || tab?.pendingUrl);
  if (!keys) {
    return null;
  }
  return {
    urlKey: keys.urlKey,
    looseKey: keys.looseKey,
    storeKey: normalizeStoreKey(tab?.cookieStoreId),
  };
}

function buildClosedSessionSnapshot(recent) {
  const map = new Map();
  const order = [];
  if (!Array.isArray(recent)) {
    return { map, order };
  }

  for (const entry of recent) {
    if (
      entry?.tab &&
      typeof entry.tab.sessionId === "string" &&
      entry.tab.sessionId.length > 0 &&
      Number.isFinite(entry.tab.windowId)
    ) {
      const key = `t:${entry.tab.windowId}:${entry.tab.sessionId}`;
      const tabEntry = extractTabEntry(entry.tab);
      map.set(key, tabEntry ? [tabEntry] : []);
      order.push(key);
      continue;
    }

    if (
      entry?.window &&
      typeof entry.window.sessionId === "string" &&
      entry.window.sessionId.length > 0 &&
      Array.isArray(entry.window.tabs)
    ) {
      const key = `w:${entry.window.sessionId}`;
      const tabEntries = [];
      for (const tab of entry.window.tabs) {
        const extracted = extractTabEntry(tab);
        if (extracted) {
          tabEntries.push(extracted);
        }
      }
      map.set(key, tabEntries);
      order.push(key);
    }
  }

  return { map, order };
}

function entryMatchesRequest(entry, requestKeys, requestStoreKey) {
  if (!entry || !requestKeys) {
    return false;
  }
  const urlMatches =
    entry.urlKey === requestKeys.urlKey ||
    entry.looseKey === requestKeys.looseKey;
  if (!urlMatches) {
    return false;
  }
  if (
    entry.storeKey !== null &&
    requestStoreKey !== null &&
    entry.storeKey !== requestStoreKey
  ) {
    return false;
  }
  return true;
}

/**
 * Track previously seen tabs and recently closed sessions so Cmd+Shift+T / Cmd+Shift+N
 * (and History -> Recently Closed Tabs) restores are never mistaken for external links.
 *
 * Uses two complementary layers:
 * 1. `sessions.getRecentlyClosed()` snapshot diffing (catches restores even for tabs
 *    closed before the extension was enabled, and avoids getTabValue hydration races).
 * 2. `sessions.setTabValue()` / `sessions.getTabValue()` stamping on settled tabs
 *    (persists in Firefox's SessionStore across MV3 event-page suspensions and restarts).
 *
 * @param {object} browserApi
 * @param {{
 *   restoredTtlMs?: number,
 *   forgottenTtlMs?: number,
 *   syncTimeoutMs?: number,
 * }} [deps]
 */
export function createSessionRestoreTracker(browserApi, deps = {}) {
  const restoredTtlMs = deps.restoredTtlMs ?? DEFAULT_RESTORED_TTL_MS;
  const forgottenTtlMs = deps.forgottenTtlMs ?? DEFAULT_FORGOTTEN_TTL_MS;
  const syncTimeoutMs = deps.syncTimeoutMs ?? DEFAULT_SYNC_TIMEOUT_MS;

  let hasSnapshot = false;
  /** @type {Map<string, Array<{ urlKey: string, looseKey: string, storeKey: string | null }>>} */
  let knownClosedSessions = new Map();
  /** @type {string[]} */
  let knownClosedOrder = [];
  /** @type {Set<{ urlKey: string, looseKey: string, storeKey: string | null, timerId: ReturnType<typeof setTimeout> }>} */
  const recentlyRestored = new Set();
  /** @type {Map<string, ReturnType<typeof setTimeout>>} */
  const selfForgottenKeys = new Map();
  /** @type {Set<number>} */
  const stampedTabIds = new Set();
  /** @type {Promise<void> | null} */
  let activeSync = null;
  let rerunSync = false;

  function addRecentlyRestoredEntry(entry) {
    const record = {
      urlKey: entry.urlKey,
      looseKey: entry.looseKey,
      storeKey: entry.storeKey,
      timerId: null,
    };
    record.timerId = setTimeout(() => {
      recentlyRestored.delete(record);
    }, restoredTtlMs);
    recentlyRestored.add(record);
  }

  function clearRecentlyRestoredEntry(record) {
    if (!record) {
      return;
    }
    clearTimeout(record.timerId);
    recentlyRestored.delete(record);
  }

  function clearForgottenKey(key) {
    const timerId = selfForgottenKeys.get(key);
    if (timerId !== undefined) {
      clearTimeout(timerId);
      selfForgottenKeys.delete(key);
    }
  }

  /**
   * Record that our own cleaner is forgetting a closed session key so its removal
   * from `sessions.getRecentlyClosed()` is never treated as a user Cmd+Shift+T restore.
   * @param {string} key
   */
  function markSessionForgotten(key) {
    if (typeof key !== "string" || key.length === 0) {
      return;
    }
    clearForgottenKey(key);
    knownClosedSessions.delete(key);
    knownClosedOrder = knownClosedOrder.filter((k) => k !== key);
    const timerId = setTimeout(() => {
      selfForgottenKeys.delete(key);
    }, forgottenTtlMs);
    selfForgottenKeys.set(key, timerId);
  }

  /**
   * Stamp a settled non-incognito tab in Firefox's SessionStore so if it is later
   * closed and restored via Cmd+Shift+T / Cmd+Shift+N, `getTabValue` identifies it.
   * @param {number} tabId
   */
  function markTabSeen(tabId) {
    if (
      typeof tabId !== "number" ||
      stampedTabIds.has(tabId) ||
      typeof browserApi?.sessions?.setTabValue !== "function"
    ) {
      return;
    }
    stampedTabIds.add(tabId);
    try {
      Promise.resolve(
        browserApi.sessions.setTabValue(tabId, TAB_SESSION_SEEN_KEY, 1)
      ).catch(() => {
        stampedTabIds.delete(tabId);
      });
    } catch {
      stampedTabIds.delete(tabId);
    }
  }

  /**
   * Stamp all currently open eligible tabs so existing tabs closed later are
   * recognized as restored tabs on Cmd+Shift+T.
   * @param {(tab: object) => boolean} [shouldSkipTab]
   */
  async function stampOpenTabs(shouldSkipTab) {
    if (
      typeof browserApi?.tabs?.query !== "function" ||
      typeof browserApi?.sessions?.setTabValue !== "function"
    ) {
      return;
    }
    let tabs;
    try {
      tabs = await browserApi.tabs.query({});
    } catch {
      return;
    }
    if (!Array.isArray(tabs)) {
      return;
    }
    for (const tab of tabs) {
      if (
        !tab ||
        typeof tab.id !== "number" ||
        tab.incognito === true ||
        shouldSkipTab?.(tab)
      ) {
        continue;
      }
      markTabSeen(tab.id);
    }
  }

  function applySnapshot(recent) {
    if (!Array.isArray(recent)) {
      return;
    }

    const { map: nextMap, order: nextOrder } =
      buildClosedSessionSnapshot(recent);

    if (hasSnapshot && knownClosedSessions.size > 0) {
      let newCount = 0;
      for (const key of nextOrder) {
        if (!knownClosedSessions.has(key)) {
          newCount += 1;
        }
      }

      // If new closed entries pushed oldest entries off the capped tail of Firefox's
      // recently closed list, avoid treating those evicted tail entries as restores.
      const evictedTailKeys = new Set();
      if (newCount > 0 && nextMap.size >= knownClosedSessions.size) {
        for (
          let i = Math.max(0, knownClosedOrder.length - newCount);
          i < knownClosedOrder.length;
          i += 1
        ) {
          const tailKey = knownClosedOrder[i];
          if (!nextMap.has(tailKey)) {
            evictedTailKeys.add(tailKey);
          }
        }
      }

      for (const [key, entries] of knownClosedSessions.entries()) {
        if (
          nextMap.has(key) ||
          selfForgottenKeys.has(key) ||
          evictedTailKeys.has(key)
        ) {
          continue;
        }
        for (const entry of entries) {
          addRecentlyRestoredEntry(entry);
        }
      }
    }

    knownClosedSessions = nextMap;
    knownClosedOrder = nextOrder;
    hasSnapshot = true;
  }

  async function runSyncLoop() {
    do {
      rerunSync = false;
      let recent;
      try {
        recent = await browserApi.sessions.getRecentlyClosed();
      } catch {
        break;
      }
      applySnapshot(recent);
    } while (rerunSync);
  }

  /**
   * Refresh the closed-session snapshot and record any closed tabs/windows
   * that disappeared because the user restored them.
   * @returns {Promise<void>}
   */
  async function syncRecentlyClosed() {
    if (typeof browserApi?.sessions?.getRecentlyClosed !== "function") {
      return;
    }
    if (activeSync) {
      rerunSync = true;
      return activeSync;
    }
    activeSync = runSyncLoop();
    try {
      await activeSync;
    } finally {
      activeSync = null;
      rerunSync = false;
    }
  }

  function consumeRecentlyRestored(rawUrl, cookieStoreId) {
    const requestKeys = normalizeSessionUrlKeys(rawUrl);
    if (!requestKeys) {
      return false;
    }
    const requestStoreKey = normalizeStoreKey(cookieStoreId);

    for (const record of recentlyRestored) {
      if (entryMatchesRequest(record, requestKeys, requestStoreKey)) {
        clearRecentlyRestoredEntry(record);
        return true;
      }
    }
    return false;
  }

  function hasKnownClosedMatch(rawUrl, cookieStoreId) {
    const requestKeys = normalizeSessionUrlKeys(rawUrl);
    if (!requestKeys) {
      return false;
    }
    const requestStoreKey = normalizeStoreKey(cookieStoreId);

    for (const entries of knownClosedSessions.values()) {
      for (const entry of entries) {
        if (entryMatchesRequest(entry, requestKeys, requestStoreKey)) {
          return true;
        }
      }
    }
    return false;
  }

  /**
   * Determine whether a tab/request comes from a restored closed tab or window.
   * Never blocks on `sessions.getRecentlyClosed()` unless a prior snapshot already
   * contains a matching closed URL, and bounds any live refresh with a short timeout.
   * @param {{ tabId: number, url: string, cookieStoreId?: string }} details
   * @returns {Promise<boolean>}
   */
  async function isRestoredTab({ tabId, url, cookieStoreId }) {
    if (consumeRecentlyRestored(url, cookieStoreId)) {
      return true;
    }

    if (
      typeof tabId === "number" &&
      typeof browserApi?.sessions?.getTabValue === "function"
    ) {
      try {
        const seen = await browserApi.sessions.getTabValue(
          tabId,
          TAB_SESSION_SEEN_KEY
        );
        if (seen) {
          return true;
        }
      } catch {
        // Ignore getTabValue errors (e.g. incognito or transient tab states)
      }
    }

    if (hasSnapshot && hasKnownClosedMatch(url, cookieStoreId)) {
      let timeoutId;
      try {
        await Promise.race([
          syncRecentlyClosed(),
          new Promise((resolve) => {
            timeoutId = setTimeout(resolve, syncTimeoutMs);
          }),
        ]);
      } finally {
        clearTimeout(timeoutId);
      }
      if (consumeRecentlyRestored(url, cookieStoreId)) {
        return true;
      }
    }

    return false;
  }

  function handleTabRemoved(tabId) {
    stampedTabIds.delete(tabId);
  }

  function clearAll() {
    hasSnapshot = false;
    knownClosedSessions.clear();
    knownClosedOrder = [];
    for (const record of [...recentlyRestored]) {
      clearRecentlyRestoredEntry(record);
    }
    for (const key of [...selfForgottenKeys.keys()]) {
      clearForgottenKey(key);
    }
    stampedTabIds.clear();
    rerunSync = false;
  }

  return {
    markTabSeen,
    stampOpenTabs,
    markSessionForgotten,
    updateSnapshot: applySnapshot,
    syncRecentlyClosed,
    isRestoredTab,
    handleTabRemoved,
    clearAll,
    destroy: clearAll,
  };
}
