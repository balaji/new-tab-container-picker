import { buildPickerTabUrl } from "./background/browser-actions.js";
import { createClosedSessionCleaner } from "./background/closed-session-cleaner.js";
import { createExternalLinkWatcher } from "./background/external-link-watcher.js";
import { createSettingsState } from "./background/settings-state.js";
import { createTabWatcher } from "./background/tab-watcher.js";
import {
  DEFAULT_COOKIE_STORE_ID,
  getAvailableContainers,
} from "./lib/containers.js";
import {
  STORAGE_KEY_EXTENSION_ENABLED,
  STORAGE_KEY_OPEN_ON_EXTERNAL_LINK,
  STORAGE_KEY_OPEN_ON_NEW_TAB,
  saveSettings,
} from "./lib/settings.js";
import {
  classifyTabUrl,
  getEffectiveTabUrl,
  shouldTriggerForWindow,
} from "./lib/tab-detection.js";

const EXTERNAL_LINK_REQUIRED_PERMISSIONS = Object.freeze({
  permissions: ["tabs", "webRequest", "webRequestBlocking"],
  origins: ["http://*/*", "https://*/*"],
});

const EXTERNAL_LINK_REQUEST_FILTER = Object.freeze({
  urls: ["http://*/*", "https://*/*"],
  types: ["main_frame"],
});

/**
 * Create and wire the background controller for optional Cmd+T in-tab interception,
 * optional external-link interception, and closed picker session cleanup.
 * @param {object} browserApi
 * @param {{
 *   pendingTimeoutMs?: number,
 *   candidateTtlMs?: number,
 *   coldCreateGraceMs?: number,
 *   debugLog?: (event: string, data?: Record<string, unknown>) => void,
 * }} [options]
 */
