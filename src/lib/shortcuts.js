export const COMMAND_OPEN_PICKER = "_execute_action";
export const DEFAULT_PICKER_SHORTCUT = "Ctrl+Shift+Y";

const MODIFIER_ALIASES = Object.freeze({
  ctrl: "Ctrl",
  alt: "Alt",
  command: "Command",
  macctrl: "MacCtrl",
  shift: "Shift",
});

const MODIFIER_PRIORITY = Object.freeze({
  Command: 0,
  Ctrl: 1,
  MacCtrl: 2,
  Alt: 3,
  Shift: 4,
});

const PRIMARY_MODIFIERS = new Set(["Command", "Ctrl", "MacCtrl", "Alt"]);

const NAMED_KEY_ALIASES = Object.freeze({
  comma: "Comma",
  period: "Period",
  home: "Home",
  end: "End",
  pageup: "PageUp",
  pagedown: "PageDown",
  space: "Space",
  insert: "Insert",
  delete: "Delete",
  up: "Up",
  down: "Down",
  left: "Left",
  right: "Right",
});

const CODE_TO_KEY = Object.freeze({
  Comma: "Comma",
  Period: "Period",
  Space: "Space",
  Home: "Home",
  End: "End",
  PageUp: "PageUp",
  PageDown: "PageDown",
  Insert: "Insert",
  Delete: "Delete",
  ArrowUp: "Up",
  ArrowDown: "Down",
  ArrowLeft: "Left",
  ArrowRight: "Right",
});

const FALLBACK_KEY_ALIASES = Object.freeze({
  ",": "Comma",
  ".": "Period",
  " ": "Space",
  Spacebar: "Space",
  Home: "Home",
  End: "End",
  PageUp: "PageUp",
  PageDown: "PageDown",
  Insert: "Insert",
  Delete: "Delete",
  ArrowUp: "Up",
  ArrowDown: "Down",
  ArrowLeft: "Left",
  ArrowRight: "Right",
});

const PURE_MODIFIER_CODES = new Set([
  "ShiftLeft",
  "ShiftRight",
  "ControlLeft",
  "ControlRight",
  "AltLeft",
  "AltRight",
  "MetaLeft",
  "MetaRight",
]);

const PURE_MODIFIER_KEYS = new Set([
  "Shift",
  "Control",
  "Alt",
  "Meta",
  "OS",
  "AltGraph",
]);

const FUNCTION_KEY_RE = /^F(?:[1-9]|1[0-2])$/;

const UNSUPPORTED_KEY_ERROR =
  "That key isn\u2019t supported. Use A\u2013Z, 0\u20139, F1\u2013F12, arrows, Space, Comma, Period, Home, End, PageUp, PageDown, Insert, or Delete.";

/**
 * Detect whether the current runtime platform is macOS.
 * @param {{ platform?: string, userAgent?: string } | undefined} [nav]
 * @returns {boolean}
 */
export function isMacPlatform(nav = globalThis.navigator) {
  return /mac/i.test(String(nav?.platform || nav?.userAgent || ""));
}

function canonicalizeKeyToken(rawToken) {
  const token = String(rawToken || "").trim();
  if (/^[a-z]$/i.test(token)) {
    return token.toUpperCase();
  }
  if (/^[0-9]$/.test(token)) {
    return token;
  }
  const fnMatch = /^f([1-9]|1[0-2])$/i.exec(token);
  if (fnMatch) {
    return `F${fnMatch[1]}`;
  }
  return NAMED_KEY_ALIASES[token.toLowerCase()] ?? null;
}

function mapCodeToCommandKey(code) {
  if (typeof code !== "string" || code.length === 0) {
    return null;
  }
  const letterMatch = /^Key([A-Z])$/.exec(code);
  if (letterMatch) {
    return letterMatch[1];
  }
  const digitMatch = /^Digit([0-9])$/.exec(code);
  if (digitMatch) {
    return digitMatch[1];
  }
  const fnMatch = /^F([1-9]|1[0-2])$/.exec(code);
  if (fnMatch) {
    return `F${fnMatch[1]}`;
  }
  return CODE_TO_KEY[code] ?? null;
}

function mapFallbackKeyToCommandKey(key) {
  if (typeof key !== "string" || key.length === 0) {
    return null;
  }
  if (/^[a-z]$/i.test(key)) {
    return key.toUpperCase();
  }
  if (/^[0-9]$/.test(key)) {
    return key;
  }
  const fnMatch = /^f([1-9]|1[0-2])$/i.exec(key);
  if (fnMatch) {
    return `F${fnMatch[1]}`;
  }
  return FALLBACK_KEY_ALIASES[key] ?? null;
}

