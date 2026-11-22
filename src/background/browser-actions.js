export const PICKER_HTML_PATH = "src/picker/picker.html";

/**
 * Resolve the extension's picker page URL prefix.
 * @param {{ getURL?: (path: string) => string } | undefined} runtimeApi
 * @returns {string}
 */
export function getPickerUrlPrefix(runtimeApi) {
  if (typeof runtimeApi?.getURL === "function") {
    return runtimeApi.getURL(PICKER_HTML_PATH);
  }
  return PICKER_HTML_PATH;
}

/**
 * Determine whether a URL points to this extension's picker page.
 * @param {{ getURL?: (path: string) => string } | undefined} runtimeApi
 * @param {unknown} url
 * @returns {boolean}
 */
export function isOwnPickerUrl(runtimeApi, url) {
  if (typeof url !== "string") {
    return false;
  }
  return url.startsWith(getPickerUrlPrefix(runtimeApi));
}

/**
 * Synchronize the browser action badge and tooltip with the enabled state.
 * @param {object | undefined} actionApi
 * @param {boolean} isEnabled
 * @returns {Promise<void>}
 */
export async function syncActionBadge(actionApi, isEnabled) {
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

/**
 * Close the picker popup window safely if it still exists.
 * @param {{ remove?: (windowId: number) => Promise<void> } | undefined} windowsApi
 * @param {unknown} popupWindowId
 * @returns {Promise<void>}
 */
export async function closePopupWindow(windowsApi, popupWindowId) {
  if (typeof popupWindowId !== "number") {
    return;
  }
  try {
    await windowsApi?.remove(popupWindowId);
  } catch {
    // Already closed
  }
}

/**
 * Focus the parent browser window safely if it still exists.
 * @param {{ update?: (windowId: number, updateInfo: object) => Promise<unknown> } | undefined} windowsApi
 * @param {unknown} parentWindowId
 * @returns {Promise<void>}
 */
export async function focusParentWindow(windowsApi, parentWindowId) {
  if (typeof parentWindowId !== "number") {
    return;
  }
  try {
    await windowsApi?.update(parentWindowId, { focused: true });
  } catch {
    // Window no longer exists
  }
}

/**
 * Activate a tab safely if it still exists.
 * @param {{ update?: (tabId: number, updateProperties: object) => Promise<unknown> } | undefined} tabsApi
 * @param {unknown} tabId
 * @returns {Promise<void>}
 */
export async function focusTab(tabsApi, tabId) {
  if (typeof tabId !== "number") {
    return;
  }
  try {
    await tabsApi?.update(tabId, { active: true });
  } catch {
    // Tab closed externally
  }
}

/**
 * Dismiss the popup window and return focus to the placeholder default tab.
 * @param {{ windows?: object, tabs?: object }} browserApi
 * @param {{ popupWindowId?: number, parentWindowId?: number, placeholderTabId?: number }} session
 * @returns {Promise<void>}
 */
export async function dismissToDefaultTab(browserApi, session) {
  await closePopupWindow(browserApi.windows, session.popupWindowId);
  await focusParentWindow(browserApi.windows, session.parentWindowId);
  await focusTab(browserApi.tabs, session.placeholderTabId);
}
