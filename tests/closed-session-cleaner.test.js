import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_MAX_PASSES,
  createClosedSessionCleaner,
  isClosedPickerTab,
  isClosedPickerWindow,
} from "../src/background/closed-session-cleaner.js";

const runtime = {
  getURL: (path) => `moz-extension://test-uuid/${path}`,
};

const PICKER_URL =
  "moz-extension://test-uuid/src/picker/picker.html?session=abc-123";

test("isClosedPickerWindow and isClosedPickerTab match picker URLs and reject non-picker or malformed entries", () => {
  assert.equal(
    isClosedPickerWindow(runtime, {
      sessionId: "win-1",
      tabs: [{ url: PICKER_URL }],
    }),
    true
  );
  assert.equal(
    isClosedPickerWindow(runtime, {
      sessionId: "win-2",
      tabs: [{ url: "", pendingUrl: PICKER_URL }],
    }),
    true
  );

  // Reject user windows, mixed windows, empty tabs, and malformed metadata
  assert.equal(
    isClosedPickerWindow(runtime, {
      sessionId: "win-user",
      tabs: [{ url: "https://example.com" }],
    }),
    false
  );
  assert.equal(
    isClosedPickerWindow(runtime, {
      sessionId: "win-mixed",
      tabs: [{ url: PICKER_URL }, { url: "https://example.com" }],
    }),
    false
  );
  assert.equal(
    isClosedPickerWindow(runtime, { sessionId: "win-empty", tabs: [] }),
    false
  );
  assert.equal(
    isClosedPickerWindow(runtime, { sessionId: "", tabs: [{ url: PICKER_URL }] }),
    false
  );
  assert.equal(isClosedPickerWindow(runtime, null), false);
  assert.equal(isClosedPickerWindow(runtime, undefined), false);

  // Tabs
  assert.equal(
    isClosedPickerTab(runtime, {
      sessionId: "tab-1",
      windowId: 10,
      url: PICKER_URL,
    }),
    true
  );
  assert.equal(
    isClosedPickerTab(runtime, {
      sessionId: "tab-2",
      windowId: 10,
      pendingUrl: PICKER_URL,
    }),
    true
  );
  assert.equal(
    isClosedPickerTab(runtime, {
      sessionId: "tab-user",
      windowId: 10,
      url: "about:newtab",
    }),
    false
  );
  assert.equal(
    isClosedPickerTab(runtime, {
      sessionId: "tab-bad-win",
      windowId: "10",
      url: PICKER_URL,
    }),
    false
  );
  assert.equal(
    isClosedPickerTab(runtime, {
      sessionId: "tab-nan-win",
      windowId: Number.NaN,
      url: PICKER_URL,
    }),
    false
  );
  assert.equal(
    isClosedPickerTab(runtime, {
      sessionId: "",
      windowId: 10,
      url: PICKER_URL,
    }),
    false
  );
  assert.equal(isClosedPickerTab(runtime, null), false);
});

test("purge forgets closed picker windows and tabs while preserving user entries", async () => {
  const recent = [
    { window: { sessionId: "w-picker", tabs: [{ url: PICKER_URL }] } },
    { tab: { windowId: 10, sessionId: "t-user", url: "https://mozilla.org" } },
    { tab: { windowId: 10, sessionId: "t-picker", url: PICKER_URL } },
    {
      window: {
        sessionId: "w-user",
        tabs: [{ url: "https://example.com" }, { url: PICKER_URL }],
      },
    },
  ];
  const getArgs = [];
  const forgottenWindows = [];
  const forgottenTabs = [];

  const cleaner = createClosedSessionCleaner({
    runtime,
    sessions: {
      async getRecentlyClosed(...args) {
        getArgs.push(args);
        return recent.slice();
      },
      async forgetClosedWindow(sessionId) {
        forgottenWindows.push(sessionId);
        const idx = recent.findIndex((e) => e.window?.sessionId === sessionId);
        if (idx !== -1) recent.splice(idx, 1);
      },
      async forgetClosedTab(windowId, sessionId) {
        forgottenTabs.push([windowId, sessionId]);
        const idx = recent.findIndex(
          (e) =>
            e.tab?.windowId === windowId && e.tab?.sessionId === sessionId
        );
        if (idx !== -1) recent.splice(idx, 1);
      },
    },
  });

  const count = await cleaner.purge();
  assert.equal(count, 2);
  assert.deepEqual(getArgs, [[]]);
  assert.deepEqual(forgottenWindows, ["w-picker"]);
  assert.deepEqual(forgottenTabs, [[10, "t-picker"]]);
  assert.equal(recent.length, 2);
  assert.equal(recent[0].tab.sessionId, "t-user");
  assert.equal(recent[1].window.sessionId, "w-user");
});

