import test from "node:test";
import assert from "node:assert/strict";
import { createPickerClient } from "../src/picker/picker-client.js";

function createAnnouncerSpy() {
  const calls = [];
  return {
    calls,
    clear: () => calls.push(["clear"]),
    announceImmediate: (text) => calls.push(["immediate", text]),
  };
}

test("picker client supports preview mode load, pick, cancel reset, and settings notice", async () => {
  const announcer = createAnnouncerSpy();
  let resetCalls = 0;

  const client = createPickerClient({
    browserApi: undefined,
    win: { location: { search: "?preview=1&autoOpen=1" } },
    announcer,
    onPreviewReset: () => {
      resetCalls += 1;
    },
  });

  assert.equal(client.isPreviewMode, true);
  const loaded = await client.loadState();
  assert.equal(loaded.isPreview, true);
  assert.equal(loaded.autoOpenSingleMatch, true);
  assert.equal(loaded.containers.length, 5);

  await client.pickContainer("firefox-container-2", "Work");
  assert.equal(client.isSettled(), false);
  assert.deepEqual(announcer.calls.at(-1), ["immediate", "Preview selected: Work"]);

  await client.cancelEscape();
  assert.equal(client.isSettled(), false);
  assert.equal(resetCalls, 1);

  await client.openSettings();
  assert.deepEqual(announcer.calls.at(-1), [
    "immediate",
    "Preview mode: settings unavailable",
  ]);
});

test("picker client runtime mode handles GET_PICKER_STATE, settled guard, and openSettings fallback", async () => {
  // Invalid or throwing GET_PICKER_STATE -> null
  const invalidClient = createPickerClient({
    browserApi: { runtime: { sendMessage: async () => ({}) } },
    win: { location: { search: "?session=s1" } },
    announcer: createAnnouncerSpy(),
  });
  assert.equal(await invalidClient.loadState(), null);

  const throwingClient = createPickerClient({
    browserApi: {
      runtime: {
        sendMessage: async () => {
          throw new Error("Disconnected");
        },
      },
    },
    win: { location: { search: "?session=s1" } },
    announcer: createAnnouncerSpy(),
  });
  assert.equal(await throwingClient.loadState(), null);

  // Valid load + settled guard blocks duplicate sends
  const sent = [];
  let winClosed = false;
  const runtimeClient = createPickerClient({
    browserApi: {
      runtime: {
        async sendMessage(msg) {
          sent.push(msg);
          if (msg.type === "GET_PICKER_STATE") {
            return {
              sessionId: "resolved-s1",
              containers: [{ cookieStoreId: "firefox-default", name: "Default" }],
              settings: { autoOpenSingleMatch: true },
            };
          }
          return { ok: true };
        },
      },
    },
    win: {
      location: { search: "?session=req-s1" },
      close: () => {
        winClosed = true;
      },
    },
    announcer: createAnnouncerSpy(),
  });

  const loaded = await runtimeClient.loadState();
  assert.equal(loaded.sessionId, "resolved-s1");
  assert.equal(loaded.autoOpenSingleMatch, true);

  await runtimeClient.pickContainer("firefox-default", "Default");
  assert.equal(runtimeClient.isSettled(), true);
  // Subsequent calls ignored once settled
  await runtimeClient.cancelEscape();
  await runtimeClient.openSettings();
  assert.equal(sent.length, 2);
  assert.equal(winClosed, false);

  // openSettings falls back to openOptionsPage and closes window when sendMessage fails
  let fallbackOpened = 0;
  let fallbackClosed = false;
  const fallbackClient = createPickerClient({
    browserApi: {
      runtime: {
        async sendMessage() {
          throw new Error("Send failed");
        },
        async openOptionsPage() {
          fallbackOpened += 1;
        },
      },
    },
    win: {
      location: { search: "?session=s2" },
      close: () => {
        fallbackClosed = true;
      },
    },
    announcer: createAnnouncerSpy(),
  });

  await fallbackClient.openSettings();
  assert.equal(fallbackOpened, 1);
  assert.equal(fallbackClosed, true);
  assert.equal(fallbackClient.isSettled(), true);
});
