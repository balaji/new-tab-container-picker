import { getPickerUrlPrefix } from "./background/browser-actions.js";
import { createClosedSessionCleaner } from "./background/closed-session-cleaner.js";
import { createSettingsState } from "./background/settings-state.js";
import { createTabWatcher } from "./background/tab-watcher.js";
import { getAvailableContainers } from "./lib/containers.js";
import { STORAGE_KEY_OPEN_ON_NEW_TAB, saveSettings } from "./lib/settings.js";
import {
  classifyTabUrl,
  getEffectiveTabUrl,
  shouldTriggerForWindow,
} from "./lib/tab-detection.js";

/**
 * Create and wire the background controller for optional Cmd+T in-tab interception
 * and closed picker session cleanup.
 * @param {object} browserApi
 * @param {{ pendingTimeoutMs?: number }} [options]
 */
export function createBackgroundController(browserApi, options = {}) {
  let initialized = false;
  let initPromise = null;
  let sessionsListenerAttached = false;

  const settingsState = createSettingsState(browserApi);
  const closedSessionCleaner = createClosedSessionCleaner(browserApi);

  const tabWatcher = createTabWatcher(browserApi, {
    isEnabled: () => settingsState.isNewTabModeEnabled(),
    onNewTabDetected: (tab) => openInTabPicker(tab),
    pendingTimeoutMs: options.pendingTimeoutMs,
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

    const url = `${getPickerUrlPrefix(browserApi.runtime)}?mode=tab`;
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

  async function ensureInitialized() {
    if (initialized) {
      return;
    }
    if (!initPromise) {
      initPromise = (async () => {
        await settingsState.init();
        await closedSessionCleaner.purge();
        initialized = true;
      })();
    }

    try {
      await initPromise;
    } finally {
      initPromise = null;
    }

    if (
      settingsState.isNewTabModeEnabled() &&
      typeof browserApi.permissions?.contains === "function"
    ) {
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

  function registerListeners() {
    browserApi.tabs?.onCreated?.addListener(async (tab) => {
      const wasInitialized = initialized;
      await ensureInitialized();
      let currentTab = tab;
      if (
        !wasInitialized &&
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
    browserApi.tabs?.onUpdated?.addListener((tabId, changeInfo, updatedTab) =>
      tabWatcher.handleTabUpdated(tabId, changeInfo, updatedTab)
    );
    browserApi.tabs?.onRemoved?.addListener(async (tabId) => {
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
    });
    browserApi.permissions?.onRemoved?.addListener(async (removed) => {
      if (removed?.permissions?.includes("tabs")) {
        await ensureInitialized();
        await handleTabsPermissionRevoked();
      }
    });
    browserApi.storage?.onChanged?.addListener(async (changes, areaName) => {
      if (areaName !== "local" || !changes) {
        return;
      }
      await ensureInitialized();
      settingsState.handleStorageChanged(changes, areaName);
    });
    browserApi.runtime?.onInstalled?.addListener(() => ensureInitialized());
    browserApi.runtime?.onStartup?.addListener(() => ensureInitialized());
  }

  registerListeners();
  ensureInitialized();

  return {
    ensureInitialized,
    isNewTabModeEnabled: () => settingsState.isNewTabModeEnabled(),
    getSettings: () => settingsState.getSettings(),
    destroy() {
      tabWatcher.destroy();
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