export function createBackgroundController(browserApi, options = {}) {
  let settingsReady = false;
  let settingsInitPromise = null;
  let initialized = false;
  let initPromise = null;
  let sessionsListenerAttached = false;
  let webRequestListenerAttached = false;
  const scheduledTimers = new Set();
  const debugLog =
    typeof options.debugLog === "function" ? options.debugLog : () => {};

  const settingsState = createSettingsState(browserApi);
  const closedSessionCleaner = createClosedSessionCleaner(browserApi);

  const tabWatcher = createTabWatcher(browserApi, {
    isEnabled: () => settingsState.isNewTabModeEnabled(),
    onNewTabDetected: (tab) => openInTabPicker(tab),
    pendingTimeoutMs: options.pendingTimeoutMs,
  });

  const externalLinkWatcher = createExternalLinkWatcher(browserApi, {
    isEnabled: () => settingsState.isExternalLinkModeEnabled(),
    isInitialized: () => settingsReady,
    isTabIgnored: (tabId) => tabWatcher.isTabIgnored(tabId),
    onExternalLinkDetected: (details) => openExternalLinkPicker(details),
    debugLog,
    candidateTtlMs: options.candidateTtlMs,
    coldCreateGraceMs: options.coldCreateGraceMs,
  });

  async function openInTabPicker(tab) {
    let parentWindow;
    try {
      parentWindow = await browserApi.windows.get(tab.windowId, {
        populate: true,
      });
    } catch {
      return;
    }

    if (
      !settingsState.isNewTabModeEnabled() ||
      !shouldTriggerForWindow(parentWindow)
    ) {
      return;
    }

    const { enabled: containersEnabled } = await getAvailableContainers(
      browserApi.contextualIdentities
    );
    if (!settingsState.isNewTabModeEnabled() || !containersEnabled) {
      return;
    }

    let targetIndex = tab.index;
    if (typeof browserApi.tabs?.get === "function") {
      try {
        const freshTab = await browserApi.tabs.get(tab.id);
        if (
          !freshTab ||
          classifyTabUrl(getEffectiveTabUrl(freshTab)) !== "newtab"
        ) {
          return;
        }
        if (typeof freshTab.index === "number") {
          targetIndex = freshTab.index;
        }
      } catch {
        return;
      }
    }

    const url = buildPickerTabUrl(browserApi.runtime);
    let pickerTab;
    try {
      pickerTab = await browserApi.tabs.create({
        windowId: tab.windowId,
        index: targetIndex,
        url,
        active: true,
      });
    } catch {
      return;
    }

    if (typeof pickerTab?.id === "number") {
      tabWatcher.ignoreTab(pickerTab.id);
    }

    try {
      await browserApi.tabs.remove(tab.id);
    } catch {
      // Placeholder tab already closed
    }
  }

  async function openExternalLinkPicker({ tabId, url }) {
    if (!settingsState.isExternalLinkModeEnabled()) {
      debugLog("picker:skip", { tabId, url, reason: "disabled" });
      return false;
    }

    let tab;
    try {
      tab = await browserApi.tabs.get(tabId);
    } catch (error) {
      debugLog("picker:skip", {
        tabId,
        url,
        reason: "tabs-get-failed",
        error: error?.message,
      });
      return false;
    }

    if (
      !tab ||
      tab.incognito === true ||
      tab.pinned === true ||
      tab.openerTabId !== undefined
    ) {
      debugLog("picker:skip", {
        tabId,
        url,
        reason: !tab
          ? "no-tab"
          : tab.incognito === true
            ? "incognito"
            : tab.pinned === true
              ? "pinned"
              : "openerTabId",
        openerTabId: tab?.openerTabId,
      });
      return false;
    }

    let parentWindow;
    try {
      parentWindow = await browserApi.windows.get(tab.windowId);
    } catch (error) {
      debugLog("picker:skip", {
        tabId,
        url,
        reason: "windows-get-failed",
        error: error?.message,
      });
      return false;
    }

    if (
      !settingsState.isExternalLinkModeEnabled() ||
      !parentWindow ||
      parentWindow.type !== "normal" ||
      parentWindow.incognito === true
    ) {
      debugLog("picker:skip", {
        tabId,
        url,
        reason: "window-ineligible",
        windowType: parentWindow?.type,
        windowIncognito: parentWindow?.incognito,
      });
      return false;
    }

    const { enabled: containersEnabled } = await getAvailableContainers(
      browserApi.contextualIdentities
    );
    if (!settingsState.isExternalLinkModeEnabled() || !containersEnabled) {
      debugLog("picker:skip", {
        tabId,
        url,
        reason: containersEnabled ? "disabled" : "containers-disabled",
      });
      return false;
    }

    const pickerUrl = buildPickerTabUrl(browserApi.runtime, url);
    tabWatcher.ignoreTab(tabId);
    const isDefaultContainer =
      !tab.cookieStoreId || tab.cookieStoreId === DEFAULT_COOKIE_STORE_ID;
    const tabWindowId = tab.windowId;
    const tabIndex = tab.index;
    const tabActive = tab.active !== false;

    debugLog("picker:open", {
      tabId,
      mode: isDefaultContainer ? "update" : "replace",
      url,
      cookieStoreId: tab.cookieStoreId,
    });

    const timerId = setTimeout(() => {
      scheduledTimers.delete(timerId);
      const mode = isDefaultContainer ? "update" : "replace";
      Promise.resolve()
        .then(async () => {
          if (isDefaultContainer) {
            if (typeof browserApi.tabs?.update !== "function") {
              throw new Error("tabs.update unavailable");
            }
            await browserApi.tabs.update(tabId, { url: pickerUrl });
            return;
          }

          // When Firefox inherited an active tab's container for the external link,
          // open the picker in the Default container at the same position and close
          // the cancelled container placeholder tab.
          const pickerTab = await browserApi.tabs.create({
            windowId: tabWindowId,
            index: tabIndex,
            url: pickerUrl,
            active: tabActive,
          });
          if (typeof pickerTab?.id === "number") {
            tabWatcher.ignoreTab(pickerTab.id);
          }
          try {
            await browserApi.tabs.remove(tabId);
          } catch {
            // Placeholder tab already closed
          }
        })
        .catch(async (error) => {
          debugLog("picker:error", {
            tabId,
            mode,
            error: error?.message,
          });
          await restoreCancelledNavigation(tabId, url, tab.cookieStoreId);
        });
    }, 0);
    scheduledTimers.add(timerId);

    return true;
  }

  /**
   * The original external-link request was already cancelled; if the picker could
   * not be shown, load the link in its original tab so it is never silently lost.
   * @param {number} tabId
   * @param {string} url
   * @param {string | undefined} cookieStoreId
   */
  async function restoreCancelledNavigation(tabId, url, cookieStoreId) {
    if (typeof browserApi.tabs?.update !== "function") {
      return;
    }
    externalLinkWatcher.allowNextNavigation(url, cookieStoreId);
    try {
      await browserApi.tabs.update(tabId, { url });
      debugLog("picker:restored", { tabId, url });
    } catch (error) {
      debugLog("picker:restore-failed", {
        tabId,
        url,
        error: error?.message,
      });
    }
  }

  async function handleTabsPermissionRevoked() {
    if (!settingsState.isNewTabModeEnabled()) {
      return;
    }

    try {
      await saveSettings(browserApi.storage?.local, {
        [STORAGE_KEY_OPEN_ON_NEW_TAB]: false,
      });
    } catch {
      // Continue updating runtime state even if storage write fails
    }

    settingsState.handleStorageChanged(
      { [STORAGE_KEY_OPEN_ON_NEW_TAB]: { newValue: false } },
      "local"
    );
  }

  async function handleExternalLinkPermissionRevoked() {
    if (!settingsState.isExternalLinkModeEnabled()) {
      syncWebRequestListener();
      return;
    }

    try {
      await saveSettings(browserApi.storage?.local, {
        [STORAGE_KEY_OPEN_ON_EXTERNAL_LINK]: false,
      });
    } catch {
      // Continue updating runtime state even if storage write fails
    }

    settingsState.handleStorageChanged(
      { [STORAGE_KEY_OPEN_ON_EXTERNAL_LINK]: { newValue: false } },
      "local"
    );
    syncWebRequestListener();
  }

  async function verifyExternalLinkPermissions() {
    if (
      !settingsState.isExternalLinkModeEnabled() ||
      typeof browserApi.permissions?.contains !== "function"
    ) {
      syncWebRequestListener();
      return;
    }

    try {
      const hasPerms = await browserApi.permissions.contains({
        permissions: [...EXTERNAL_LINK_REQUIRED_PERMISSIONS.permissions],
        origins: [...EXTERNAL_LINK_REQUIRED_PERMISSIONS.origins],
      });
      if (!hasPerms) {
        await handleExternalLinkPermissionRevoked();
        return;
      }
    } catch {
      // Ignore permission inspection failures
    }

    syncWebRequestListener();
  }

  const onBeforeRequest = async (details) => {
    const wasReady = settingsReady;
    await ensureSettingsReady();
    return externalLinkWatcher.handleBeforeRequest(details, {
      allowColdFallback: !wasReady,
    });
  };

  function attachWebRequestListener() {
    const onBeforeRequestApi = browserApi.webRequest?.onBeforeRequest;
    if (
      webRequestListenerAttached ||
      typeof onBeforeRequestApi?.addListener !== "function"
    ) {
      return false;
    }
    try {
      onBeforeRequestApi.addListener(
        onBeforeRequest,
        EXTERNAL_LINK_REQUEST_FILTER,
        ["blocking"]
      );
      webRequestListenerAttached = true;
      debugLog("webRequest:attached");
      return true;
    } catch (error) {
      webRequestListenerAttached = false;
      debugLog("webRequest:attach-failed", { error: error?.message });
      return false;
    }
  }

  function detachWebRequestListener() {
    externalLinkWatcher.clearAll();
    if (webRequestListenerAttached) {
      browserApi.webRequest?.onBeforeRequest?.removeListener?.(onBeforeRequest);
      webRequestListenerAttached = false;
      debugLog("webRequest:detached");
    }
  }

  function syncWebRequestListener() {
    if (settingsState.isExternalLinkModeEnabled()) {
      attachWebRequestListener();
    } else {
      detachWebRequestListener();
    }
  }

  /**
   * Reflect the global on/off switch on the toolbar icon with an "OFF" badge.
   */
  async function updateActionBadge() {
    const action = browserApi.action;
    if (typeof action?.setBadgeText !== "function") {
      return;
    }
    const enabled = settingsState.isExtensionEnabled();
    try {
      if (!enabled && typeof action.setBadgeBackgroundColor === "function") {
        await action.setBadgeBackgroundColor({ color: "#5b5b66" });
      }
      if (!enabled && typeof action.setBadgeTextColor === "function") {
        await action.setBadgeTextColor({ color: "#ffffff" });
      }
      await action.setBadgeText({ text: enabled ? "" : "OFF" });
    } catch {
      // Badge updates are cosmetic; ignore failures
    }
  }

  async function verifyTabsPermission() {
    if (
      !settingsState.isNewTabModeEnabled() ||
      typeof browserApi.permissions?.contains !== "function"
    ) {
      return;
    }
    try {
      const hasTabs = await browserApi.permissions.contains({
        permissions: ["tabs"],
      });
      if (!hasTabs) {
        await handleTabsPermissionRevoked();
      }
    } catch {
      // Ignore permission inspection failures
    }
  }

  async function ensureSettingsReady() {
    if (settingsReady) {
      return;
    }
    if (!settingsInitPromise) {
      settingsInitPromise = (async () => {
        await settingsState.init();
        settingsReady = true;
        await updateActionBadge();
      })();
    }

    try {
      await settingsInitPromise;
    } finally {
      settingsInitPromise = null;
    }
  }

  async function ensureInitialized() {
    if (initialized) {
      return;
    }
    if (!initPromise) {
      initPromise = (async () => {
        await ensureSettingsReady();

        const postTasks = [
          closedSessionCleaner.purge(),
          verifyTabsPermission(),
          verifyExternalLinkPermissions(),
        ];
        await Promise.all(postTasks);
        initialized = true;
      })();
    }

    try {
      await initPromise;
    } finally {
      initPromise = null;
    }
  }

  const onSessionsChanged = async () => {
    // Do not await ensureInitialized(): initPromise itself invokes purge(),
    // which can trigger sessions.onChanged before initialization settles.
    await closedSessionCleaner.purge();
  };

  function attachSessionsListener() {
    if (
      sessionsListenerAttached ||
      typeof browserApi.sessions?.onChanged?.addListener !== "function"
    ) {
      return;
    }
    browserApi.sessions.onChanged.addListener(onSessionsChanged);
    sessionsListenerAttached = true;
  }

  const onRuntimeMessage = (message) => {
    if (message?.type === "allow-external-url") {
      externalLinkWatcher.allowNextNavigation(
        message.url,
        message.cookieStoreId
      );
      return Promise.resolve({ ok: true });
    }
    if (message?.type === "expect-own-new-tab") {
      tabWatcher.expectOwnNewTab();
      return Promise.resolve({ ok: true });
    }
    return undefined;
  };

  function registerListeners() {
    // Register webRequest.onBeforeRequest synchronously at top level whenever
    // the optional permission is granted so Firefox MV3 persists it across event-page
    // suspensions and blocks incoming external links before async startup settles.
    const attachedSync = attachWebRequestListener();
    debugLog("init:sync-webrequest", { attached: attachedSync });

    browserApi.tabs?.onCreated?.addListener(async (tab) => {
      // Track synchronously before any await so webRequest.onBeforeRequest sees this tab immediately.
      externalLinkWatcher.trackCreatedTab(tab);
      const wasReady = settingsReady;
      await ensureSettingsReady();
      let currentTab = tab;
      if (
        !wasReady &&
        typeof browserApi.tabs?.get === "function" &&
        classifyTabUrl(getEffectiveTabUrl(tab)) === "pending"
      ) {
        try {
          currentTab = await browserApi.tabs.get(tab.id);
        } catch {
          return;
        }
      }
      await tabWatcher.handleTabCreated(currentTab);
    });
    browserApi.tabs?.onUpdated?.addListener((tabId, changeInfo, updatedTab) => {
      externalLinkWatcher.handleTabUpdated(tabId, changeInfo, updatedTab);
      return tabWatcher.handleTabUpdated(tabId, changeInfo, updatedTab);
    });
    browserApi.tabs?.onRemoved?.addListener(async (tabId) => {
      externalLinkWatcher.handleTabRemoved(tabId);
      tabWatcher.handleTabRemoved(tabId);
      await closedSessionCleaner.purge();
    });
    browserApi.windows?.onRemoved?.addListener(async () => {
      await closedSessionCleaner.purge();
    });
    attachSessionsListener();
    browserApi.permissions?.onAdded?.addListener(async (added) => {
      if (added?.permissions?.includes("sessions")) {
        attachSessionsListener();
        await closedSessionCleaner.purge();
      }
      if (
        added?.permissions?.includes("webRequest") ||
        added?.permissions?.includes("webRequestBlocking") ||
        (added?.origins?.length ?? 0) > 0
      ) {
        await ensureSettingsReady();
        syncWebRequestListener();
      }
    });
    browserApi.permissions?.onRemoved?.addListener(async (removed) => {
      const removedPerms = removed?.permissions ?? [];
      const removedOrigins = removed?.origins ?? [];
      if (removedPerms.includes("tabs")) {
        await ensureSettingsReady();
        await handleTabsPermissionRevoked();
      }
      if (
        removedPerms.includes("tabs") ||
        removedPerms.includes("webRequest") ||
        removedPerms.includes("webRequestBlocking") ||
        removedOrigins.length > 0
      ) {
        await ensureSettingsReady();
        await verifyExternalLinkPermissions();
      }
    });
    browserApi.storage?.onChanged?.addListener(async (changes, areaName) => {
      if (areaName !== "local" || !changes) {
        return;
      }
      await ensureSettingsReady();
      settingsState.handleStorageChanged(changes, areaName);
      const extensionToggled = STORAGE_KEY_EXTENSION_ENABLED in changes;
      if (extensionToggled) {
        await updateActionBadge();
        await verifyTabsPermission();
      }
      if (extensionToggled || STORAGE_KEY_OPEN_ON_EXTERNAL_LINK in changes) {
        await verifyExternalLinkPermissions();
      }
    });
    browserApi.runtime?.onMessage?.addListener?.(onRuntimeMessage);
    browserApi.runtime?.onInstalled?.addListener(() => ensureInitialized());
    browserApi.runtime?.onStartup?.addListener(() => ensureInitialized());
  }

  registerListeners();
  ensureInitialized();

  return {
    ensureInitialized,
    isNewTabModeEnabled: () => settingsState.isNewTabModeEnabled(),
    isExternalLinkModeEnabled: () => settingsState.isExternalLinkModeEnabled(),
    isExtensionEnabled: () => settingsState.isExtensionEnabled(),
    getSettings: () => settingsState.getSettings(),
    destroy() {
      for (const timerId of scheduledTimers) {
        clearTimeout(timerId);
      }
      scheduledTimers.clear();
      tabWatcher.destroy();
      externalLinkWatcher.destroy();
      browserApi.runtime?.onMessage?.removeListener?.(onRuntimeMessage);
      if (webRequestListenerAttached) {
        browserApi.webRequest?.onBeforeRequest?.removeListener?.(
          onBeforeRequest
        );
        webRequestListenerAttached = false;
      }
      if (sessionsListenerAttached) {
        browserApi.sessions?.onChanged?.removeListener?.(onSessionsChanged);
        sessionsListenerAttached = false;
      }
    },
  };
}

if (typeof globalThis.browser !== "undefined" && globalThis.browser?.runtime) {
  createBackgroundController(globalThis.browser);
}
