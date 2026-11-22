import {
  DEFAULT_SETTINGS,
  STORAGE_KEY_AUTO_OPEN_SINGLE_MATCH,
  STORAGE_KEY_ENABLED,
  loadSettings,
  saveSettings,
} from "../lib/settings.js";

const DEFAULT_STATUS_DURATION_MS = 1500;

/**
 * Initialize and control the extension options page UI.
 * @param {{ browserApi?: object, doc?: Document, statusDurationMs?: number }} [deps]
 */
export async function createOptionsController(deps = {}) {
  const doc = deps.doc ?? document;
  const browserApi = deps.browserApi ?? globalThis.browser;
  const statusDurationMs = deps.statusDurationMs ?? DEFAULT_STATUS_DURATION_MS;

  const enabledInput = doc.getElementById("setting-enabled");
  const autoOpenInput = doc.getElementById("setting-auto-open");
  const statusEl = doc.getElementById("save-status");

  const bindings = [
    { key: STORAGE_KEY_ENABLED, input: enabledInput },
    { key: STORAGE_KEY_AUTO_OPEN_SINGLE_MATCH, input: autoOpenInput },
  ];

  let currentSettings = { ...DEFAULT_SETTINGS };
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

  function syncInputs() {
    for (const { key, input } of bindings) {
      if (input) {
        input.checked = Boolean(currentSettings[key]);
      }
    }
  }

  async function handleSettingChange(key, input) {
    const nextValue = Boolean(input.checked);
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
      input.checked = Boolean(currentSettings[key]);
      showStatus("Could not save setting", true);
    }
  }

  function handleStorageChanged(changes, areaName) {
    if (areaName !== "local" || !changes) {
      return;
    }

    let changedFromCurrent = false;
    for (const { key, input } of bindings) {
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

  currentSettings = await loadSettings(browserApi?.storage?.local);
  syncInputs();

  const changeHandlers = [];
  if (!destroyed) {
    for (const { key, input } of bindings) {
      if (!input) {
        continue;
      }
      const onChange = () => handleSettingChange(key, input);
      input.addEventListener("change", onChange);
      changeHandlers.push({ input, onChange });
    }
    browserApi?.storage?.onChanged?.addListener?.(handleStorageChanged);
  }

  return {
    getState: () => ({ ...currentSettings }),
    destroy() {
      destroyed = true;
      clearTimeout(statusTimer);
      for (const { input, onChange } of changeHandlers) {
        input.removeEventListener("change", onChange);
      }
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
