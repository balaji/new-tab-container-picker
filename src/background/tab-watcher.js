import {
  classifyTabUrl,
  getEffectiveTabUrl,
  shouldIgnoreCreatedTab,
} from "../lib/tab-detection.js";
import { isOwnPickerUrl } from "./browser-actions.js";

export const DEFAULT_PENDING_TIMEOUT_MS = 500;
export const DEFAULT_IGNORED_TAB_TTL_MS = 5000;
export const DEFAULT_EXPECTED_OWN_TAB_TTL_MS = 2000;

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
  let expectedOwnTabUntil = 0;

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
   * Expect the next newly created new-tab page to be opened by the extension itself
   * (e.g. the toolbar popup choosing Default), so it must not re-trigger the picker.
   * @param {number} [ttlMs]
   */
  function expectOwnNewTab(ttlMs = DEFAULT_EXPECTED_OWN_TAB_TTL_MS) {
    expectedOwnTabUntil = Date.now() + ttlMs;
  }

  function consumeExpectedOwnTab(tab) {
    if (expectedOwnTabUntil === 0) {
      return false;
    }
    const active = Date.now() <= expectedOwnTabUntil;
    expectedOwnTabUntil = 0;
    if (active && typeof tab?.id === "number") {
      ignoreTab(tab.id);
      return true;
    }
    return false;
  }

  function isOwnTab(tab) {
    return (
      isOwnPickerUrl(browserApi.runtime, tab?.url) ||
      isOwnPickerUrl(browserApi.runtime, tab?.pendingUrl)
    );
  }

  /**
   * Inspect a newly created tab and trigger immediately or wait for URL resolution.
   * @param {object} tab
   * @returns {Promise<void>}
   */
  async function handleTabCreated(tab) {
    if (isOwnTab(tab) || shouldIgnore(tab)) {
      return;
    }

    const urlKind = classifyTabUrl(getEffectiveTabUrl(tab));
    if (urlKind === "other") {
      return;
    }

    if (consumeExpectedOwnTab(tab)) {
      return;
    }

    if (urlKind === "newtab") {
      await onNewTabDetected(tab);
      return;
    }

    // urlKind === "pending": wait briefly for Firefox's about:blank -> about:newtab transition.
    // Never trigger while the tab remains about:blank, because external app links, Customize
    // Toolbar, and slow navigations all start (or stay) at about:blank.
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

      if (isOwnTab(freshTab) || shouldIgnore(freshTab)) {
        return;
      }

      const freshKind = classifyTabUrl(getEffectiveTabUrl(freshTab));
      if (freshTab.active && freshKind === "newtab") {
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
      isOwnTab(updatedTab)
    ) {
      clearPending(tabId);
      return;
    }

    const effectiveKind = classifyTabUrl(getEffectiveTabUrl(updatedTab));
    if (effectiveKind === "other") {
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

    if (changeInfo?.status === "complete" && effectiveKind === "newtab") {
      clearPending(tabId);
      if (updatedTab?.active && !shouldIgnore(updatedTab)) {
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
    expectedOwnTabUntil = 0;
  }

  return {
    ignoreTab,
    expectOwnNewTab,
    isTabIgnored: (tabId) => ignoredTabIds.has(tabId),
    hasPendingTab: (tabId) => pendingTabs.has(tabId),
    handleTabCreated,
    handleTabUpdated,
    handleTabRemoved,
    destroy,
  };
}
