import {
  DEFAULT_COOKIE_STORE_ID,
  getAvailableContainers,
} from "../lib/containers.js";
import { loadSettings } from "../lib/settings.js";
import { PREVIEW_CONTAINERS } from "./preview-data.js";

/**
 * Manage picker state loading, settled guard, and tab creation for both
 * native toolbar popups and in-tab (?mode=tab) new-tab replacement.
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
  const isInTabMode = params.get("mode") === "tab";
  const isPreviewMode =
    !browserApi?.contextualIdentities && params.get("preview") === "1";

  let settled = false;

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

  async function replaceCurrentPickerTab(createTabProps) {
    let currentTab = null;
    try {
      currentTab = await browserApi?.tabs?.getCurrent?.();
    } catch {
      // Fallback to creating tab without current index/id
    }

    const props = { ...createTabProps, active: true };
    if (currentTab && typeof currentTab.windowId === "number") {
      props.windowId = currentTab.windowId;
    }
    if (currentTab && typeof currentTab.index === "number") {
      props.index = currentTab.index;
    }
    if (!props.cookieStoreId && typeof currentTab?.id === "number") {
      props.openerTabId = currentTab.id;
    }

    try {
      await browserApi?.tabs?.create?.(props);
    } catch {
      // Proceed to close current picker tab
    } finally {
      await closeInTabOrWindow(currentTab);
    }
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
      await replaceCurrentPickerTab(createProps);
      return;
    }

    try {
      await browserApi?.tabs?.create?.({ ...createProps, active: true });
    } catch {
      // Close popup cleanly even if tab creation fails
    } finally {
      win.close?.();
    }
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
      await replaceCurrentPickerTab({});
      return;
    }

    win.close?.();
  }

  /**
   * Open extension preferences and dismiss the picker (or announce unavailable in preview mode).
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
    isSettled: () => settled,
    loadState,
    pickContainer,
    cancelEscape,
    openSettings,
  };
}