test("purge is a safe no-op when sessions API is absent or getRecentlyClosed fails", async () => {
  const noSessionsCleaner = createClosedSessionCleaner({ runtime });
  assert.equal(await noSessionsCleaner.purge(), 0);

  const throwingCleaner = createClosedSessionCleaner({
    runtime,
    sessions: {
      async getRecentlyClosed() {
        throw new Error("Sessions unavailable");
      },
    },
  });
  assert.equal(await throwingCleaner.purge(), 0);

  const nonArrayCleaner = createClosedSessionCleaner({
    runtime,
    sessions: {
      async getRecentlyClosed() {
        return null;
      },
    },
  });
  assert.equal(await nonArrayCleaner.purge(), 0);
});

test("purge coalesces synchronous re-entrant calls triggered inside forgetClosedWindow", async () => {
  const recent = [
    { window: { sessionId: "w-picker-1", tabs: [{ url: PICKER_URL }] } },
    { tab: { windowId: 10, sessionId: "t-user", url: "https://example.com" } },
  ];
  let getCalls = 0;
  const forgottenWindows = [];
  let reentrantPromise = null;

  const cleaner = createClosedSessionCleaner({
    runtime,
    sessions: {
      async getRecentlyClosed() {
        getCalls += 1;
        return recent.slice();
      },
      async forgetClosedWindow(sessionId) {
        forgottenWindows.push(sessionId);
        const idx = recent.findIndex((e) => e.window?.sessionId === sessionId);
        if (idx !== -1) recent.splice(idx, 1);
        reentrantPromise = cleaner.purge();
      },
    },
  });

  const count = await cleaner.purge();
  assert.equal(count, 1);
  assert.equal(await reentrantPromise, 1);
  assert.deepEqual(forgottenWindows, ["w-picker-1"]);
  assert.equal(getCalls, 2);
});

test("purge catches a second closed picker window arriving mid-purge on the follow-up pass", async () => {
  const recent = [
    { window: { sessionId: "w-1", tabs: [{ url: PICKER_URL }] } },
  ];
  const forgottenWindows = [];
  let releaseFirstForget;
  const firstForgetStarted = new Promise((resolve) => {
    releaseFirstForget = resolve;
  });
  let continueFirstForget;
  const firstForgetGate = new Promise((resolve) => {
    continueFirstForget = resolve;
  });

  const cleaner = createClosedSessionCleaner({
    runtime,
    sessions: {
      async getRecentlyClosed() {
        return recent.slice();
      },
      async forgetClosedWindow(sessionId) {
        forgottenWindows.push(sessionId);
        const idx = recent.findIndex((e) => e.window?.sessionId === sessionId);
        if (idx !== -1) recent.splice(idx, 1);
        if (sessionId === "w-1") {
          releaseFirstForget();
          await firstForgetGate;
        }
      },
    },
  });

  const p1 = cleaner.purge();
  await firstForgetStarted;

  recent.unshift({ window: { sessionId: "w-2", tabs: [{ url: PICKER_URL }] } });
  const p2 = cleaner.purge();
  continueFirstForget();

  const [r1, r2] = await Promise.all([p1, p2]);
  assert.equal(r1, 2);
  assert.equal(r2, 2);
  assert.deepEqual(forgottenWindows, ["w-1", "w-2"]);
  assert.equal(recent.length, 0);
});

test("purge isolates failing entries, skips retrying failed IDs in-run, and respects maxPasses", async () => {
  const recent = [
    { window: { sessionId: "w-fail", tabs: [{ url: PICKER_URL }] } },
    { window: { sessionId: "w-ok", tabs: [{ url: PICKER_URL }] } },
  ];
  const attempts = [];
  let rerunRef = null;

  const resilientCleaner = createClosedSessionCleaner({
    runtime,
    sessions: {
      async getRecentlyClosed() {
        return recent.slice();
      },
      async forgetClosedWindow(sessionId) {
        attempts.push(sessionId);
        if (sessionId === "w-fail") {
          rerunRef = resilientCleaner.purge();
          throw new Error("Cannot forget w-fail");
        }
        const idx = recent.findIndex((e) => e.window?.sessionId === sessionId);
        if (idx !== -1) recent.splice(idx, 1);
      },
    },
  });

  const count = await resilientCleaner.purge();
  assert.equal(count, 1);
  assert.equal(await rerunRef, 1);
  assert.deepEqual(attempts, ["w-fail", "w-ok"]);

  assert.equal(DEFAULT_MAX_PASSES, 5);
  let passCount = 0;
  let seq = 0;
  const boundedCleaner = createClosedSessionCleaner(
    {
      runtime,
      sessions: {
        async getRecentlyClosed() {
          passCount += 1;
          return [
            {
              window: {
                sessionId: `w-loop-${++seq}`,
                tabs: [{ url: PICKER_URL }],
              },
            },
          ];
        },
        async forgetClosedWindow() {
          void boundedCleaner.purge();
        },
      },
    },
    { maxPasses: 2 }
  );

  assert.equal(await boundedCleaner.purge(), 2);
  assert.equal(passCount, 2);
  assert.equal(await boundedCleaner.purge(), 2);
  assert.equal(passCount, 4);
});
