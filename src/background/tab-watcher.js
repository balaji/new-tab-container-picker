import { classifyTabUrl, shouldIgnoreCreatedTab } from "../lib/tab-detection.js";
import { isOwnPickerUrl } from "./browser-actions.js";

export const DEFAULT_PENDING_TIMEOUT_MS = 180;
export const DEFAULT_IGNORED_TAB_TTL_MS = 5000;

/**
 * Track newly created tabs, resolve pending about:blank transitions, and ignore self-created tabs.
 * @param {object} browserApi
 * @param {{
 *   isEnabled?: () => boolean,
 *   onNewTabDetected?: (tab: object) => Promise<void> | void,
 *   pendingTimeoutMs?: number,
 *   ignoredTabTtlMs?: number,
 * }} [deps]
 */
export function createTabWatcher(browserApi, deps = {}) {
  const isEnabled = deps.isEnabled ?? (() => true);
  const onNewTabDetected = deps.onNewTabDetected ?? (() => {});
  const pendingTimeoutMs = deps.pendingTimeoutMs ?? DEFAULT_PENDING_TIMEOUT_MS;
  const ignoredTabTtlMs = deps.ignoredTabTtlMs ?? DEFAULT_IGNORED_TAB_TTL_MS;

  const pendingTabs = new Map();
  const ignoredTabIds = new Set();
  const ignoredTimers = new Map();

  function shouldIgnore(tab) {
    return shouldIgnoreCreatedTab(tab, {
      enabled: isEnabled(),
      ignoredTabIds,
    });
  }

  function clearPending(tabId) {
    const entry = pendingTabs.get(tabId);
    if (!entry) {
      return;
    }
    clearTimeout(entry.timerId);
    pendingTabs.delete(tabId);
  }

  function clearIgnored(tabId) {
    const timerId = ignoredTimers.get(tabId);
    if (timerId !== undefined) {
      clearTimeout(timerId);
      ignoredTimers.delete(tabId);
    }
    ignoredTabIds.delete(tabId);
  }

  /**
   * Temporarily mark a tab ID as ignored so self-created container tabs do not re-trigger.
   * @param {number} tabId
   */
  function ignoreTab(tabId) {
    if (typeof tabId !== "number") {
      return;
    }
    clearIgnored(tabId);
    ignoredTabIds.add(tabId);
    const timerId = setTimeout(() => {
      ignoredTimers.delete(tabId);
      ignoredTabIds.delete(tabId);
    }, ignoredTabTtlMs);
    ignoredTimers.set(tabId, timerId);
  }

  /**
   * Inspect a newly created tab and trigger immediately or wait for URL resolution.
   * @param {object} tab
   * @returns {Promise<void>}
   */
  async function handleTabCreated(tab) {
    const rawUrl = tab?.url || tab?.pendingUrl;
    if (isOwnPickerUrl(browserApi.runtime, rawUrl) || shouldIgnore(tab)) {
      return;
    }

    const urlKind = classifyTabUrl(rawUrl);
    if (urlKind === "other") {
      return;
    }

    if (urlKind === "newtab") {
      await onNewTabDetected(tab);
      return;
    }

    // urlKind === "pending": wait briefly for Firefox's about:blank -> about:newtab transition
    clearPending(tab.id);
    const timerId = setTimeout(async () => {
      if (!pendingTabs.has(tab.id)) {
        return;
      }
      pendingTabs.delete(tab.id);

      let freshTab;
      try {
        freshTab = await browserApi.tabs.get(tab.id);
      } catch {
        return;
      }

      const freshRawUrl = freshTab?.url || freshTab?.pendingUrl;
      if (
        isOwnPickerUrl(browserApi.runtime, freshRawUrl) ||
        shouldIgnore(freshTab)
      ) {
        return;
      }

      const freshKind = classifyTabUrl(freshRawUrl);
      if (
        freshTab.active &&
        (freshKind === "newtab" || freshKind === "pending")
      ) {
        await onNewTabDetected(freshTab);
      }
    }, pendingTimeoutMs);

    pendingTabs.set(tab.id, { timerId, tab });
  }

  /**
   * Handle URL or load-status transitions on tabs waiting for pending resolution.
   * @param {number} tabId
   * @param {object} changeInfo
   * @param {object} updatedTab
   * @returns {Promise<void>}
   */
  async function handleTabUpdated(tabId, changeInfo, updatedTab) {
    if (!pendingTabs.has(tabId)) {
      return;
    }

    if (
      isOwnPickerUrl(browserApi.runtime, changeInfo?.url) ||
      isOwnPickerUrl(browserApi.runtime, updatedTab?.url)
    ) {
      clearPending(tabId);
      return;
    }

    if (changeInfo?.url !== undefined) {
      const nextKind = classifyTabUrl(changeInfo.url);
      if (nextKind === "newtab") {
        clearPending(tabId);
        if (!shouldIgnore(updatedTab)) {
          await onNewTabDetected(updatedTab);
        }
        return;
      }
      if (nextKind === "other") {
        clearPending(tabId);
        return;
      }
    }

    if (changeInfo?.status === "complete") {
      const currentKind = classifyTabUrl(
        updatedTab?.url || updatedTab?.pendingUrl
      );
      clearPending(tabId);
      if (
        currentKind === "pending" &&
        updatedTab?.active &&
        !shouldIgnore(updatedTab)
      ) {
        await onNewTabDetected(updatedTab);
      }
    }
  }

  /**
   * Clear pending and ignored tracking for a closed tab.
   * @param {number} tabId
   */
  function handleTabRemoved(tabId) {
    clearPending(tabId);
    clearIgnored(tabId);
  }

  /**
   * Cancel all pending and ignored tab timers.
   */
  function destroy() {
    for (const tabId of [...pendingTabs.keys()]) {
      clearPending(tabId);
    }
    for (const tabId of [...ignoredTimers.keys()]) {
      clearIgnored(tabId);
    }
    ignoredTabIds.clear();
  }

  return {
    ignoreTab,
    isTabIgnored: (tabId) => ignoredTabIds.has(tabId),
    hasPendingTab: (tabId) => pendingTabs.has(tabId),
    handleTabCreated,
    handleTabUpdated,
    handleTabRemoved,
    destroy,
  };
}
