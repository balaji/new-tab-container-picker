import { DEFAULT_COOKIE_STORE_ID } from "../lib/containers.js";
import {
  classifyTabUrl,
  getEffectiveTabUrl,
  parseHttpUrl,
} from "../lib/tab-detection.js";
import { isOwnPickerUrl } from "./browser-actions.js";

export const DEFAULT_CANDIDATE_TTL_MS = 5000;
export const DEFAULT_ALLOWANCE_TTL_MS = 5000;
export const DEFAULT_COLD_CREATE_GRACE_MS = 150;

function normalizeRequestKey(rawUrl) {
  const normalized = parseHttpUrl(rawUrl);
  if (!normalized) {
    return null;
  }
  try {
    const parsed = new URL(normalized);
    parsed.hash = "";
    return parsed.href;
  } catch {
    return normalized;
  }
}

/**
 * Track newly created no-opener tabs (including those inheriting an active tab's
 * container) and intercept their initial HTTP(S) main_frame request via
 * webRequest.onBeforeRequest before cookies or network traffic are sent.
 * @param {object} browserApi
 * @param {{
 *   isEnabled?: () => boolean,
 *   isInitialized?: () => boolean,
 *   isTabIgnored?: (tabId: number) => boolean,
 *   isRestoredTab?: (details: { tabId: number, url: string, cookieStoreId?: string }) => Promise<boolean> | boolean,
 *   onTabSettled?: (tabId: number) => void,
 *   onExternalLinkDetected?: (details: { tabId: number, url: string }) => Promise<boolean> | boolean,
 *   debugLog?: (event: string, data?: Record<string, unknown>) => void,
 *   candidateTtlMs?: number,
 *   allowanceTtlMs?: number,
 *   coldCreateGraceMs?: number,
 * }} [deps]
 */
