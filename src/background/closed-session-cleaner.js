import { isOwnPickerUrl } from "./browser-actions.js";

export const DEFAULT_MAX_PASSES = 5;

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

function resolveForgetTarget(browserApi, entry) {
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

  return null;
}

/**
 * Create a single-flight cleaner that erases closed picker windows and tabs
 * from Firefox's recently closed session store.
 * @param {object} browserApi
 * @param {{ maxPasses?: number }} [deps]
 * @returns {{ purge: () => Promise<number> }}
 */
export function createClosedSessionCleaner(browserApi, deps = {}) {
  const maxPasses = deps.maxPasses ?? DEFAULT_MAX_PASSES;
  let activeRun = null;
  let rerunRequested = false;

  async function runPurgeLoop() {
    let totalForgotten = 0;
    let passes = 0;
    const failedKeys = new Set();

    do {
      rerunRequested = false;
      passes += 1;

      let recent;
      try {
        recent = await browserApi.sessions.getRecentlyClosed();
      } catch {
        break;
      }

      if (!Array.isArray(recent) || recent.length === 0) {
        continue;
      }

      for (const entry of recent) {
        const target = resolveForgetTarget(browserApi, entry);
        if (!target || failedKeys.has(target.key)) {
          continue;
        }
        try {
          await target.forget();
          totalForgotten += 1;
        } catch {
          failedKeys.add(target.key);
        }
      }
    } while (rerunRequested && passes < maxPasses);

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

  return {
    purge,
  };
}
