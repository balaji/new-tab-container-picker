export const STORAGE_KEY_OPEN_ON_NEW_TAB = "openOnNewTab";
export const STORAGE_KEY_OPEN_ON_EXTERNAL_LINK = "openOnExternalLink";
export const STORAGE_KEY_AUTO_OPEN_SINGLE_MATCH = "autoOpenSingleMatch";
export const STORAGE_KEY_EXTENSION_ENABLED = "extensionEnabled";

export const DEFAULT_SETTINGS = Object.freeze({
  [STORAGE_KEY_OPEN_ON_NEW_TAB]: false,
  [STORAGE_KEY_OPEN_ON_EXTERNAL_LINK]: false,
  [STORAGE_KEY_AUTO_OPEN_SINGLE_MATCH]: false,
  [STORAGE_KEY_EXTENSION_ENABLED]: true,
});

const SETTING_KEYS = [
  STORAGE_KEY_OPEN_ON_NEW_TAB,
  STORAGE_KEY_OPEN_ON_EXTERNAL_LINK,
  STORAGE_KEY_AUTO_OPEN_SINGLE_MATCH,
  STORAGE_KEY_EXTENSION_ENABLED,
];

/**
 * Normalize a raw settings record into a validated settings object with defaults.
 * @param {unknown} raw
 * @returns {{ openOnNewTab: boolean, openOnExternalLink: boolean, autoOpenSingleMatch: boolean, extensionEnabled: boolean }}
 */
export function normalizeSettings(raw) {
  const source = raw && typeof raw === "object" ? raw : {};
  return {
    [STORAGE_KEY_OPEN_ON_NEW_TAB]:
      typeof source[STORAGE_KEY_OPEN_ON_NEW_TAB] === "boolean"
        ? source[STORAGE_KEY_OPEN_ON_NEW_TAB]
        : DEFAULT_SETTINGS[STORAGE_KEY_OPEN_ON_NEW_TAB],
    [STORAGE_KEY_OPEN_ON_EXTERNAL_LINK]:
      typeof source[STORAGE_KEY_OPEN_ON_EXTERNAL_LINK] === "boolean"
        ? source[STORAGE_KEY_OPEN_ON_EXTERNAL_LINK]
        : DEFAULT_SETTINGS[STORAGE_KEY_OPEN_ON_EXTERNAL_LINK],
    [STORAGE_KEY_AUTO_OPEN_SINGLE_MATCH]:
      typeof source[STORAGE_KEY_AUTO_OPEN_SINGLE_MATCH] === "boolean"
        ? source[STORAGE_KEY_AUTO_OPEN_SINGLE_MATCH]
        : DEFAULT_SETTINGS[STORAGE_KEY_AUTO_OPEN_SINGLE_MATCH],
    [STORAGE_KEY_EXTENSION_ENABLED]:
      typeof source[STORAGE_KEY_EXTENSION_ENABLED] === "boolean"
        ? source[STORAGE_KEY_EXTENSION_ENABLED]
        : DEFAULT_SETTINGS[STORAGE_KEY_EXTENSION_ENABLED],
  };
}

/**
 * Load extension settings from a WebExtension storage area, falling back to defaults.
 * @param {{ get?: (keys: string[]) => Promise<Record<string, unknown>> } | undefined} storageArea
 * @returns {Promise<{ openOnNewTab: boolean, openOnExternalLink: boolean, autoOpenSingleMatch: boolean, extensionEnabled: boolean }>}
 */
export async function loadSettings(storageArea) {
  if (typeof storageArea?.get !== "function") {
    return { ...DEFAULT_SETTINGS };
  }

  try {
    const stored = await storageArea.get(SETTING_KEYS);
    return normalizeSettings(stored);
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

/**
 * Persist known boolean setting updates to a WebExtension storage area.
 * Returns true if storage.set was called with at least one valid setting, false otherwise.
 * @param {{ set?: (items: Record<string, unknown>) => Promise<void> } | undefined} storageArea
 * @param {Record<string, unknown>} partial
 * @returns {Promise<boolean>}
 */
export async function saveSettings(storageArea, partial) {
  if (
    !partial ||
    typeof partial !== "object" ||
    typeof storageArea?.set !== "function"
  ) {
    return false;
  }

  const updates = {};
  for (const key of SETTING_KEYS) {
    if (typeof partial[key] === "boolean") {
      updates[key] = partial[key];
    }
  }

  if (Object.keys(updates).length === 0) {
    return false;
  }

  await storageArea.set(updates);
  return true;
}
