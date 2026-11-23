import {
  DEFAULT_SETTINGS,
  STORAGE_KEY_AUTO_OPEN_SINGLE_MATCH,
  STORAGE_KEY_OPEN_ON_EXTERNAL_LINK,
  STORAGE_KEY_OPEN_ON_NEW_TAB,
  loadSettings,
} from "../lib/settings.js";

/**
 * Manage extension settings state for background new-tab and external-link interception.
 * @param {object} browserApi
 */
export function createSettingsState(browserApi) {
  let openOnNewTab = DEFAULT_SETTINGS[STORAGE_KEY_OPEN_ON_NEW_TAB];
  let openOnExternalLink = DEFAULT_SETTINGS[STORAGE_KEY_OPEN_ON_EXTERNAL_LINK];
  let autoOpenSingleMatch = DEFAULT_SETTINGS[STORAGE_KEY_AUTO_OPEN_SINGLE_MATCH];

  /**
   * Load persisted settings from local storage.
   * @returns {Promise<void>}
   */
  async function init() {
    const settings = await loadSettings(browserApi.storage?.local);
    openOnNewTab = settings[STORAGE_KEY_OPEN_ON_NEW_TAB];
    openOnExternalLink = settings[STORAGE_KEY_OPEN_ON_EXTERNAL_LINK];
    autoOpenSingleMatch = settings[STORAGE_KEY_AUTO_OPEN_SINGLE_MATCH];
  }

  /**
   * Apply local storage setting updates.
   * @param {Record<string, { newValue?: unknown }>} changes
   * @param {string} areaName
   */
  function handleStorageChanged(changes, areaName) {
    if (areaName !== "local" || !changes) {
      return;
    }

    if (STORAGE_KEY_OPEN_ON_NEW_TAB in changes) {
      const next = changes[STORAGE_KEY_OPEN_ON_NEW_TAB]?.newValue;
      openOnNewTab =
        typeof next === "boolean"
          ? next
          : DEFAULT_SETTINGS[STORAGE_KEY_OPEN_ON_NEW_TAB];
    }

    if (STORAGE_KEY_OPEN_ON_EXTERNAL_LINK in changes) {
      const next = changes[STORAGE_KEY_OPEN_ON_EXTERNAL_LINK]?.newValue;
      openOnExternalLink =
        typeof next === "boolean"
          ? next
          : DEFAULT_SETTINGS[STORAGE_KEY_OPEN_ON_EXTERNAL_LINK];
    }

    if (STORAGE_KEY_AUTO_OPEN_SINGLE_MATCH in changes) {
      const next = changes[STORAGE_KEY_AUTO_OPEN_SINGLE_MATCH]?.newValue;
      autoOpenSingleMatch =
        typeof next === "boolean"
          ? next
          : DEFAULT_SETTINGS[STORAGE_KEY_AUTO_OPEN_SINGLE_MATCH];
    }
  }

  return {
    init,
    isNewTabModeEnabled: () => openOnNewTab,
    isExternalLinkModeEnabled: () => openOnExternalLink,
    getSettings: () => ({
      openOnNewTab,
      openOnExternalLink,
      autoOpenSingleMatch,
    }),
    handleStorageChanged,
  };
}
