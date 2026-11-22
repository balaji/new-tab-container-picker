import {
  DEFAULT_COOKIE_STORE_ID,
  getAvailableContainers,
} from "./lib/containers.js";
import { computePopupBounds } from "./lib/geometry.js";
import {
  classifyTabUrl,
  shouldIgnoreCreatedTab,
  shouldTriggerForWindow,
} from "./lib/tab-detection.js";

const STORAGE_KEY_ENABLED = "enabled";
const STORAGE_KEY_SESSION = "activeSession";
const DEFAULT_PENDING_TIMEOUT_MS = 180;
const DEFAULT_BLUR_GRACE_MS = 250;

/**
 * Create and wire the background controller against a WebExtension browser API object.
 * Exported for deterministic integration testing; auto-instantiated in Firefox runtime.
 * @param {object} browserApi
 * @param {{ pendingTimeoutMs?: number, blurGraceMs?: number, now?: () => number, generateId?: () => string }} [options]
 */
export function createBackgroundController(browserApi, options = {}) {
  const pendingTimeoutMs =
    options.pendingTimeoutMs ?? DEFAULT_PENDING_TIMEOUT_MS;
  const blurGraceMs = options.blurGraceMs ?? DEFAULT_BLUR_GRACE_MS;
  const now = options.now ?? (() => Date.now());
  const generateId =
    options.generateId ??
    (() =>
      globalThis.crypto?.randomUUID
        ? globalThis.crypto.randomUUID()
        : `${Date.now()}-${Math.random().toString(36).slice(2)}`);

  let enabled = true;
  let initialized = false;
  let initPromise = null;
  let activeSession = null;
  let triggerSeq = 0;

  const pendingTabs = new Map();
  const ignoredTabIds = new Set();

  function getPickerUrlPrefix() {
    if (typeof browserApi.runtime?.getURL === "function") {
      return browserApi.runtime.getURL("src/picker/picker.html");
    }
    return "src/picker/picker.html";
  }

  function isOwnPickerUrl(url) {
    if (typeof url !== "string") {
      return false;
    }
    return url.startsWith(getPickerUrlPrefix());
  }

  async function persistSession(session) {
    const sessionStore = browserApi.storage?.session;
    if (!sessionStore) {
      return;
    }
    try {
      if (session) {
        await sessionStore.set({ [STORAGE_KEY_SESSION]: session });
      } else {
        await sessionStore.remove(STORAGE_KEY_SESSION);
      }
    } catch {
      // Best-effort mirror for MV3 event page wakeups
    }
  }

  async function syncBadge(isEnabled) {
    const actionApi = browserApi.action;
    if (!actionApi) {
      return;
    }
    try {
      if (isEnabled) {
        await actionApi.setBadgeText?.({ text: "" });
        await actionApi.setTitle?.({
          title: "New Tab Container Picker (Enabled — click to pause)",
        });
      } else {
        await actionApi.setBadgeText?.({ text: "OFF" });
        await actionApi.setBadgeBackgroundColor?.({ color: "#52525e" });
        await actionApi.setBadgeTextColor?.({ color: "#ffffff" });
        await actionApi.setTitle?.({
          title: "New Tab Container Picker (Paused — click to resume)",
        });
      }
    } catch {
      // Ignore badge update failures in unsupported contexts
    }
  }

  async function ensureInitialized() {
    if (initialized) {
      return;
    }
    if (initPromise) {
      return initPromise;
    }

    initPromise = (async () => {
      try {
        const stored = await browserApi.storage?.local?.get(STORAGE_KEY_ENABLED);
        if (stored && typeof stored[STORAGE_KEY_ENABLED] === "boolean") {
          enabled = stored[STORAGE_KEY_ENABLED];
        } else {
          enabled = true;
        }
      } catch {
        enabled = true;
      }

      try {
        const sessionData = await browserApi.storage?.session?.get(
          STORAGE_KEY_SESSION
        );
        if (sessionData?.[STORAGE_KEY_SESSION] && !activeSession) {
          activeSession = sessionData[STORAGE_KEY_SESSION];
        }
      } catch {
        // Ignore session storage errors
      }

      await syncBadge(enabled);
      initialized = true;
    })();

    try {
      await initPromise;
    } finally {
      initPromise = null;
    }
  }

  function clearPending(tabId) {
    const entry = pendingTabs.get(tabId);
    if (!entry) {
      return;
    }
    clearTimeout(entry.timerId);
    pendingTabs.delete(tabId);
  }

  async function closePopupWindow(popupWindowId) {
    if (typeof popupWindowId !== "number") {
      return;
    }
    try {
      await browserApi.windows.remove(popupWindowId);
    } catch {
      // Already closed
    }
  }

  async function focusParentWindow(parentWindowId) {
    if (typeof parentWindowId !== "number") {
      return;
    }
    try {
      await browserApi.windows.update(parentWindowId, { focused: true });
    } catch {
      // Window no longer exists
    }
  }

  async function focusTab(tabId) {
    if (typeof tabId !== "number") {
      return;
    }
    try {
      await browserApi.tabs.update(tabId, { active: true });
    } catch {
      // Tab closed externally
    }
  }

  async function dismissToDefaultTab(session) {
    await closePopupWindow(session.popupWindowId);
    await focusParentWindow(session.parentWindowId);
    await focusTab(session.placeholderTabId);
  }

  async function blurDismissSession(session) {
    if (!session || session.settled) {
      return;
    }
    session.settled = true;
    if (activeSession?.sessionId === session.sessionId) {
      activeSession = null;
      await persistSession(null);
    }
    await closePopupWindow(session.popupWindowId);
  }

  async function triggerPickerForTab(tab) {
    const mySeq = ++triggerSeq;

    let parentWindow;
    try {
      parentWindow = await browserApi.windows.get(tab.windowId, {
        populate: true,
      });
    } catch {
      return;
    }

    if (mySeq !== triggerSeq || !enabled) {
      return;
    }

    if (!shouldTriggerForWindow(parentWindow)) {
      return;
    }

    const { enabled: containersEnabled, containers } =
      await getAvailableContainers(browserApi.contextualIdentities);

    if (mySeq !== triggerSeq || !enabled || !containersEnabled) {
      return;
    }

    if (activeSession && !activeSession.settled) {
      await blurDismissSession(activeSession);
    }

    if (mySeq !== triggerSeq || !enabled) {
      return;
    }

    const sessionId = generateId();
    const bounds = computePopupBounds(parentWindow, containers.length);
    const url = `${getPickerUrlPrefix()}?session=${encodeURIComponent(sessionId)}`;

    let popupWin;
    try {
      popupWin = await browserApi.windows.create({
        url,
        type: "popup",
        focused: true,
        ...bounds,
      });
    } catch {
      return;
    }

    if (mySeq !== triggerSeq || !enabled) {
      await closePopupWindow(popupWin?.id);
      return;
    }

    const session = {
      sessionId,
      placeholderTabId: tab.id,
      parentWindowId: tab.windowId,
      placeholderTabIndex: tab.index,
      popupWindowId: popupWin.id,
      containers,
      openedAt: now(),
      settled: false,
    };

    activeSession = session;
    await persistSession(session);
  }

  async function handleTabCreated(tab) {
    await ensureInitialized();

    const rawUrl = tab?.url || tab?.pendingUrl;
    if (isOwnPickerUrl(rawUrl)) {
      return;
    }

    if (
      shouldIgnoreCreatedTab(tab, {
        enabled,
        ignoredTabIds,
        activePopupWindowId: activeSession?.popupWindowId ?? null,
      })
    ) {
      return;
    }

    const urlKind = classifyTabUrl(rawUrl);
    if (urlKind === "other") {
      return;
    }

    if (urlKind === "newtab") {
      await triggerPickerForTab(tab);
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
      if (isOwnPickerUrl(freshRawUrl)) {
        return;
      }

      if (
        shouldIgnoreCreatedTab(freshTab, {
          enabled,
          ignoredTabIds,
          activePopupWindowId: activeSession?.popupWindowId ?? null,
        })
      ) {
        return;
      }

      const freshKind = classifyTabUrl(freshRawUrl);
      if (
        freshTab.active &&
        (freshKind === "newtab" || freshKind === "pending")
      ) {
        await triggerPickerForTab(freshTab);
      }
    }, pendingTimeoutMs);

    pendingTabs.set(tab.id, { timerId, tab });
  }

  async function handleTabUpdated(tabId, changeInfo, updatedTab) {
    if (!pendingTabs.has(tabId)) {
      return;
    }

    if (isOwnPickerUrl(changeInfo?.url) || isOwnPickerUrl(updatedTab?.url)) {
      clearPending(tabId);
      return;
    }

    if (changeInfo?.url !== undefined) {
      const nextKind = classifyTabUrl(changeInfo.url);
      if (nextKind === "newtab") {
        clearPending(tabId);
        if (
          !shouldIgnoreCreatedTab(updatedTab, {
            enabled,
            ignoredTabIds,
            activePopupWindowId: activeSession?.popupWindowId ?? null,
          })
        ) {
          await triggerPickerForTab(updatedTab);
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
        !shouldIgnoreCreatedTab(updatedTab, {
          enabled,
          ignoredTabIds,
          activePopupWindowId: activeSession?.popupWindowId ?? null,
        })
      ) {
        await triggerPickerForTab(updatedTab);
      }
    }
  }

  async function handleTabRemoved(tabId) {
    clearPending(tabId);
    ignoredTabIds.delete(tabId);

    await ensureInitialized();
    if (
      activeSession &&
      tabId === activeSession.placeholderTabId &&
      !activeSession.settled
    ) {
      const session = activeSession;
      session.settled = true;
      activeSession = null;
      await persistSession(null);
      await closePopupWindow(session.popupWindowId);
    }
  }

  async function handleWindowFocusChanged(windowId) {
    await ensureInitialized();
    if (!activeSession || activeSession.settled) {
      return;
    }
    const windowIdNone = browserApi.windows?.WINDOW_ID_NONE ?? -1;
    if (
      windowId === activeSession.popupWindowId ||
      windowId === windowIdNone
    ) {
      return;
    }
    if (now() - activeSession.openedAt < blurGraceMs) {
      return;
    }
    await blurDismissSession(activeSession);
  }

  async function handleWindowRemoved(windowId) {
    await ensureInitialized();
    if (
      activeSession &&
      windowId === activeSession.popupWindowId &&
      !activeSession.settled
    ) {
      activeSession.settled = true;
      activeSession = null;
      await persistSession(null);
    }
  }

  async function handleActionClicked() {
    await ensureInitialized();
    enabled = !enabled;
    try {
      await browserApi.storage?.local?.set({ [STORAGE_KEY_ENABLED]: enabled });
    } catch {
      // Continue updating runtime state & badge
    }
    await syncBadge(enabled);
    if (!enabled && activeSession && !activeSession.settled) {
      await blurDismissSession(activeSession);
    }
  }

  function matchSession(messageSessionId) {
    if (!activeSession || activeSession.settled) {
      return null;
    }
    if (messageSessionId && messageSessionId !== activeSession.sessionId) {
      return null;
    }
    return activeSession;
  }

  async function handleMessage(message) {
    if (!message || typeof message.type !== "string") {
      return undefined;
    }

    await ensureInitialized();

    if (message.type === "GET_PICKER_STATE") {
      const session = matchSession(message.sessionId);
      if (!session) {
        return null;
      }
      return {
        sessionId: session.sessionId,
        containers: session.containers,
      };
    }

    if (message.type === "PICK_CONTAINER") {
      const session = matchSession(message.sessionId);
      if (!session) {
        return { ok: false };
      }

      session.settled = true;
      activeSession = null;
      await persistSession(null);

      const cookieStoreId = message.cookieStoreId;

      if (cookieStoreId === DEFAULT_COOKIE_STORE_ID) {
        await dismissToDefaultTab(session);
        return { ok: true, cookieStoreId };
      }

      const validTarget = session.containers.some(
        (c) => c.cookieStoreId === cookieStoreId
      );
      if (!validTarget) {
        await closePopupWindow(session.popupWindowId);
        await focusParentWindow(session.parentWindowId);
        return { ok: false };
      }

      let targetIndex = session.placeholderTabIndex;
      try {
        const placeholderTab = await browserApi.tabs.get(
          session.placeholderTabId
        );
        if (typeof placeholderTab?.index === "number") {
          targetIndex = placeholderTab.index;
        }
      } catch {
        // Fallback to original index
      }

      await focusParentWindow(session.parentWindowId);

      const createProps = {
        windowId: session.parentWindowId,
        cookieStoreId,
        active: true,
      };
      if (typeof targetIndex === "number") {
        createProps.index = targetIndex;
      }

      let createdTab = null;
      try {
        createdTab = await browserApi.tabs.create(createProps);
        if (typeof createdTab?.id === "number") {
          ignoredTabIds.add(createdTab.id);
          setTimeout(() => ignoredTabIds.delete(createdTab.id), 5000);
        }
      } catch {
        await closePopupWindow(session.popupWindowId);
        return { ok: false };
      }

      try {
        await browserApi.tabs.remove(session.placeholderTabId);
      } catch {
        // Already closed
      }

      await closePopupWindow(session.popupWindowId);
      return {
        ok: true,
        cookieStoreId,
        tabId: createdTab?.id,
      };
    }

    if (message.type === "CANCEL_ESCAPE") {
      const session = matchSession(message.sessionId);
      if (!session) {
        return { ok: false };
      }

      session.settled = true;
      activeSession = null;
      await persistSession(null);

      await dismissToDefaultTab(session);
      return { ok: true };
    }

    return undefined;
  }

  function registerListeners() {
    browserApi.tabs?.onCreated?.addListener(handleTabCreated);
    browserApi.tabs?.onUpdated?.addListener(handleTabUpdated);
    browserApi.tabs?.onRemoved?.addListener(handleTabRemoved);
    browserApi.windows?.onFocusChanged?.addListener(handleWindowFocusChanged);
    browserApi.windows?.onRemoved?.addListener(handleWindowRemoved);
    browserApi.action?.onClicked?.addListener(handleActionClicked);
    browserApi.runtime?.onMessage?.addListener(handleMessage);
    browserApi.runtime?.onInstalled?.addListener(() => ensureInitialized());
    browserApi.runtime?.onStartup?.addListener(() => ensureInitialized());
  }

  registerListeners();
  ensureInitialized();

  return {
    ensureInitialized,
    isEnabled: () => enabled,
    getActiveSession: () => activeSession,
    destroy() {
      for (const tabId of pendingTabs.keys()) {
        clearPending(tabId);
      }
    },
  };
}

if (typeof globalThis.browser !== "undefined" && globalThis.browser?.tabs) {
  createBackgroundController(globalThis.browser);
}
