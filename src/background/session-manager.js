import { getAvailableContainers } from "../lib/containers.js";
import { computePopupBounds } from "../lib/geometry.js";
import { shouldTriggerForWindow } from "../lib/tab-detection.js";
import { closePopupWindow, getPickerUrlPrefix } from "./browser-actions.js";

export const STORAGE_KEY_SESSION = "activeSession";
export const DEFAULT_BLUR_GRACE_MS = 250;

/**
 * Manage active picker popup sessions, session persistence, and window/tab lifecycle hooks.
 * @param {object} browserApi
 * @param {{
 *   isEnabled?: () => boolean,
 *   blurGraceMs?: number,
 *   now?: () => number,
 *   generateId?: () => string,
 * }} [deps]
 */
export function createSessionManager(browserApi, deps = {}) {
  const isEnabled = deps.isEnabled ?? (() => true);
  const blurGraceMs = deps.blurGraceMs ?? DEFAULT_BLUR_GRACE_MS;
  const now = deps.now ?? (() => Date.now());
  const generateId =
    deps.generateId ??
    (() =>
      globalThis.crypto?.randomUUID
        ? globalThis.crypto.randomUUID()
        : `${Date.now()}-${Math.random().toString(36).slice(2)}`);

  let activeSession = null;
  let triggerSeq = 0;

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

  /**
   * Mark a session settled and clear it from active state and session storage.
   * @param {object | null | undefined} session
   * @returns {Promise<boolean>} True if the session transitioned from unsettled to settled.
   */
  async function settleSession(session) {
    if (!session || session.settled) {
      return false;
    }
    session.settled = true;
    if (activeSession?.sessionId === session.sessionId) {
      activeSession = null;
      await persistSession(null);
    }
    return true;
  }

  async function blurDismissSession(session) {
    if (!(await settleSession(session))) {
      return;
    }
    await closePopupWindow(browserApi.windows, session.popupWindowId);
  }

  /**
   * Restore any active session mirrored in session storage after event page wakeup.
   * @returns {Promise<void>}
   */
  async function restore() {
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
  }

  /**
   * Look up the active unsettled session if it matches an optional message sessionId.
   * @param {string | undefined} messageSessionId
   * @returns {object | null}
   */
  function matchSession(messageSessionId) {
    if (!activeSession || activeSession.settled) {
      return null;
    }
    if (messageSessionId && messageSessionId !== activeSession.sessionId) {
      return null;
    }
    return activeSession;
  }

  /**
   * Dismiss the currently active picker session if one is open.
   * @returns {Promise<void>}
   */
  async function blurDismissActive() {
    if (activeSession && !activeSession.settled) {
      await blurDismissSession(activeSession);
    }
  }

  /**
   * Open the container picker popup for a newly created tab if guards pass.
   * @param {object} tab
   * @returns {Promise<void>}
   */
  async function triggerForTab(tab) {
    const mySeq = ++triggerSeq;

    let parentWindow;
    try {
      parentWindow = await browserApi.windows.get(tab.windowId, {
        populate: true,
      });
    } catch {
      return;
    }

    if (mySeq !== triggerSeq || !isEnabled()) {
      return;
    }

    if (!shouldTriggerForWindow(parentWindow)) {
      return;
    }

    const { enabled: containersEnabled, containers } =
      await getAvailableContainers(browserApi.contextualIdentities);

    if (mySeq !== triggerSeq || !isEnabled() || !containersEnabled) {
      return;
    }

    if (activeSession && !activeSession.settled) {
      await blurDismissSession(activeSession);
    }

    if (mySeq !== triggerSeq || !isEnabled()) {
      return;
    }

    const sessionId = generateId();
    const bounds = computePopupBounds(parentWindow, containers.length);
    const url = `${getPickerUrlPrefix(browserApi.runtime)}?session=${encodeURIComponent(sessionId)}`;

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

    if (mySeq !== triggerSeq || !isEnabled()) {
      await closePopupWindow(browserApi.windows, popupWin?.id);
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

  /**
   * Close the popup when the placeholder tab is closed externally.
   * @param {number} tabId
   * @returns {Promise<void>}
   */
  async function handleTabRemoved(tabId) {
    if (
      activeSession &&
      tabId === activeSession.placeholderTabId &&
      !activeSession.settled
    ) {
      const session = activeSession;
      await settleSession(session);
      await closePopupWindow(browserApi.windows, session.popupWindowId);
    }
  }

  /**
   * Dismiss the popup when focus moves to another Firefox window past the grace period.
   * @param {number} windowId
   * @returns {Promise<void>}
   */
  async function handleWindowFocusChanged(windowId) {
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

  /**
   * Clear session state when the popup window is closed externally.
   * @param {number} windowId
   * @returns {Promise<void>}
   */
  async function handleWindowRemoved(windowId) {
    if (
      activeSession &&
      windowId === activeSession.popupWindowId &&
      !activeSession.settled
    ) {
      await settleSession(activeSession);
    }
  }

  return {
    restore,
    getActiveSession: () => activeSession,
    getActivePopupWindowId: () => activeSession?.popupWindowId ?? null,
    matchSession,
    settleSession,
    blurDismissActive,
    triggerForTab,
    handleTabRemoved,
    handleWindowFocusChanged,
    handleWindowRemoved,
  };
}
