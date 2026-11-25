import { isOwnPickerUrl } from "./browser-actions.js";
import { normalizeSessionUrlKeys } from "./session-restore-tracker.js";

export const DEFAULT_MAX_PASSES = 5;
export const DEFAULT_REPLACED_TAB_TTL_MS = 5000;

/**
 * Determine whether a closed session window contains exclusively our picker page.
 * @param {{ getURL?: (path: string) => string } | undefined} runtimeApi
 * @param {object | null | undefined} closedWindow
 * @returns {boolean}
 */
export function isClosedPickerWindow(runtimeApi, closedWindow) {
  if (
    !closedWindow ||
    typeof closedWindow.sessionId !== "string" ||
    closedWindow.sessionId.length === 0 ||
    !Array.isArray(closedWindow.tabs) ||
    closedWindow.tabs.length === 0
  ) {
    return false;
  }

  return closedWindow.tabs.every((tab) =>
    isOwnPickerUrl(runtimeApi, tab?.url || tab?.pendingUrl)
  );
}

/**
 * Determine whether a closed session tab points to our picker page.
 * @param {{ getURL?: (path: string) => string } | undefined} runtimeApi
 * @param {object | null | undefined} closedTab
 * @returns {boolean}
 */
export function isClosedPickerTab(runtimeApi, closedTab) {
  if (
    !closedTab ||
    typeof closedTab.sessionId !== "string" ||
    closedTab.sessionId.length === 0 ||
    !Number.isFinite(closedTab.windowId)
  ) {
    return false;
  }

  return isOwnPickerUrl(runtimeApi, closedTab.url || closedTab.pendingUrl);
}

function matchesExpectedReplacedTab(closedTab, expected) {
  if (
    !closedTab ||
    typeof closedTab.sessionId !== "string" ||
    closedTab.sessionId.length === 0 ||
    !Number.isFinite(closedTab.windowId) ||
    closedTab.windowId !== expected.windowId
  ) {
    return false;
  }

  const closedKeys = normalizeSessionUrlKeys(
    closedTab.url || closedTab.pendingUrl
  );
  if (!closedKeys) {
    return false;
  }

  const urlMatches =
    closedKeys.urlKey === expected.urlKey ||
    closedKeys.looseKey === expected.looseKey;
  if (!urlMatches) {
    return false;
  }

  if (
    expected.cookieStoreId &&
    typeof closedTab.cookieStoreId === "string" &&
    closedTab.cookieStoreId.length > 0 &&
    closedTab.cookieStoreId !== expected.cookieStoreId
  ) {
    return false;
  }

  return true;
}

function resolveForgetTarget(browserApi, entry, expectedReplacedTabs) {
  const { sessions, runtime } = browserApi;

  if (
    isClosedPickerWindow(runtime, entry?.window) &&
    typeof sessions.forgetClosedWindow === "function"
  ) {
    const { sessionId } = entry.window;
    return {
      key: `w:${sessionId}`,
      forget: () => sessions.forgetClosedWindow(sessionId),
    };
  }

  if (
    isClosedPickerTab(runtime, entry?.tab) &&
    typeof sessions.forgetClosedTab === "function"
  ) {
    const { windowId, sessionId } = entry.tab;
    return {
      key: `t:${windowId}:${sessionId}`,
      forget: () => sessions.forgetClosedTab(windowId, sessionId),
    };
  }

  if (
    entry?.tab &&
    expectedReplacedTabs.size > 0 &&
    typeof sessions.forgetClosedTab === "function"
  ) {
    for (const expected of expectedReplacedTabs) {
      if (matchesExpectedReplacedTab(entry.tab, expected)) {
        const { windowId, sessionId } = entry.tab;
        return {
          key: `t:${windowId}:${sessionId}`,
          forget: () => sessions.forgetClosedTab(windowId, sessionId),
          expectedReplaced: expected,
        };
      }
    }
  }

  return null;
}