/**
 * Validate and normalize a WebExtension commands shortcut string.
 * @param {unknown} shortcut
 * @param {{ allowEmpty?: boolean, isMac?: boolean }} [options]
 * @returns {{ valid: boolean, normalized?: string, error?: string }}
 */
export function validateShortcut(shortcut, options = {}) {
  const allowEmpty = Boolean(options.allowEmpty);
  const isMac = Boolean(options.isMac);

  if (typeof shortcut !== "string") {
    return { valid: false, error: "Press a shortcut combination." };
  }

  const trimmed = shortcut.trim();
  if (trimmed.length === 0) {
    return allowEmpty
      ? { valid: true, normalized: "" }
      : { valid: false, error: "Press a shortcut combination." };
  }

  const parts = trimmed.split("+").map((part) => part.trim());
  if (parts.some((part) => part.length === 0)) {
    return { valid: false, error: "Press a shortcut combination." };
  }

  const modifiers = [];
  const seenModifiers = new Set();

  for (let i = 0; i < parts.length - 1; i += 1) {
    const canonicalMod = MODIFIER_ALIASES[parts[i].toLowerCase()];
    if (!canonicalMod) {
      return { valid: false, error: UNSUPPORTED_KEY_ERROR };
    }
    if (seenModifiers.has(canonicalMod)) {
      return { valid: false, error: "Duplicate modifier in shortcut." };
    }
    seenModifiers.add(canonicalMod);
    modifiers.push(canonicalMod);
  }

  const lastPart = parts[parts.length - 1];
  if (MODIFIER_ALIASES[lastPart.toLowerCase()]) {
    return {
      valid: false,
      error: "Include a non-modifier key (such as A\u2013Z or F1\u2013F12).",
    };
  }

  const canonicalKey = canonicalizeKeyToken(lastPart);
  if (!canonicalKey) {
    return { valid: false, error: UNSUPPORTED_KEY_ERROR };
  }

  if (modifiers.length > 2) {
    return {
      valid: false,
      error: "Firefox shortcuts support at most 2 modifiers.",
    };
  }

  const isFunctionKey = FUNCTION_KEY_RE.test(canonicalKey);
  const hasPrimaryModifier = modifiers.some((mod) =>
    PRIMARY_MODIFIERS.has(mod)
  );
  if (!isFunctionKey && !hasPrimaryModifier) {
    return {
      valid: false,
      error: isMac
        ? "Include Command, Option, or Control in the shortcut."
        : "Include Ctrl or Alt in the shortcut.",
    };
  }

  modifiers.sort((a, b) => MODIFIER_PRIORITY[a] - MODIFIER_PRIORITY[b]);
  return {
    valid: true,
    normalized: [...modifiers, canonicalKey].join("+"),
  };
}

/**
 * Convert a KeyboardEvent into a Firefox WebExtension shortcut string or status.
 * Uses physical event.code when present so macOS Option dead/special keys map accurately.
 * @param {KeyboardEvent | object | null | undefined} event
 * @param {{ isMac?: boolean }} [options]
 * @returns {{ status: "cancel" | "modifier-only" | "valid" | "invalid", shortcut?: string, error?: string }}
 */
export function eventToShortcut(event, options = {}) {
  const isMac = options.isMac ?? isMacPlatform();

  if (!event || typeof event !== "object") {
    return { status: "invalid", error: "Press a shortcut combination." };
  }

  const hasAnyModifier = Boolean(
    event.ctrlKey || event.altKey || event.shiftKey || event.metaKey
  );

  if (event.key === "Escape" && !hasAnyModifier) {
    return { status: "cancel" };
  }

  if (
    (typeof event.code === "string" && PURE_MODIFIER_CODES.has(event.code)) ||
    PURE_MODIFIER_KEYS.has(event.key)
  ) {
    return { status: "modifier-only" };
  }

  if (!isMac && event.metaKey) {
    return {
      status: "invalid",
      error: "The Meta/Windows key isn\u2019t supported for Firefox shortcuts.",
    };
  }

  const hasCode = typeof event.code === "string" && event.code.length > 0;
  const mappedKey = hasCode
    ? mapCodeToCommandKey(event.code)
    : mapFallbackKeyToCommandKey(event.key);

  if (!mappedKey) {
    return { status: "invalid", error: UNSUPPORTED_KEY_ERROR };
  }

  const modifiers = [];
  if (isMac) {
    if (event.metaKey) modifiers.push("Command");
    if (event.ctrlKey) modifiers.push("MacCtrl");
    if (event.altKey) modifiers.push("Alt");
    if (event.shiftKey) modifiers.push("Shift");
  } else {
    if (event.ctrlKey) modifiers.push("Ctrl");
    if (event.altKey) modifiers.push("Alt");
    if (event.shiftKey) modifiers.push("Shift");
  }

  const candidate = [...modifiers, mappedKey].join("+");
  const validation = validateShortcut(candidate, { allowEmpty: false, isMac });
  if (!validation.valid) {
    return { status: "invalid", error: validation.error };
  }

  return { status: "valid", shortcut: validation.normalized };
}

