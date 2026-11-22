import test from "node:test";
import assert from "node:assert/strict";
import { createTabWatcher } from "../src/background/tab-watcher.js";

function createMockTabBrowser(tabsById = new Map()) {
  return {
    runtime: {
      getURL: (p) => `moz-extension://test/${p}`,
    },
    tabs: {
      async get(tabId) {
        const tab = tabsById.get(tabId);
        if (!tab) throw new Error(`No tab ${tabId}`);
        return { ...tab };
      },
    },
  };
}

test("handleTabCreated triggers immediately on about:newtab and ignores own picker URLs", async () => {
  const triggered = [];
  const watcher = createTabWatcher(createMockTabBrowser(), {
    onNewTabDetected: (tab) => triggered.push(tab.id),
  });

  await watcher.handleTabCreated({
    id: 1,
    windowId: 10,
    url: "moz-extension://test/src/picker/picker.html?session=1",
    active: true,
  });
  await watcher.handleTabCreated({
    id: 2,
    windowId: 10,
    url: "https://example.com",
    active: true,
  });
  await watcher.handleTabCreated({
    id: 3,
    windowId: 10,
    url: "about:newtab",
    active: true,
  });

  assert.deepEqual(triggered, [3]);
  watcher.destroy();
});

test("pending about:blank tabs resolve via timeout, URL update, or status complete", async () => {
  const tabsById = new Map([
    [10, { id: 10, windowId: 1, url: "about:blank", active: true }],
    [11, { id: 11, windowId: 1, url: "about:blank", active: true }],
    [12, { id: 12, windowId: 1, url: "about:blank", active: true }],
    [13, { id: 13, windowId: 1, url: "about:blank", active: true }],
  ]);
  const triggered = [];
  const watcher = createTabWatcher(createMockTabBrowser(tabsById), {
    pendingTimeoutMs: 25,
    onNewTabDetected: (tab) => triggered.push(tab.id),
  });

  // Case 1: timeout resolves while still pending & active -> triggers
  await watcher.handleTabCreated({ id: 10, windowId: 1, url: "about:blank", active: true });
  assert.equal(watcher.hasPendingTab(10), true);
  await new Promise((r) => setTimeout(r, 40));
  assert.deepEqual(triggered, [10]);
  assert.equal(watcher.hasPendingTab(10), false);

  // Case 2: updates to about:newtab immediately -> triggers once and clears pending
  await watcher.handleTabCreated({ id: 11, windowId: 1, url: "about:blank", active: true });
  await watcher.handleTabUpdated(
    11,
    { url: "about:newtab" },
    { id: 11, windowId: 1, url: "about:newtab", active: true }
  );
  assert.equal(watcher.hasPendingTab(11), false);
  assert.deepEqual(triggered, [10, 11]);

  // Case 3: updates to external URL -> cancels pending
  await watcher.handleTabCreated({ id: 12, windowId: 1, url: "about:blank", active: true });
  await watcher.handleTabUpdated(
    12,
    { url: "https://mozilla.org" },
    { id: 12, windowId: 1, url: "https://mozilla.org", active: true }
  );
  assert.equal(watcher.hasPendingTab(12), false);

  // Case 4: completes as active pending URL -> triggers
  await watcher.handleTabCreated({ id: 13, windowId: 1, url: "about:blank", active: true });
  await watcher.handleTabUpdated(
    13,
    { status: "complete" },
    { id: 13, windowId: 1, url: "about:blank", active: true }
  );
  assert.equal(watcher.hasPendingTab(13), false);
  assert.deepEqual(triggered, [10, 11, 13]);

  watcher.destroy();
});

test("ignoreTab expires after TTL, suppresses triggering, and cleans up on removal or destroy", async () => {
  const triggered = [];
  const watcher = createTabWatcher(createMockTabBrowser(), {
    ignoredTabTtlMs: 30,
    pendingTimeoutMs: 30,
    onNewTabDetected: (tab) => triggered.push(tab.id),
  });

  watcher.ignoreTab(50);
  assert.equal(watcher.isTabIgnored(50), true);
  await watcher.handleTabCreated({ id: 50, windowId: 1, url: "about:newtab", active: true });
  assert.deepEqual(triggered, []);

  // Wait for TTL expiry
  await new Promise((r) => setTimeout(r, 45));
  assert.equal(watcher.isTabIgnored(50), false);

  // Removing a tab clears both pending and ignored entries
  watcher.ignoreTab(51);
  await watcher.handleTabCreated({ id: 52, windowId: 1, url: "about:blank", active: true });
  watcher.handleTabRemoved(51);
  watcher.handleTabRemoved(52);
  assert.equal(watcher.isTabIgnored(51), false);
  assert.equal(watcher.hasPendingTab(52), false);

  // destroy clears all active timers cleanly
  watcher.ignoreTab(53);
  await watcher.handleTabCreated({ id: 54, windowId: 1, url: "about:blank", active: true });
  watcher.destroy();
  assert.equal(watcher.isTabIgnored(53), false);
  assert.equal(watcher.hasPendingTab(54), false);
});
