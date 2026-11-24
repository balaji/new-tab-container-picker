import test from "node:test";
import assert from "node:assert/strict";
import {
  COMMAND_OPEN_PICKER,
  DEFAULT_PICKER_SHORTCUT,
  eventToShortcut,
  formatShortcutForDisplay,
  getCommandShortcut,
  isMacPlatform,
  resetCommandShortcut,
  updateCommandShortcut,
  validateShortcut,
} from "../src/lib/shortcuts.js";

test("isMacPlatform detects macOS platform and userAgent safely", () => {
  assert.equal(isMacPlatform({ platform: "MacIntel" }), true);
  assert.equal(isMacPlatform({ userAgent: "Mozilla/5.0 (Macintosh)" }), true);
  assert.equal(isMacPlatform({ platform: "Win32" }), false);
  assert.equal(isMacPlatform({ platform: "Linux x86_64" }), false);
  assert.equal(isMacPlatform(null), false);
  assert.equal(isMacPlatform({}), false);
});

test("eventToShortcut maps macOS shortcuts using physical event.code (including Option special chars)", () => {
  // Option+Shift+T produces event.key === "ˇ" on macOS, but event.code is "KeyT"
  assert.deepEqual(
    eventToShortcut(
      { altKey: true, shiftKey: true, code: "KeyT", key: "ˇ" },
      { isMac: true }
    ),
    { status: "valid", shortcut: "Alt+Shift+T" }
  );

  assert.deepEqual(
    eventToShortcut(
      { metaKey: true, shiftKey: true, code: "KeyK", key: "K" },
      { isMac: true }
    ),
    { status: "valid", shortcut: "Command+Shift+K" }
  );

  assert.deepEqual(
    eventToShortcut(
      { ctrlKey: true, code: "KeyT", key: "t" },
      { isMac: true }
    ),
    { status: "valid", shortcut: "MacCtrl+T" }
  );

  assert.deepEqual(
    eventToShortcut({ key: "Escape", code: "Escape" }, { isMac: true }),
    { status: "cancel" }
  );

  assert.equal(
    eventToShortcut({ altKey: true, key: "Escape", code: "Escape" }, { isMac: true }).status,
    "invalid"
  );

  for (const modEvt of [
    { shiftKey: true, code: "ShiftLeft", key: "Shift" },
    { metaKey: true, code: "MetaLeft", key: "Meta" },
    { altKey: true, code: "AltRight", key: "Alt" },
    { ctrlKey: true, code: "ControlLeft", key: "Control" },
  ]) {
    assert.deepEqual(eventToShortcut(modEvt, { isMac: true }), {
      status: "modifier-only",
    });
  }

  // >2 modifiers rejected
  const tooMany = eventToShortcut(
    { metaKey: true, ctrlKey: true, altKey: true, code: "KeyT", key: "t" },
    { isMac: true }
  );
  assert.equal(tooMany.status, "invalid");
  assert.match(tooMany.error, /at most 2 modifiers/i);

  // Shift-only rejected
  const shiftOnly = eventToShortcut(
    { shiftKey: true, code: "KeyT", key: "T" },
    { isMac: true }
  );
  assert.equal(shiftOnly.status, "invalid");
  assert.match(shiftOnly.error, /Command, Option, or Control/i);

  // Unsupported key rejected
  assert.equal(
    eventToShortcut({ altKey: true, code: "Slash", key: "/" }, { isMac: true }).status,
    "invalid"
  );
});

test("eventToShortcut handles Windows/Linux modifiers, function keys, Meta rejection, and fallback keys", () => {
  assert.deepEqual(
    eventToShortcut(
      { ctrlKey: true, shiftKey: true, code: "KeyY", key: "Y" },
      { isMac: false }
    ),
    { status: "valid", shortcut: "Ctrl+Shift+Y" }
  );

  assert.deepEqual(
    eventToShortcut(
      { altKey: true, shiftKey: true, code: "KeyT", key: "T" },
      { isMac: false }
    ),
    { status: "valid", shortcut: "Alt+Shift+T" }
  );

  assert.deepEqual(
    eventToShortcut({ code: "F8", key: "F8" }, { isMac: false }),
    { status: "valid", shortcut: "F8" }
  );

  const metaRejected = eventToShortcut(
    { metaKey: true, code: "KeyK", key: "k" },
    { isMac: false }
  );
  assert.equal(metaRejected.status, "invalid");
  assert.match(metaRejected.error, /Meta\/Windows/i);

  const threeMods = eventToShortcut(
    { ctrlKey: true, altKey: true, shiftKey: true, code: "KeyT", key: "T" },
    { isMac: false }
  );
  assert.equal(threeMods.status, "invalid");
  assert.match(threeMods.error, /at most 2 modifiers/i);

  // Fallback to event.key when event.code is absent
  assert.deepEqual(
    eventToShortcut({ ctrlKey: true, key: "," }, { isMac: false }),
    { status: "valid", shortcut: "Ctrl+Comma" }
  );
  assert.deepEqual(
    eventToShortcut({ altKey: true, key: " " }, { isMac: false }),
    { status: "valid", shortcut: "Alt+Space" }
  );
  assert.deepEqual(
    eventToShortcut({ ctrlKey: true, key: "ArrowUp" }, { isMac: false }),
    { status: "valid", shortcut: "Ctrl+Up" }
  );
});