const DISPLAY_KEY_MAP = Object.freeze({
  Comma: ",",
  Period: ".",
  Up: "\u2191",
  Down: "\u2193",
  Left: "\u2190",
  Right: "\u2192",
});

const MAC_DISPLAY_MODIFIER_MAP = Object.freeze({
  Alt: "Option",
  MacCtrl: "Control",
  Ctrl: "Command",
  Command: "Command",
  Shift: "Shift",
});

const DEFAULT_DISPLAY_MODIFIER_MAP = Object.freeze({
  Ctrl: "Ctrl",
  Alt: "Alt",
  Shift: "Shift",
  Command: "Command",
  MacCtrl: "Ctrl",
});

/**
 * Format a WebExtension shortcut string for human-readable display.
 * @param {string | null | undefined} shortcut
 * @param {{ isMac?: boolean }} [options]
 * @returns {string}
 */
export function formatShortcutForDisplay(shortcut, options = {}) {
  if (typeof shortcut !== "string" || shortcut.trim().length === 0) {
    return "Not set";
  }

  const isMac = options.isMac ?? isMacPlatform();
  const modifierMap = isMac
    ? MAC_DISPLAY_MODIFIER_MAP
    : DEFAULT_DISPLAY_MODIFIER_MAP;

  return shortcut
    .trim()
    .split("+")
    .map((part) => {
      const token = part.trim();
      return modifierMap[token] ?? DISPLAY_KEY_MAP[token] ?? token;
    })
    .join("+");
}

/**
 * Read the active shortcut for a registered WebExtension command.
 * @param {{ getAll?: () => Promise<Array<{ name?: string, shortcut?: string }>> } | undefined} commandsApi
 * @param {string} [commandName]
 * @returns {Promise<string>}
 */
export async function getCommandShortcut(
  commandsApi,
  commandName = COMMAND_OPEN_PICKER
) {
  if (typeof commandsApi?.getAll !== "function") {
    return "";
  }
  try {
    const commands = await commandsApi.getAll();
    if (!Array.isArray(commands)) {
      return "";
    }
    const match = commands.find((cmd) => cmd?.name === commandName);
    return typeof match?.shortcut === "string" ? match.shortcut : "";
  } catch {
    return "";
  }
}

/**
 * Validate and update a registered WebExtension command shortcut.
 * @param {{ update?: (details: { name: string, shortcut: string }) => Promise<void> } | undefined} commandsApi
 * @param {string} shortcut
 * @param {string} [commandName]
 * @returns {Promise<string>} Normalized shortcut written to Firefox.
 */
export async function updateCommandShortcut(
  commandsApi,
  shortcut,
  commandName = COMMAND_OPEN_PICKER
) {
  const validation = validateShortcut(shortcut, { allowEmpty: true });
  if (!validation.valid) {
    throw new Error(validation.error);
  }
  if (typeof commandsApi?.update !== "function") {
    throw new Error("Firefox shortcut customization API is unavailable.");
  }
  await commandsApi.update({
    name: commandName,
    shortcut: validation.normalized,
  });
  return validation.normalized;
}

/**
 * Reset a registered WebExtension command shortcut back to its manifest default.
 * @param {{ reset?: (name: string) => Promise<void>, getAll?: () => Promise<Array<object>> } | undefined} commandsApi
 * @param {string} [commandName]
 * @returns {Promise<string>} Resolved active shortcut after reset.
 */
export async function resetCommandShortcut(
  commandsApi,
  commandName = COMMAND_OPEN_PICKER
) {
  if (typeof commandsApi?.reset !== "function") {
    throw new Error("Firefox shortcut reset API is unavailable.");
  }
  await commandsApi.reset(commandName);
  if (typeof commandsApi.getAll === "function") {
    const active = await getCommandShortcut(commandsApi, commandName);
    if (active) {
      return active;
    }
  }
  return DEFAULT_PICKER_SHORTCUT;
}
