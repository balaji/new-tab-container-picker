import { PREVIEW_CONTAINERS } from "./preview-data.js";

/**
 * Manage picker session state loading, settled guard, and background runtime messaging.
 * @param {{
 *   browserApi?: object,
 *   win: Window,
 *   announcer: { clear: () => void, announceImmediate: (text: string) => void },
 *   onPreviewReset?: () => void,
 * }} deps
 */
export function createPickerClient({
  browserApi,
  win,
  announcer,
  onPreviewReset,
}) {
  const params = new URLSearchParams(win.location?.search ?? "");
  const requestedSessionId = params.get("session") ?? "";
  const isPreviewMode =
    !browserApi?.runtime?.sendMessage && params.get("preview") === "1";

  let sessionId = requestedSessionId;
  let settled = false;

  /**
   * Load initial container state from preview fixtures or the background controller.
   * @returns {Promise<{ sessionId: string, containers: Array<object>, autoOpenSingleMatch: boolean, isPreview: boolean } | null>}
   */
  async function loadState() {
    if (isPreviewMode) {
      return {
        sessionId,
        containers: PREVIEW_CONTAINERS.slice(),
        autoOpenSingleMatch: params.get("autoOpen") === "1",
        isPreview: true,
      };
    }

    try {
      const state = await browserApi?.runtime?.sendMessage({
        type: "GET_PICKER_STATE",
        sessionId: requestedSessionId,
      });
      if (!state || !Array.isArray(state.containers)) {
        return null;
      }
      sessionId = state.sessionId || requestedSessionId;
      return {
        sessionId,
        containers: state.containers,
        autoOpenSingleMatch: Boolean(state.settings?.autoOpenSingleMatch),
        isPreview: false,
      };
    } catch {
      return null;
    }
  }

  /**
   * Submit a container selection to the background controller (or announce in preview mode).
   * @param {string} cookieStoreId
   * @param {string} [containerName]
   */
  async function pickContainer(cookieStoreId, containerName) {
    if (settled) {
      return;
    }
    settled = true;
    announcer.clear();

    if (isPreviewMode) {
      if (containerName) {
        announcer.announceImmediate(`Preview selected: ${containerName}`);
      }
      settled = false;
      return;
    }

    try {
      await browserApi?.runtime?.sendMessage({
        type: "PICK_CONTAINER",
        sessionId,
        cookieStoreId,
      });
    } catch {
      win.close?.();
    }
  }

  /**
   * Cancel the picker session on Escape (or reset search in preview mode).
   */
  async function cancelEscape() {
    if (settled) {
      return;
    }
    settled = true;
    announcer.clear();

    if (isPreviewMode) {
      settled = false;
      onPreviewReset?.();
      return;
    }

    try {
      await browserApi?.runtime?.sendMessage({
        type: "CANCEL_ESCAPE",
        sessionId,
      });
    } catch {
      win.close?.();
    }
  }

  /**
   * Open extension preferences and dismiss the popup (or announce unavailable in preview mode).
   */
  async function openSettings() {
    if (settled) {
      return;
    }

    if (isPreviewMode) {
      announcer.announceImmediate("Preview mode: settings unavailable");
      return;
    }

    settled = true;
    announcer.clear();

    try {
      await browserApi?.runtime?.sendMessage({
        type: "OPEN_OPTIONS",
        sessionId,
      });
    } catch {
      try {
        await browserApi?.runtime?.openOptionsPage?.();
      } catch {
        // Ignore fallback openOptionsPage failures
      } finally {
        win.close?.();
      }
    }
  }

  return {
    isPreviewMode,
    isSettled: () => settled,
    loadState,
    pickContainer,
    cancelEscape,
    openSettings,
  };
}