export function createExternalLinkWatcher(browserApi, deps = {}) {
  const isEnabled = deps.isEnabled ?? (() => false);
  const isInitialized = deps.isInitialized ?? (() => true);
  const isTabIgnored = deps.isTabIgnored ?? (() => false);
  const isRestoredTab = deps.isRestoredTab ?? (() => false);
  const onTabSettled =
    typeof deps.onTabSettled === "function" ? deps.onTabSettled : () => {};
  const onExternalLinkDetected = deps.onExternalLinkDetected ?? (() => false);
  const debugLog = typeof deps.debugLog === "function" ? deps.debugLog : () => {};
  const candidateTtlMs = deps.candidateTtlMs ?? DEFAULT_CANDIDATE_TTL_MS;
  const allowanceTtlMs = deps.allowanceTtlMs ?? DEFAULT_ALLOWANCE_TTL_MS;
  const coldCreateGraceMs =
    deps.coldCreateGraceMs ?? DEFAULT_COLD_CREATE_GRACE_MS;

  const candidateTabs = new Map();
  const settledTabs = new Set();
  const allowedNavigations = new Set();
  /** @type {Map<number, Set<(tracked: boolean) => void>>} */
  const candidateWaiters = new Map();

  function markSettled(tabId, { stamp = true } = {}) {
    settledTabs.add(tabId);
    if (stamp) {
      onTabSettled(tabId);
    }
  }

  function notifyCandidateWaiters(tabId, tracked) {
    const waiters = candidateWaiters.get(tabId);
    if (!waiters) {
      return;
    }
    candidateWaiters.delete(tabId);
    for (const resolve of waiters) {
      resolve(tracked);
    }
  }

  /**
   * Wait briefly for tabs.onCreated to register a tab as a candidate.
   * Reloads, session-restored tabs, and discarded-tab activations never fire
   * tabs.onCreated, so they resolve false after the grace period.
   * @param {number} tabId
   * @returns {Promise<boolean>}
   */
  function waitForCandidate(tabId) {
    if (candidateTabs.has(tabId)) {
      return Promise.resolve(true);
    }
    if (coldCreateGraceMs <= 0) {
      return Promise.resolve(false);
    }
    return new Promise((resolve) => {
      let waiters = candidateWaiters.get(tabId);
      if (!waiters) {
        waiters = new Set();
        candidateWaiters.set(tabId, waiters);
      }
      const timerId = setTimeout(() => {
        waiters.delete(settle);
        if (waiters.size === 0 && candidateWaiters.get(tabId) === waiters) {
          candidateWaiters.delete(tabId);
        }
        resolve(false);
      }, coldCreateGraceMs);
      const settle = (tracked) => {
        clearTimeout(timerId);
        resolve(tracked);
      };
      waiters.add(settle);
    });
  }

  function clearCandidate(tabId) {
    const timerId = candidateTabs.get(tabId);
    if (timerId !== undefined) {
      clearTimeout(timerId);
      candidateTabs.delete(tabId);
    }
  }

  function clearAllowedEntry(entry) {
    if (!entry) {
      return;
    }
    clearTimeout(entry.timerId);
    allowedNavigations.delete(entry);
  }

  function clearAll() {
    for (const tabId of [...candidateTabs.keys()]) {
      clearCandidate(tabId);
    }
    settledTabs.clear();
    for (const entry of [...allowedNavigations]) {
      clearAllowedEntry(entry);
    }
    for (const tabId of [...candidateWaiters.keys()]) {
      notifyCandidateWaiters(tabId, false);
    }
  }

  /**
   * Register a one-shot bypass for a URL+container pair about to be opened by our
   * picker so it is never re-intercepted even when opened in a named container.
   * @param {string} rawUrl
   * @param {string} [cookieStoreId]
   */
  function allowNextNavigation(rawUrl, cookieStoreId = DEFAULT_COOKIE_STORE_ID) {
    const urlKey = normalizeRequestKey(rawUrl);
    if (!urlKey) {
      return;
    }
    const storeKey =
      typeof cookieStoreId === "string" && cookieStoreId.length > 0
        ? cookieStoreId
        : DEFAULT_COOKIE_STORE_ID;

    const entry = {
      urlKey,
      storeKey,
      timerId: null,
    };
    entry.timerId = setTimeout(() => {
      allowedNavigations.delete(entry);
    }, allowanceTtlMs);
    allowedNavigations.add(entry);
  }

  function consumeAllowedNavigation(rawUrl, cookieStoreId) {
    const urlKey = normalizeRequestKey(rawUrl);
    if (!urlKey) {
      return false;
    }
    const storeKey =
      typeof cookieStoreId === "string" && cookieStoreId.length > 0
        ? cookieStoreId
        : DEFAULT_COOKIE_STORE_ID;

    for (const entry of allowedNavigations) {
      if (entry.urlKey === urlKey && entry.storeKey === storeKey) {
        clearAllowedEntry(entry);
        return true;
      }
    }
    return false;
  }

  function isOwnExtensionOrigin(url) {
    if (typeof url !== "string" || url.length === 0) {
      return false;
    }
    if (isOwnPickerUrl(browserApi.runtime, url)) {
      return true;
    }
    if (typeof browserApi.runtime?.getURL === "function") {
      const originPrefix = browserApi.runtime.getURL("");
      return originPrefix.length > 0 && url.startsWith(originPrefix);
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
   * Synchronously record a newly created tab as a candidate for external-link interception.
   * Must be called before any async awaits in tabs.onCreated so webRequest.onBeforeRequest
   * sees the tab ID immediately.
   * @param {object} tab
   */
  function trackCreatedTab(tab) {
    if (isInitialized() && !isEnabled()) {
      return;
    }

    if (!tab || typeof tab.id !== "number") {
      return;
    }

    if (settledTabs.has(tab.id)) {
      debugLog("track:skip", { tabId: tab.id, reason: "already-settled" });
      return;
    }

    if (
      tab.incognito === true ||
      tab.pinned === true ||
      tab.openerTabId !== undefined ||
      isTabIgnored(tab.id) ||
      isOwnTab(tab)
    ) {
      markSettled(tab.id, {
        stamp: tab.incognito !== true && !isOwnTab(tab),
      });
      const reason =
        tab.incognito === true
          ? "incognito"
          : tab.pinned === true
            ? "pinned"
            : tab.openerTabId !== undefined
              ? "openerTabId"
              : isTabIgnored(tab.id)
                ? "ignored"
                : "own-tab";
      debugLog("track:skip", {
        tabId: tab.id,
        reason,
        url: tab.url,
        openerTabId: tab.openerTabId,
        cookieStoreId: tab.cookieStoreId,
      });
      return;
    }

    const effectiveUrl = getEffectiveTabUrl(tab);
    const urlKind = classifyTabUrl(effectiveUrl);
    if (urlKind !== "pending" && parseHttpUrl(effectiveUrl) === null) {
      markSettled(tab.id);
      debugLog("track:skip", {
        tabId: tab.id,
        reason: `url-kind:${urlKind}`,
        url: effectiveUrl,
        cookieStoreId: tab.cookieStoreId,
      });
      return;
    }

    clearCandidate(tab.id);
    const timerId = setTimeout(() => {
      candidateTabs.delete(tab.id);
      markSettled(tab.id);
      debugLog("candidate:expired", { tabId: tab.id });
    }, candidateTtlMs);
    candidateTabs.set(tab.id, timerId);
    notifyCandidateWaiters(tab.id, true);
    debugLog("track:candidate", {
      tabId: tab.id,
      url: tab.url,
      pendingUrl: tab.pendingUrl,
      cookieStoreId: tab.cookieStoreId,
      windowId: tab.windowId,
      index: tab.index,
      initialized: isInitialized(),
    });
  }

  /**
   * Drop candidate status if the tab settles on about:newtab, the picker, or a non-HTTP page.
   * Also record unseen tabs that settle on non-pending pages so warm fallback never matches them.
   * @param {number} tabId
   * @param {object} changeInfo
   * @param {object} updatedTab
   */
  function handleTabUpdated(tabId, changeInfo, updatedTab) {
    if (!candidateTabs.has(tabId)) {
      if (isInitialized() && !isEnabled()) {
        return;
      }
      if (
        changeInfo?.url !== undefined &&
        classifyTabUrl(changeInfo.url) === "newtab"
      ) {
        markSettled(tabId, {
          stamp: updatedTab?.incognito !== true && !isOwnTab(updatedTab),
        });
      } else if (
        changeInfo?.status === "complete" &&
        classifyTabUrl(getEffectiveTabUrl(updatedTab)) === "other"
      ) {
        markSettled(tabId, {
          stamp: updatedTab?.incognito !== true && !isOwnTab(updatedTab),
        });
      }
      return;
    }

    if (
      isOwnPickerUrl(browserApi.runtime, changeInfo?.url) ||
      isOwnTab(updatedTab)
    ) {
      clearCandidate(tabId);
      markSettled(tabId, { stamp: false });
      debugLog("update:drop", { tabId, reason: "own-tab", url: changeInfo?.url });
      return;
    }

    if (changeInfo?.url !== undefined) {
      const nextKind = classifyTabUrl(changeInfo.url);
      if (nextKind === "newtab") {
        clearCandidate(tabId);
        markSettled(tabId, { stamp: updatedTab?.incognito !== true });
        debugLog("update:drop", { tabId, reason: "newtab", url: changeInfo.url });
        return;
      }
      if (nextKind === "other" && parseHttpUrl(changeInfo.url) === null) {
        clearCandidate(tabId);
        markSettled(tabId, { stamp: updatedTab?.incognito !== true });
        debugLog("update:drop", {
          tabId,
          reason: "non-http",
          url: changeInfo.url,
        });
        return;
      }
    }

    if (
      changeInfo?.status === "complete" &&
      classifyTabUrl(getEffectiveTabUrl(updatedTab)) === "other"
    ) {
      clearCandidate(tabId);
      markSettled(tabId, { stamp: updatedTab?.incognito !== true });
      debugLog("update:drop", {
        tabId,
        reason: "load-complete",
        url: getEffectiveTabUrl(updatedTab),
      });
    }
  }

  /**
   * Clear candidate and settled tracking when a tab is closed.
   * @param {number} tabId
   */
  function handleTabRemoved(tabId) {
    clearCandidate(tabId);
    settledTabs.delete(tabId);
  }

  /**
   * Blocking webRequest.onBeforeRequest handler. Returns { cancel: true } when the
   * external link is handed off to the container picker, or {} to let it load normally.
   * @param {object} details
   * @param {{ allowColdFallback?: boolean }} [options]
   * @returns {Promise<{ cancel?: boolean }>}
   */
  async function handleBeforeRequest(details, options = {}) {
    if (!isEnabled()) {
      return {};
    }

    if (
      !details ||
      typeof details.tabId !== "number" ||
      details.tabId < 0 ||
      details.type !== "main_frame"
    ) {
      return {};
    }

    if (typeof details.frameId === "number" && details.frameId !== 0) {
      return {};
    }

    if (details.method && details.method !== "GET") {
      debugLog("request:skip", {
        tabId: details.tabId,
        reason: `method:${details.method}`,
        url: details.url,
      });
      return {};
    }

    if (details.incognito === true) {
      return {};
    }

    const targetUrl = parseHttpUrl(details.url);
    if (!targetUrl) {
      return {};
    }

    // Requests initiated by an existing web page or extension carry originUrl.
    // Consume any matching one-shot allowance if our own extension initiated this
    // navigation so the allowance never leaks to suppress the next external click.
    if (details.originUrl) {
      if (isOwnExtensionOrigin(details.originUrl)) {
        consumeAllowedNavigation(targetUrl, details.cookieStoreId);
      }
      debugLog("request:skip", {
        tabId: details.tabId,
        reason: "originUrl",
        url: details.url,
        originUrl: details.originUrl,
      });
      return {};
    }

    if (consumeAllowedNavigation(targetUrl, details.cookieStoreId)) {
      clearCandidate(details.tabId);
      markSettled(details.tabId);
      debugLog("request:skip", {
        tabId: details.tabId,
        reason: "allowed-navigation",
        url: targetUrl,
        cookieStoreId: details.cookieStoreId,
      });
      return {};
    }

    if (isTabIgnored(details.tabId)) {
      clearCandidate(details.tabId);
      markSettled(details.tabId, { stamp: false });
      debugLog("request:skip", {
        tabId: details.tabId,
        reason: "tab-ignored",
        url: targetUrl,
      });
      return {};
    }

    let isCandidate = candidateTabs.has(details.tabId);
    let matchSource = isCandidate ? "candidate" : null;

    if (isCandidate) {
      clearCandidate(details.tabId);
      settledTabs.add(details.tabId);
    } else if (
      !settledTabs.has(details.tabId) &&
      typeof browserApi.tabs?.get === "function"
    ) {
      // Handle both cold wake-up and warm races where webRequest.onBeforeRequest
      // arrives before tabs.onCreated. A tab still on "pending" (about:blank / empty)
      // is a brand-new tab. On cold wake-up, Firefox may already report the target
      // URL on the new tab, but that is indistinguishable from a Cmd+R reload,
      // session restore, or discarded-tab activation of an existing tab. Only accept
      // it when tabs.onCreated confirms the tab was just created.
      try {
        const freshTab = await browserApi.tabs.get(details.tabId);
        const freshUrl = getEffectiveTabUrl(freshTab);
        const freshKind = classifyTabUrl(freshUrl);
        const isEligibleTab = Boolean(
          freshTab &&
            freshTab.incognito !== true &&
            freshTab.pinned !== true &&
            freshTab.openerTabId === undefined &&
            !isOwnTab(freshTab)
        );

        // tabs.onCreated may have registered the tab while tabs.get was pending.
        let urlMatchesFallback =
          freshKind === "pending" || candidateTabs.has(details.tabId);
        if (
          !urlMatchesFallback &&
          isEligibleTab &&
          options.allowColdFallback &&
          parseHttpUrl(freshUrl) === targetUrl
        ) {
          urlMatchesFallback = await waitForCandidate(details.tabId);
        }
        clearCandidate(details.tabId);

        if (isEligibleTab && urlMatchesFallback) {
          isCandidate = true;
          matchSource = options.allowColdFallback
            ? "cold-fallback"
            : "warm-fallback";
          settledTabs.add(details.tabId);
        } else {
          markSettled(details.tabId, {
            stamp: freshTab?.incognito !== true && !isOwnTab(freshTab),
          });
          debugLog("request:skip", {
            tabId: details.tabId,
            reason: "fallback-ineligible",
            url: targetUrl,
            allowColdFallback: Boolean(options.allowColdFallback),
            freshUrl,
            freshKind,
            freshOpenerTabId: freshTab?.openerTabId,
            freshIncognito: freshTab?.incognito,
            freshPinned: freshTab?.pinned,
          });
        }
      } catch (error) {
        debugLog("request:skip", {
          tabId: details.tabId,
          reason: "fallback-tabs-get-failed",
          url: targetUrl,
          error: error?.message,
        });
        return {};
      }
    } else {
      debugLog("request:skip", {
        tabId: details.tabId,
        reason: settledTabs.has(details.tabId) ? "settled" : "not-candidate",
        url: targetUrl,
        allowColdFallback: Boolean(options.allowColdFallback),
      });
    }

    if (!isCandidate) {
      return {};
    }

    if (
      await isRestoredTab({
        tabId: details.tabId,
        url: targetUrl,
        cookieStoreId: details.cookieStoreId,
      })
    ) {
      markSettled(details.tabId);
      debugLog("request:skip", {
        tabId: details.tabId,
        reason: "session-restored",
        url: targetUrl,
        cookieStoreId: details.cookieStoreId,
      });
      return {};
    }

    debugLog("request:match", {
      tabId: details.tabId,
      source: matchSource,
      url: targetUrl,
      cookieStoreId: details.cookieStoreId,
    });

    const intercepted = await onExternalLinkDetected({
      tabId: details.tabId,
      url: targetUrl,
    });

    if (!intercepted) {
      onTabSettled(details.tabId);
    }

    return intercepted ? { cancel: true } : {};
  }

  return {
    trackCreatedTab,
    allowNextNavigation,
    handleTabUpdated,
    handleTabRemoved,
    handleBeforeRequest,
    hasCandidateTab: (tabId) => candidateTabs.has(tabId),
    clearAll,
    destroy: clearAll,
  };
}