test("validateShortcut normalizes case/order and enforces WebExtension grammar", () => {
  assert.deepEqual(validateShortcut("", { allowEmpty: true }), {
    valid: true,
    normalized: "",
  });
  assert.equal(validateShortcut("", { allowEmpty: false }).valid, false);
  assert.equal(validateShortcut(null).valid, false);

  assert.deepEqual(validateShortcut("shift+alt+t"), {
    valid: true,
    normalized: "Alt+Shift+T",
  });
  assert.deepEqual(validateShortcut("shift+ctrl+comma"), {
    valid: true,
    normalized: "Ctrl+Shift+Comma",
  });
  assert.deepEqual(validateShortcut("f12"), {
    valid: true,
    normalized: "F12",
  });
  assert.deepEqual(validateShortcut("Shift+f1"), {
    valid: true,
    normalized: "Shift+F1",
  });

  assert.equal(validateShortcut("Ctrl+ctrl+T").valid, false);
  assert.equal(validateShortcut("Ctrl+Shift").valid, false);
  assert.equal(validateShortcut("Ctrl+A+B").valid, false);
  assert.equal(validateShortcut("T").valid, false);
  assert.equal(validateShortcut("Shift+T").valid, false);
  assert.equal(validateShortcut("Ctrl++T").valid, false);
});

test("formatShortcutForDisplay formats macOS and non-macOS shortcuts and empty values", () => {
  assert.equal(formatShortcutForDisplay("", { isMac: true }), "Not set");
  assert.equal(formatShortcutForDisplay(null, { isMac: false }), "Not set");
  assert.equal(
    formatShortcutForDisplay("Ctrl+Shift+U", { isMac: true }),
    "Command+Shift+U"
  );
  assert.equal(
    formatShortcutForDisplay("Ctrl+Shift+U", { isMac: false }),
    "Ctrl+Shift+U"
  );
  assert.equal(
    formatShortcutForDisplay("Alt+Shift+T", { isMac: true }),
    "Option+Shift+T"
  );
  assert.equal(
    formatShortcutForDisplay("MacCtrl+T", { isMac: true }),
    "Control+T"
  );
  assert.equal(
    formatShortcutForDisplay("Command+Comma", { isMac: true }),
    "Command+,"
  );
  assert.equal(
    formatShortcutForDisplay("Alt+Up", { isMac: true }),
    "Option+↑"
  );
  assert.equal(
    formatShortcutForDisplay("Alt+Shift+T", { isMac: false }),
    "Alt+Shift+T"
  );
  assert.equal(
    formatShortcutForDisplay("Ctrl+Period", { isMac: false }),
    "Ctrl+."
  );
  assert.equal(
    formatShortcutForDisplay("Ctrl+Left", { isMac: false }),
    "Ctrl+←"
  );
});

test("commands API wrappers read, update, and reset shortcuts safely", async () => {
  assert.equal(await getCommandShortcut(undefined), "");
  assert.equal(
    await getCommandShortcut({
      async getAll() {
        throw new Error("boom");
      },
    }),
    ""
  );

  let storedShortcut = DEFAULT_PICKER_SHORTCUT;
  const updateCalls = [];
  const resetCalls = [];
  const commandsApi = {
    async getAll() {
      return [
        { name: "other", shortcut: "Ctrl+O" },
        { name: COMMAND_OPEN_PICKER, shortcut: storedShortcut },
      ];
    },
    async update(details) {
      updateCalls.push(details);
      storedShortcut = details.shortcut;
    },
    async reset(name) {
      resetCalls.push(name);
      storedShortcut = DEFAULT_PICKER_SHORTCUT;
    },
  };

  assert.equal(DEFAULT_PICKER_SHORTCUT, "Ctrl+Shift+U");
  assert.equal(await getCommandShortcut(commandsApi), "Ctrl+Shift+U");

  const updated = await updateCommandShortcut(commandsApi, "shift+alt+c");
  assert.equal(updated, "Alt+Shift+C");
  assert.deepEqual(updateCalls, [
    { name: "_execute_action", shortcut: "Alt+Shift+C" },
  ]);

  const cleared = await updateCommandShortcut(commandsApi, "");
  assert.equal(cleared, "");
  assert.equal(storedShortcut, "");

  const resetVal = await resetCommandShortcut(commandsApi);
  assert.equal(resetVal, "Ctrl+Shift+U");
  assert.deepEqual(resetCalls, ["_execute_action"]);

  await assert.rejects(
    updateCommandShortcut(commandsApi, "Shift+T"),
    /Include Ctrl or Alt/
  );
  await assert.rejects(
    updateCommandShortcut({}, "Alt+Shift+C"),
    /unavailable/i
  );
  await assert.rejects(resetCommandShortcut({}), /unavailable/i);

  assert.equal(
    await resetCommandShortcut({ async reset() {} }),
    DEFAULT_PICKER_SHORTCUT
  );
});
