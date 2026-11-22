import {
  DEFAULT_SETTINGS,
  STORAGE_KEY_AUTO_OPEN_SINGLE_MATCH,
  STORAGE_KEY_OPEN_ON_NEW_TAB,
  loadSettings,
  saveSettings,
} from "../lib/settings.js";
import {
  COMMAND_OPEN_PICKER,
  eventToShortcut,
  formatShortcutForDisplay,
  getCommandShortcut,
  isMacPlatform,
  resetCommandShortcut,
  updateCommandShortcut,
} from "../lib/shortcuts.js";

const DEFAULT_STATUS_DURATION_MS = 1800;
export const NEWTAB_OPTIONAL_PERMISSIONS = Object.freeze(["tabs", "sessions"]);

/**
 * Initialize and control the extension options page UI.
 * @param {{
 *   browserApi?: object,
 *   doc?: Document,
 *   win?: Window | null,
 *   isMac?: boolean,
 *   statusDurationMs?: number,
 * }} [deps]
 */
export async function createOptionsController(deps = {}) {
  const doc = deps.doc ?? document;
  const win =
    deps.win !== undefined
      ? deps.win
      : typeof window !== "undefined"
        ? window
        : null;
  const browserApi = deps.browserApi ?? globalThis.browser;
  const resolvedIsMac = deps.isMac ?? isMacPlatform();
  const statusDurationMs = deps.statusDurationMs ?? DEFAULT_STATUS_DURATION_MS;

  const openOnNewTabInput = doc.getElementById("setting-open-on-new-tab");
  const autoOpenInput = doc.getElementById("setting-auto-open");
  const shortcutInput = doc.getElementById("setting-shortcut");
  const resetShortcutBtn = doc.getElementById("shortcut-reset");
  const clearShortcutBtn = doc.getElementById("shortcut-clear");
  const statusEl = doc.getElementById("save-status");

  const checkboxBindings = [
    { key: STORAGE_KEY_OPEN_ON_NEW_TAB, input: openOnNewTabInput },
    { key: STORAGE_KEY_AUTO_OPEN_SINGLE_MATCH, input: autoOpenInput },
  ];

  const canCustomizeShortcut = typeof browserApi?.commands?.update === "function";
  const canResetShortcut = typeof browserApi?.commands?.reset === "function";

  let currentSettings = { ...DEFAULT_SETTINGS };
  let currentShortcut = "";
  let isRecording = false;
  let statusTimer = null;
  let destroyed = false;

  function showStatus(text, isError = false) {
    if (!statusEl) {
      return;
    }
    clearTimeout(statusTimer);
    statusEl.textContent = text;
    statusEl.className = isError
      ? "save-status save-status--error"
      : "save-status";
    if (text && statusDurationMs > 0) {
      statusTimer = setTimeout(() => {
        if (!destroyed && statusEl) {
          statusEl.textContent = "";
          statusEl.className = "save-status";
        }
      }, statusDurationMs);
    }
  }

  function syncCheckboxes() {
    for (const { key, input } of checkboxBindings) {
      if (input) {
        input.checked = Boolean(currentSettings[key]);
      }
    }
  }

  function syncShortcutInput() {
    if (shortcutInput) {
      if (isRecording) {
        shortcutInput.value = "";
        shortcutInput.placeholder = "Press shortcut\u2026";
        if (shortcutInput.dataset) {
          shortcutInput.dataset.recording = "true";
        }
      } else {
        shortcutInput.value = formatShortcutForDisplay(currentShortcut, {
          isMac: resolvedIsMac,
        });
        shortcutInput.placeholder = "";
        if (shortcutInput.dataset) {
          delete shortcutInput.dataset.recording;
        }
      }
      shortcutInput.disabled = !canCustomizeShortcut;
    }

    if (resetShortcutBtn) {
      resetShortcutBtn.disabled = !canResetShortcut;
    }
    if (clearShortcutBtn) {
      clearShortcutBtn.disabled = !canCustomizeShortcut || !currentShortcut;
    }
  }

  async function saveBooleanSetting(key, input, nextValue) {
    try {
      const saved = await saveSettings(browserApi?.storage?.local, {
        [key]: nextValue,
      });
      if (!saved) {
        throw new Error("Storage unavailable");
      }
      currentSettings[key] = nextValue;
      showStatus("Saved", false);
    } catch {
      if (input) {
        input.checked = Boolean(currentSettings[key]);
      }
      showStatus("Could not save setting", true);
    }
  }

  async function handleOpenOnNewTabChange() {
    const nextValue = Boolean(openOnNewTabInput.checked);

    // Request optional permissions synchronously before any await to preserve the user gesture.
    if (nextValue && typeof browserApi?.permissions?.request === "function") {
      let granted = false;
      try {
        granted = Boolean(
          await browserApi.permissions.request({
            permissions: [...NEWTAB_OPTIONAL_PERMISSIONS],
          })
        );
      } catch {
        granted = false;
      }
      if (destroyed) {
        return;
      }
      if (!granted) {
        openOnNewTabInput.checked = Boolean(
          currentSettings[STORAGE_KEY_OPEN_ON_NEW_TAB]
        );
        showStatus("Permission is required to open on new tabs", true);
        return;
      }
    }

    await saveBooleanSetting(
      STORAGE_KEY_OPEN_ON_NEW_TAB,
      openOnNewTabInput,
      nextValue
    );
  }

  function handleAutoOpenChange() {
    return saveBooleanSetting(
      STORAGE_KEY_AUTO_OPEN_SINGLE_MATCH,
      autoOpenInput,
      Boolean(autoOpenInput.checked)
    );
  }

  function handleStorageChanged(changes, areaName) {
    if (areaName !== "local" || !changes) {
      return;
    }

    let changedFromCurrent = false;
    for (const { key, input } of checkboxBindings) {
      if (key in changes) {
        const next = changes[key]?.newValue;
        const resolved =
          typeof next === "boolean" ? next : DEFAULT_SETTINGS[key];
        if (currentSettings[key] !== resolved) {
          changedFromCurrent = true;
        }
        currentSettings[key] = resolved;
        if (input) {
          input.checked = resolved;
        }
      }
    }

    if (changedFromCurrent) {
      showStatus("", false);
    }
  }

  function startRecording() {
    if (!canCustomizeShortcut || isRecording) {
      return;
    }
    isRecording = true;
    syncShortcutInput();
  }

  function stopRecording() {
    if (!isRecording) {
      return;
    }
    isRecording = false;
    syncShortcutInput();
  }

  async function handleShortcutKeyDown(event) {
    if (!canCustomizeShortcut || event.key === "Tab") {
      return;
    }

    if (!isRecording) {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault?.();
        startRecording();
      }
      return;
    }

    event.preventDefault?.();
    event.stopPropagation?.();

    const parsed = eventToShortcut(event, { isMac: resolvedIsMac });
    if (parsed.status === "cancel") {
      isRecording = false;
      syncShortcutInput();
      shortcutInput?.blur?.();
      showStatus("", false);
      return;
    }

    if (parsed.status === "modifier-only") {
      return;
    }

    if (parsed.status === "invalid") {
      showStatus(parsed.error, true);
      return;
    }

    try {
      const saved = await updateCommandShortcut(
        browserApi?.commands,
        parsed.shortcut,
        COMMAND_OPEN_PICKER
      );
      if (destroyed) {
        return;
      }
      currentShortcut = saved;
      isRecording = false;
      syncShortcutInput();
      shortcutInput?.blur?.();
      showStatus("Shortcut saved", false);
    } catch (error) {
      if (!destroyed) {
        showStatus(
          error?.message ||
            "Firefox rejected that shortcut. Try another combination.",
          true
        );
      }
    }
  }

  async function handleResetShortcut() {
    if (!canResetShortcut) {
      return;
    }
    try {
      const resetValue = await resetCommandShortcut(
        browserApi?.commands,
        COMMAND_OPEN_PICKER
      );
      if (destroyed) {
        return;
      }
      currentShortcut = resetValue;
      isRecording = false;
      syncShortcutInput();
      showStatus("Shortcut reset to default", false);
    } catch {
      if (!destroyed) {
        showStatus("Could not reset shortcut", true);
      }
    }
  }

  async function handleClearShortcut() {
    if (!canCustomizeShortcut) {
      return;
    }
    try {
      await updateCommandShortcut(
        browserApi?.commands,
        "",
        COMMAND_OPEN_PICKER
      );
      if (destroyed) {
        return;
      }
      currentShortcut = "";
      isRecording = false;
      syncShortcutInput();
      showStatus("Shortcut cleared", false);
    } catch {
      if (!destroyed) {
        showStatus("Could not clear shortcut", true);
      }
    }
  }

  async function handleWindowFocus() {
    if (
      destroyed ||
      isRecording ||
      typeof browserApi?.commands?.getAll !== "function"
    ) {
      return;
    }
    const latest = await getCommandShortcut(
      browserApi.commands,
      COMMAND_OPEN_PICKER
    );
    if (!destroyed && !isRecording && latest !== currentShortcut) {
      currentShortcut = latest;
      syncShortcutInput();
    }
  }

  const [settings, activeShortcut] = await Promise.all([
    loadSettings(browserApi?.storage?.local),
    getCommandShortcut(browserApi?.commands, COMMAND_OPEN_PICKER),
  ]);
  currentSettings = settings;
  currentShortcut = activeShortcut;

  if (
    currentSettings[STORAGE_KEY_OPEN_ON_NEW_TAB] === true &&
    typeof browserApi?.permissions?.contains === "function"
  ) {
    try {
      const granted = await browserApi.permissions.contains({
        permissions: [...NEWTAB_OPTIONAL_PERMISSIONS],
      });
      if (!granted) {
        currentSettings[STORAGE_KEY_OPEN_ON_NEW_TAB] = false;
        await saveSettings(browserApi?.storage?.local, {
          [STORAGE_KEY_OPEN_ON_NEW_TAB]: false,
        }).catch(() => {});
      }
    } catch {
      // Ignore permission check failures
    }
  }

  syncCheckboxes();
  syncShortcutInput();

  if (!destroyed) {
    openOnNewTabInput?.addEventListener("change", handleOpenOnNewTabChange);
    autoOpenInput?.addEventListener("change", handleAutoOpenChange);
    shortcutInput?.addEventListener("focus", startRecording);
    shortcutInput?.addEventListener("click", startRecording);
    shortcutInput?.addEventListener("blur", stopRecording);
    shortcutInput?.addEventListener("keydown", handleShortcutKeyDown);
    resetShortcutBtn?.addEventListener("click", handleResetShortcut);
    clearShortcutBtn?.addEventListener("click", handleClearShortcut);
    win?.addEventListener?.("focus", handleWindowFocus);
    browserApi?.storage?.onChanged?.addListener?.(handleStorageChanged);
  }

  return {
    getState: () => ({
      ...currentSettings,
      shortcut: currentShortcut,
    }),
    destroy() {
      destroyed = true;
      clearTimeout(statusTimer);
      openOnNewTabInput?.removeEventListener(
        "change",
        handleOpenOnNewTabChange
      );
      autoOpenInput?.removeEventListener("change", handleAutoOpenChange);
      shortcutInput?.removeEventListener("focus", startRecording);
      shortcutInput?.removeEventListener("click", startRecording);
      shortcutInput?.removeEventListener("blur", stopRecording);
      shortcutInput?.removeEventListener("keydown", handleShortcutKeyDown);
      resetShortcutBtn?.removeEventListener("click", handleResetShortcut);
      clearShortcutBtn?.removeEventListener("click", handleClearShortcut);
      win?.removeEventListener?.("focus", handleWindowFocus);
      browserApi?.storage?.onChanged?.removeListener?.(handleStorageChanged);
    },
  };
}

if (
  typeof document !== "undefined" &&
  document.getElementById("setting-auto-open")
) {
  createOptionsController();
}
