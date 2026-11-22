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
