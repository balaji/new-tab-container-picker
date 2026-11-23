import {
  DEFAULT_COOKIE_STORE_ID,
  getAvailableContainers,
} from "../lib/containers.js";
import { loadSettings } from "../lib/settings.js";
import { parseHttpUrl } from "../lib/tab-detection.js";
import { PREVIEW_CONTAINERS } from "./preview-data.js";

export const OPEN_TAB_ERROR_MESSAGE =
  "Couldn\u2019t open the tab. Try again or choose another container.";

/**
 * Manage picker state loading, settled guard, and tab creation for both
 * native toolbar popups and in-tab (?mode=tab) new-tab replacement.
 * The picker is only dismissed after the replacement tab was created, so a
 * pending external link (?url=) is never silently dropped.
 * @param {{
 *   browserApi?: object,
 *   win: Window,
 *   announcer: { clear: () => void, announceImmediate: (text: string) => void },
 *   onPreviewReset?: () => void,
 *   onError?: (message: string) => void,
 * }} deps
 */
export function createPickerClient({
  browserApi,
  win,
  announcer,
  onPreviewReset,
  onError,
}) {
  const params = new URLSearchParams(win.location?.search ?? "");
  const isInTabMode = params.get("mode") === "tab";
  const targetUrl = parseHttpUrl(params.get("url"));
  const isPreviewMode =
    !browserApi?.contextualIdentities && params.get("preview") === "1";

  let settled = false;

  /**
   * Re-enable the picker after a failed tab creation and surface the error.
   */
  function reportOpenFailure() {
    settled = false;
    announcer.announceImmediate(OPEN_TAB_ERROR_MESSAGE);
    onError?.(OPEN_TAB_ERROR_MESSAGE);
  }

  async function closeInTabOrWindow(existingTab) {
    if (isInTabMode) {
      let targetTab = existingTab;
      if (!targetTab) {
        try {
          targetTab = await browserApi?.tabs?.getCurrent?.();
        } catch {
          targetTab = null;
        }
      }
      if (
        typeof targetTab?.id === "number" &&
        typeof browserApi?.tabs?.remove === "function"
      ) {
        try {
          await browserApi.tabs.remove(targetTab.id);
          return;
        } catch {
          // Fall back to win.close if tab removal fails
        }
      }
    }
    win.close?.();
  }

  async function allowTargetUrlNavigation(cookieStoreId) {
    if (!targetUrl || typeof browserApi?.runtime?.sendMessage !== "function") {
      return;
    }
    try {
      await browserApi.runtime.sendMessage({
        type: "allow-external-url",
        url: targetUrl,
        cookieStoreId: cookieStoreId ?? DEFAULT_COOKIE_STORE_ID,
      });
    } catch {
      // Proceed even if messaging is unavailable
    }
  }

  /**
   * Tell the background that the next Default new tab is ours, so the optional
   * new-tab interception does not replace it with the in-tab picker.
   */
  async function expectOwnNewTab() {
    if (typeof browserApi?.runtime?.sendMessage !== "function") {
      return;
    }
    try {
      await browserApi.runtime.sendMessage({ type: "expect-own-new-tab" });
    } catch {
      // Proceed even if messaging is unavailable
    }
  }

  async function replaceCurrentPickerTab(createTabProps) {
    let currentTab = null;
    try {
      currentTab = await browserApi?.tabs?.getCurrent?.();
    } catch {
      // Fallback to creating tab without current index/id
    }

    const props = { ...createTabProps, active: true };
    if (targetUrl) {
      props.url = targetUrl;
    }
    if (currentTab && typeof currentTab.windowId === "number") {
      props.windowId = currentTab.windowId;
    }
    if (currentTab && typeof currentTab.index === "number") {
      props.index = currentTab.index;
    }
    const currentIsDefault =
      !currentTab?.cookieStoreId ||
      currentTab.cookieStoreId === DEFAULT_COOKIE_STORE_ID;
    if (
      !props.cookieStoreId &&
      currentIsDefault &&
      typeof currentTab?.id === "number"
    ) {
      props.openerTabId = currentTab.id;
    }

    if (targetUrl && props.openerTabId === undefined) {
      await allowTargetUrlNavigation(props.cookieStoreId);
    }

    try {
      await browserApi?.tabs?.create?.(props);
    } catch {
      // Keep the picker (and any pending target URL) so the user can retry
      return false;
    }
    await closeInTabOrWindow(currentTab);
    return true;
  }

  /**
   * Load containers, settings, and availability state directly from Firefox APIs or preview fixtures.
   * @returns {Promise<{
   *   containers: Array<object>,
   *   autoOpenSingleMatch: boolean,
   *   unavailableReason: "private-window" | "containers-disabled" | null,
   *   isPreview: boolean,
   * }>}
   */
  async function loadState() {
    if (isPreviewMode) {
      return {
        containers: PREVIEW_CONTAINERS.slice(),
        autoOpenSingleMatch: params.get("autoOpen") === "1",
        unavailableReason: null,
        isPreview: true,
      };
    }

    try {
      const currentWin = await browserApi?.windows?.getCurrent?.();
      if (currentWin?.incognito === true) {
        return {
          containers: [],
          autoOpenSingleMatch: false,
          unavailableReason: "private-window",
          isPreview: false,
        };
      }
    } catch {
      // Ignore windows.getCurrent failures and continue loading containers
    }

    const [{ enabled, containers }, settings] = await Promise.all([
      getAvailableContainers(browserApi?.contextualIdentities),
      loadSettings(browserApi?.storage?.local),
    ]);

    if (!enabled) {
      return {
        containers: [],
        autoOpenSingleMatch: Boolean(settings.autoOpenSingleMatch),
        unavailableReason: "containers-disabled",
        isPreview: false,
      };
    }

    return {
      containers,
      autoOpenSingleMatch: Boolean(settings.autoOpenSingleMatch),
      unavailableReason: null,
      isPreview: false,
    };
  }

  /**
   * Open a new tab in the selected container (or Default).
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

    const createProps =
      cookieStoreId === DEFAULT_COOKIE_STORE_ID
        ? {}
        : { cookieStoreId };

    if (isInTabMode) {
      if (!(await replaceCurrentPickerTab(createProps))) {
        reportOpenFailure();
      }
      return;
    }

    const popupCreateProps = targetUrl
      ? { ...createProps, url: targetUrl, active: true }
      : { ...createProps, active: true };

    if (targetUrl) {
      await allowTargetUrlNavigation(createProps.cookieStoreId);
    } else if (
      !createProps.cookieStoreId &&
      typeof browserApi?.runtime?.sendMessage === "function"
    ) {
      await expectOwnNewTab();
    }

    try {
      await browserApi?.tabs?.create?.(popupCreateProps);
    } catch {
      // Keep the popup open so the user can retry or pick another container
      reportOpenFailure();
      return;
    }
    win.close?.();
  }

  /**
   * Close the popup on Escape, or replace an in-tab picker with a native Default new tab.
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

    if (isInTabMode) {
      if (!(await replaceCurrentPickerTab({}))) {
        reportOpenFailure();
      }
      return;
    }

    win.close?.();
  }

  /**
   * Open extension preferences and dismiss the picker (or announce unavailable in preview mode).
   * When an external link is pending, the in-tab picker stays open so the link is not lost.
   */
  async function openSettings() {
    if (settled) {
      return;
    }

    if (isPreviewMode) {
      announcer.announceImmediate("Preview mode: settings unavailable");
      return;
    }

    if (isInTabMode && targetUrl) {
      try {
        await browserApi?.runtime?.openOptionsPage?.();
      } catch {
        // Ignore openOptionsPage failures; the picker remains usable
      }
      return;
    }

    settled = true;
    announcer.clear();

    try {
      await browserApi?.runtime?.openOptionsPage?.();
    } catch {
      // Ignore openOptionsPage failures
    } finally {
      await closeInTabOrWindow(null);
    }
  }

  return {
    isInTabMode,
    isPreviewMode,
    targetUrl,
    isSettled: () => settled,
    loadState,
    pickContainer,
    cancelEscape,
    openSettings,
  };
}
