import {
  DEFAULT_SETTINGS,
  STORAGE_KEY_AUTO_OPEN_SINGLE_MATCH,
  STORAGE_KEY_ENABLED,
  loadSettings,
} from "../lib/settings.js";
import { syncActionBadge } from "./browser-actions.js";

/**
 * Manage extension settings state, storage persistence, and toolbar badge syncing.
 * @param {object} browserApi
 * @param {{ onDisabled?: () => Promise<void> | void }} [callbacks]
 */
export function createSettingsState(browserApi, { onDisabled } = {}) {
  let enabled = DEFAULT_SETTINGS[STORAGE_KEY_ENABLED];
  let autoOpenSingleMatch = DEFAULT_SETTINGS[STORAGE_KEY_AUTO_OPEN_SINGLE_MATCH];

  /**
   * Load persisted settings from local storage and sync the toolbar badge.
   * @returns {Promise<void>}
   */
  async function init() {
    const settings = await loadSettings(browserApi.storage?.local);
    enabled = settings[STORAGE_KEY_ENABLED];
    autoOpenSingleMatch = settings[STORAGE_KEY_AUTO_OPEN_SINGLE_MATCH];
    await syncActionBadge(browserApi.action, enabled);
  }

  /**
   * Toggle the enabled setting, persist it, sync the badge, and notify when disabled.
   * @returns {Promise<void>}
   */
  async function toggleEnabled() {
    enabled = !enabled;
    try {
      await browserApi.storage?.local?.set({ [STORAGE_KEY_ENABLED]: enabled });
    } catch {
      // Continue updating runtime state & badge
    }
    await syncActionBadge(browserApi.action, enabled);
    if (!enabled) {
      await onDisabled?.();
    }
  }

  /**
   * Apply local storage setting updates and trigger side effects for enabled changes.
   * @param {Record<string, { newValue?: unknown }>} changes
   * @param {string} areaName
   * @returns {Promise<void>}
   */
  async function handleStorageChanged(changes, areaName) {
    if (areaName !== "local" || !changes) {
      return;
    }

    if (STORAGE_KEY_ENABLED in changes) {
      const next = changes[STORAGE_KEY_ENABLED]?.newValue;
      enabled =
        typeof next === "boolean"
          ? next
          : DEFAULT_SETTINGS[STORAGE_KEY_ENABLED];
      await syncActionBadge(browserApi.action, enabled);
      if (!enabled) {
        await onDisabled?.();
      }
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
    isEnabled: () => enabled,
    getSettings: () => ({ enabled, autoOpenSingleMatch }),
    toggleEnabled,
    handleStorageChanged,
  };
}
