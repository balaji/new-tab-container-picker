import { DEFAULT_COOKIE_STORE_ID } from "../lib/containers.js";
import {
  closePopupWindow,
  dismissToDefaultTab,
  focusParentWindow,
} from "./browser-actions.js";

/**
 * Create the runtime message router for picker popup commands.
 * @param {object} browserApi
 * @param {{
 *   sessionManager: {
 *     matchSession: (sessionId?: string) => object | null,
 *     settleSession: (session: object) => Promise<boolean>,
 *   },
 *   settingsState: {
 *     getSettings: () => { enabled: boolean, autoOpenSingleMatch: boolean },
 *   },
 *   ignoreTab?: (tabId: number) => void,
 * }} deps
 */
export function createMessageHandler(browserApi, deps) {
  const { sessionManager, settingsState, ignoreTab } = deps;

  function handleGetPickerState(message) {
    const session = sessionManager.matchSession(message.sessionId);
    if (!session) {
      return null;
    }
    return {
      sessionId: session.sessionId,
      containers: session.containers,
      settings: {
        autoOpenSingleMatch: settingsState.getSettings().autoOpenSingleMatch,
      },
    };
  }

  async function handlePickContainer(message) {
    const session = sessionManager.matchSession(message.sessionId);
    if (!session) {
      return { ok: false };
    }

    await sessionManager.settleSession(session);

    const cookieStoreId = message.cookieStoreId;

    if (cookieStoreId === DEFAULT_COOKIE_STORE_ID) {
      await dismissToDefaultTab(browserApi, session);
      return { ok: true, cookieStoreId };
    }

    const validTarget = session.containers.some(
      (c) => c.cookieStoreId === cookieStoreId
    );
    if (!validTarget) {
      await closePopupWindow(browserApi.windows, session.popupWindowId);
      await focusParentWindow(browserApi.windows, session.parentWindowId);
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

    await focusParentWindow(browserApi.windows, session.parentWindowId);

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
        ignoreTab?.(createdTab.id);
      }
    } catch {
      await closePopupWindow(browserApi.windows, session.popupWindowId);
      return { ok: false };
    }

    try {
      await browserApi.tabs.remove(session.placeholderTabId);
    } catch {
      // Already closed
    }

    await closePopupWindow(browserApi.windows, session.popupWindowId);
    return {
      ok: true,
      cookieStoreId,
      tabId: createdTab?.id,
    };
  }

  async function handleCancelEscape(message) {
    const session = sessionManager.matchSession(message.sessionId);
    if (!session) {
      return { ok: false };
    }

    await sessionManager.settleSession(session);
    await dismissToDefaultTab(browserApi, session);
    return { ok: true };
  }

  async function handleOpenOptions(message) {
    const session = sessionManager.matchSession(message.sessionId);
    if (session) {
      await sessionManager.settleSession(session);
      await closePopupWindow(browserApi.windows, session.popupWindowId);
      await focusParentWindow(browserApi.windows, session.parentWindowId);
    }
    try {
      await browserApi.runtime?.openOptionsPage?.();
      return { ok: true };
    } catch {
      return { ok: false };
    }
  }

  const handlers = {
    GET_PICKER_STATE: handleGetPickerState,
    PICK_CONTAINER: handlePickContainer,
    CANCEL_ESCAPE: handleCancelEscape,
    OPEN_OPTIONS: handleOpenOptions,
  };

  /**
   * Dispatch an incoming runtime message to its handler if recognized.
   * @param {unknown} message
   * @returns {Promise<unknown> | unknown}
   */
  function handleMessage(message) {
    if (!message || typeof message.type !== "string") {
      return undefined;
    }
    const handler = Object.hasOwn(handlers, message.type)
      ? handlers[message.type]
      : null;
    return handler ? handler(message) : undefined;
  }

  return {
    handleMessage,
  };
}