/**
 * Create a single-flight cleaner that erases closed picker windows/tabs and
 * cancelled external-link placeholder tabs from Firefox's recently closed session store.
 * @param {object} browserApi
 * @param {{
 *   maxPasses?: number,
 *   replacedTabTtlMs?: number,
 *   onSessionForgotten?: (key: string) => void,
 *   onRecentSnapshot?: (remaining: Array<object>) => void,
 * }} [deps]
 * @returns {{
 *   purge: () => Promise<number>,
 *   expectReplacedTab: (details: { windowId?: number, url: string, cookieStoreId?: string }) => void,
 *   destroy: () => void,
 * }}
 */
export function createClosedSessionCleaner(browserApi, deps = {}) {
  const maxPasses = deps.maxPasses ?? DEFAULT_MAX_PASSES;
  const replacedTabTtlMs =
    deps.replacedTabTtlMs ?? DEFAULT_REPLACED_TAB_TTL_MS;
  const onSessionForgotten =
    typeof deps.onSessionForgotten === "function"
      ? deps.onSessionForgotten
      : () => {};
  const onRecentSnapshot =
    typeof deps.onRecentSnapshot === "function"
      ? deps.onRecentSnapshot
      : () => {};
  let activeRun = null;
  let rerunRequested = false;
  const expectedReplacedTabs = new Set();

  function clearExpectedReplacedTab(entry) {
    if (!entry) {
      return;
    }
    clearTimeout(entry.timerId);
    expectedReplacedTabs.delete(entry);
  }

  /**
   * Register a one-shot matcher for a cancelled container-inherited placeholder tab
   * our extension is about to remove, so it does not pollute Recently Closed Tabs.
   * @param {{ windowId?: number, url: string, cookieStoreId?: string }} details
   */
  function expectReplacedTab({ windowId, url, cookieStoreId } = {}) {
    if (!Number.isFinite(windowId)) {
      return;
    }
    const keys = normalizeSessionUrlKeys(url);
    if (!keys) {
      return;
    }
    const entry = {
      windowId,
      urlKey: keys.urlKey,
      looseKey: keys.looseKey,
      cookieStoreId:
        typeof cookieStoreId === "string" && cookieStoreId.length > 0
          ? cookieStoreId
          : null,
      timerId: null,
    };
    entry.timerId = setTimeout(() => {
      expectedReplacedTabs.delete(entry);
    }, replacedTabTtlMs);
    expectedReplacedTabs.add(entry);
  }

  async function runPurgeLoop() {
    let totalForgotten = 0;
    let passes = 0;
    const failedKeys = new Set();
    let lastRemaining = null;

    do {
      rerunRequested = false;
      passes += 1;

      let recent;
      try {
        recent = await browserApi.sessions.getRecentlyClosed();
      } catch {
        break;
      }

      if (!Array.isArray(recent)) {
        continue;
      }

      const remaining = [];
      for (const entry of recent) {
        const target = resolveForgetTarget(
          browserApi,
          entry,
          expectedReplacedTabs
        );
        if (!target || failedKeys.has(target.key)) {
          remaining.push(entry);
          continue;
        }
        try {
          onSessionForgotten(target.key);
          await target.forget();
          if (target.expectedReplaced) {
            clearExpectedReplacedTab(target.expectedReplaced);
          }
          totalForgotten += 1;
        } catch {
          failedKeys.add(target.key);
          remaining.push(entry);
        }
      }
      lastRemaining = remaining;
    } while (rerunRequested && passes < maxPasses);

    if (lastRemaining !== null) {
      onRecentSnapshot(lastRemaining);
    }

    return totalForgotten;
  }

  /**
   * Sweep recently closed sessions and forget any closed picker windows or tabs.
   * Coalesces concurrent or re-entrant calls into a single active loop.
   * @returns {Promise<number>} Number of closed picker entries forgotten.
   */
  async function purge() {
    if (typeof browserApi?.sessions?.getRecentlyClosed !== "function") {
      return 0;
    }

    if (activeRun) {
      rerunRequested = true;
      return activeRun;
    }

    activeRun = runPurgeLoop();
    try {
      return await activeRun;
    } finally {
      activeRun = null;
      rerunRequested = false;
    }
  }

  function destroy() {
    for (const entry of [...expectedReplacedTabs]) {
      clearExpectedReplacedTab(entry);
    }
  }

  return {
    purge,
    expectReplacedTab,
    destroy,
  };
}
