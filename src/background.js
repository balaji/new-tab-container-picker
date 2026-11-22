import { createClosedSessionCleaner } from "./background/closed-session-cleaner.js";
import { createMessageHandler } from "./background/message-handler.js";
import { createSessionManager } from "./background/session-manager.js";
import { createSettingsState } from "./background/settings-state.js";
import { createTabWatcher } from "./background/tab-watcher.js";

/**
 * Create and wire the background controller against a WebExtension browser API object.
 * Exported for deterministic integration testing; auto-instantiated in Firefox runtime.
 * @param {object} browserApi
 * @param {{ pendingTimeoutMs?: number, blurGraceMs?: number, now?: () => number, generateId?: () => string }} [options]
 */
export function createBackgroundController(browserApi, options = {}) {
  let initialized = false;
  let initPromise = null;
  let sessionManager;

  const settingsState = createSettingsState(browserApi, {
    onDisabled: () => sessionManager.blurDismissActive(),
  });

  sessionManager = createSessionManager(browserApi, {
    isEnabled: () => settingsState.isEnabled(),
    blurGraceMs: options.blurGraceMs,
    now: options.now,
    generateId: options.generateId,
  });

  const tabWatcher = createTabWatcher(browserApi, {
    isEnabled: () => settingsState.isEnabled(),
    getActivePopupWindowId: () => sessionManager.getActivePopupWindowId(),
    onNewTabDetected: (tab) => sessionManager.triggerForTab(tab),
    pendingTimeoutMs: options.pendingTimeoutMs,
  });

  const messageHandler = createMessageHandler(browserApi, {
    sessionManager,
    settingsState,
    ignoreTab: (tabId) => tabWatcher.ignoreTab(tabId),
  });

  const closedSessionCleaner = createClosedSessionCleaner(browserApi);

  async function ensureInitialized() {
    if (initialized) {
      return;
    }
    if (initPromise) {
      return initPromise;
    }

    initPromise = (async () => {
      await settingsState.init();
      await sessionManager.restore();
      await closedSessionCleaner.purge();
      initialized = true;
    })();

    try {
      await initPromise;
    } finally {
      initPromise = null;
    }
  }

  function registerListeners() {
    browserApi.tabs?.onCreated?.addListener(async (tab) => {
      await ensureInitialized();
      await tabWatcher.handleTabCreated(tab);
    });
    browserApi.tabs?.onUpdated?.addListener((tabId, changeInfo, updatedTab) =>
      tabWatcher.handleTabUpdated(tabId, changeInfo, updatedTab)
    );
    browserApi.tabs?.onRemoved?.addListener(async (tabId) => {
      tabWatcher.handleTabRemoved(tabId);
      await ensureInitialized();
      await sessionManager.handleTabRemoved(tabId);
    });
    browserApi.windows?.onFocusChanged?.addListener(async (windowId) => {
      await ensureInitialized();
      await sessionManager.handleWindowFocusChanged(windowId);
    });
    browserApi.windows?.onRemoved?.addListener(async (windowId) => {
      await ensureInitialized();
      await sessionManager.handleWindowRemoved(windowId);
      await closedSessionCleaner.purge();
    });
    browserApi.sessions?.onChanged?.addListener(async () => {
      // Do not await ensureInitialized(): initPromise itself invokes purge(),
      // which can trigger sessions.onChanged before initialization settles.
      await closedSessionCleaner.purge();
    });
    browserApi.action?.onClicked?.addListener(async () => {
      await ensureInitialized();
      await settingsState.toggleEnabled();
    });
    browserApi.storage?.onChanged?.addListener(async (changes, areaName) => {
      if (areaName !== "local" || !changes) {
        return;
      }
      await ensureInitialized();
      await settingsState.handleStorageChanged(changes, areaName);
    });
    browserApi.runtime?.onMessage?.addListener(async (message) => {
      if (!message || typeof message.type !== "string") {
        return undefined;
      }
      await ensureInitialized();
      return messageHandler.handleMessage(message);
    });
    browserApi.runtime?.onInstalled?.addListener(() => ensureInitialized());
    browserApi.runtime?.onStartup?.addListener(() => ensureInitialized());
  }

  registerListeners();
  ensureInitialized();

  return {
    ensureInitialized,
    isEnabled: () => settingsState.isEnabled(),
    getSettings: () => settingsState.getSettings(),
    getActiveSession: () => sessionManager.getActiveSession(),
    destroy() {
      tabWatcher.destroy();
    },
  };
}

if (typeof globalThis.browser !== "undefined" && globalThis.browser?.tabs) {
  createBackgroundController(globalThis.browser);
}
