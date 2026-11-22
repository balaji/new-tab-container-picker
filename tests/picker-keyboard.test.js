import test from "node:test";
import assert from "node:assert/strict";
import { createKeyboardHandler } from "../src/picker/keyboard-handler.js";

function makeKeyEvent(key, extra = {}) {
  return {
    key,
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    prevented: false,
    preventDefault() {
      this.prevented = true;
    },
    ...extra,
  };
}

test("createKeyboardHandler handles navigation, confirmation, escape, settings focus, and refocus", () => {
  const searchInput = { value: "" };
  const settingsBtn = {};
  const doc = { activeElement: searchInput };

  const events = [];
  let focusCalls = 0;
  let itemCount = 3;

  const handleKeyDown = createKeyboardHandler({
    doc,
    searchInput,
    settingsBtn,
    focusSearchInput: () => {
      focusCalls += 1;
      doc.activeElement = searchInput;
    },
    getItemCount: () => itemCount,
    onMove: (d) => events.push(["move", d]),
    onJump: (e) => events.push(["jump", e]),
    onConfirm: () => events.push(["confirm"]),
    onCancel: () => events.push(["cancel"]),
  });

  // Escape
  const esc = makeKeyEvent("Escape");
  handleKeyDown(esc);
  assert.equal(esc.prevented, true);

  // ArrowDown / Ctrl+N and ArrowUp / Ctrl+P
  handleKeyDown(makeKeyEvent("ArrowDown"));
  handleKeyDown(makeKeyEvent("n", { ctrlKey: true }));
  handleKeyDown(makeKeyEvent("ArrowUp"));
  handleKeyDown(makeKeyEvent("p", { ctrlKey: true }));

  // Home / End when search input is empty
  handleKeyDown(makeKeyEvent("Home"));
  handleKeyDown(makeKeyEvent("End"));

  // Home / End ignored by list navigation when search input has text and is focused
  searchInput.value = "work";
  const homeWhileTyping = makeKeyEvent("Home");
  handleKeyDown(homeWhileTyping);
  assert.equal(homeWhileTyping.prevented, false);

  // Enter confirms
  const enter = makeKeyEvent("Enter");
  handleKeyDown(enter);
  assert.equal(enter.prevented, true);

  // Settings button focused: Enter/Space pass through, ArrowDown refocuses searchInput, printable key refocuses
  doc.activeElement = settingsBtn;
  const settingsEnter = makeKeyEvent("Enter");
  const settingsSpace = makeKeyEvent(" ");
  handleKeyDown(settingsEnter);
  handleKeyDown(settingsSpace);
  assert.equal(settingsEnter.prevented, false);
  assert.equal(settingsSpace.prevented, false);

  handleKeyDown(makeKeyEvent("ArrowDown"));
  assert.equal(focusCalls, 1);
  assert.equal(doc.activeElement, searchInput);

  doc.activeElement = settingsBtn;
  handleKeyDown(makeKeyEvent("w"));
  assert.equal(focusCalls, 2);
  assert.equal(doc.activeElement, searchInput);

  // Home/End no-op when itemCount === 0
  itemCount = 0;
  searchInput.value = "";
  const homeEmpty = makeKeyEvent("Home");
  handleKeyDown(homeEmpty);
  assert.equal(homeEmpty.prevented, false);

  assert.deepEqual(events, [
    ["cancel"],
    ["move", 1],
    ["move", 1],
    ["move", -1],
    ["move", -1],
    ["jump", "start"],
    ["jump", "end"],
    ["confirm"],
    ["move", 1],
  ]);
});
