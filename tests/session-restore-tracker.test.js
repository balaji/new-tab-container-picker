import test from "node:test";
import assert from "node:assert/strict";
import {
  TAB_SESSION_SEEN_KEY,
  createSessionRestoreTracker,
  normalizeSessionUrlKeys,
} from "../src/background/session-restore-tracker.js";

test("normalizeSessionUrlKeys strips fragments and exposes scheme-agnostic keys for http(s) URLs", () => {
  assert.deepEqual(
    normalizeSessionUrlKeys("https://www.reddit.com/r/firefox?sort=top#top"),
    {
      urlKey: "https://www.reddit.com/r/firefox?sort=top",
      looseKey: "www.reddit.com/r/firefox?sort=top",
    }
  );
  assert.equal(normalizeSessionUrlKeys("about:newtab"), null);
  assert.equal(normalizeSessionUrlKeys("moz-extension://abc/page.html"), null);
  assert.equal(normalizeSessionUrlKeys(""), null);
});

test("sessionRestoreTracker detects Cmd+Shift+T and Cmd+Shift+N restores via getRecentlyClosed diff (including HSTS upgrades) without false positives", async () => {
  const recent = [
    {
      tab: {
        windowId: 10,
        sessionId: "s-reddit",
        url: "https://www.reddit.com/#feed",
        cookieStoreId: "firefox-container-2",
      },
    },
    {
      tab: {
        windowId: 10,
        sessionId: "s-http",
        url: "http://news.example.com/story?id=1",
        cookieStoreId: "firefox-default",
      },
    },
    {
      window: {
        sessionId: "w-closed",
        tabs: [
          {
            url: "https://a.example.com/",
            cookieStoreId: "firefox-container-1",
          },
          {
            url: "https://b.example.com/",
            cookieStoreId: "firefox-default",
          },
        ],
      },
    },
  ];

  const tracker = createSessionRestoreTracker({
    sessions: {
      async getRecentlyClosed() {
        return recent.map((e) => structuredClone(e));
      },
    },
  });

  await tracker.syncRecentlyClosed();

  // While s-reddit is STILL in recently closed (user clicked external link for same URL, not Cmd+Shift+T)
  assert.equal(
    await tracker.isRestoredTab({
      tabId: 50,
      url: "https://www.reddit.com/",
      cookieStoreId: "firefox-container-2",
    }),
    false
  );

  // User presses Cmd+Shift+T: Firefox pops s-reddit BEFORE onBeforeRequest fires
  recent.shift();
  // Even before sessions.onChanged triggers syncRecentlyClosed, isRestoredTab live-diffs and matches!
  assert.equal(
    await tracker.isRestoredTab({
      tabId: 51,
      url: "https://www.reddit.com/",
      cookieStoreId: "firefox-container-2",
    }),
    true
  );

  // One-shot consumption: a subsequent brand-new external link to reddit is NOT skipped
  assert.equal(
    await tracker.isRestoredTab({
      tabId: 52,
      url: "https://www.reddit.com/",
      cookieStoreId: "firefox-container-2",
    }),
    false
  );

  // HSTS upgrade on restore: closed http:// tab restored as https:// still matches
  recent.shift();
  await tracker.syncRecentlyClosed();
  assert.equal(
    await tracker.isRestoredTab({
      tabId: 53,
      url: "https://news.example.com/story?id=1",
      cookieStoreId: "firefox-default",
    }),
    true
  );

  // Cmd+Shift+N: closed window pops and ALL of its tabs are recognized as restored
  recent.shift();
  await tracker.syncRecentlyClosed();
  assert.equal(
    await tracker.isRestoredTab({
      tabId: 54,
      url: "https://a.example.com/",
      cookieStoreId: "firefox-container-1",
    }),
    true
  );
  assert.equal(
    await tracker.isRestoredTab({
      tabId: 55,
      url: "https://b.example.com/",
      cookieStoreId: "firefox-default",
    }),
    true
  );

  tracker.destroy();
});

test("sessionRestoreTracker ignores self-forgotten sessions and tail evictions", async () => {
  const recent = [
    {
      tab: {
        windowId: 10,
        sessionId: "s-placeholder",
        url: "https://slack.example.com/1",
        cookieStoreId: "firefox-container-2",
      },
    },
    {
      tab: {
        windowId: 10,
        sessionId: "s-oldest",
        url: "https://oldest.example.com/",
        cookieStoreId: "firefox-default",
      },
    },
  ];

  const tracker = createSessionRestoreTracker({
    sessions: {
      async getRecentlyClosed() {
        return recent.map((e) => structuredClone(e));
      },
    },
  });

  await tracker.syncRecentlyClosed();

  // Our own cleaner forgets s-placeholder -> must NOT be treated as a user restore
  tracker.markSessionForgotten("t:10:s-placeholder");
  recent.shift();
  await tracker.syncRecentlyClosed();

  assert.equal(
    await tracker.isRestoredTab({
      tabId: 60,
      url: "https://slack.example.com/1",
      cookieStoreId: "firefox-container-2",
    }),
    false
  );

  // A new closed tab pushes s-oldest off the tail (list stays same size) -> tail eviction is NOT a restore
  recent.unshift({
    tab: {
      windowId: 10,
      sessionId: "s-newer",
      url: "https://newer.example.com/",
      cookieStoreId: "firefox-default",
    },
  });
  recent.pop();
  await tracker.syncRecentlyClosed();

  assert.equal(
    await tracker.isRestoredTab({
      tabId: 61,
      url: "https://oldest.example.com/",
      cookieStoreId: "firefox-default",
    }),
    false
  );

  tracker.destroy();
});

test("sessionRestoreTracker stamps open/settled tabs via setTabValue and detects cold wake-up restores via getTabValue", async () => {
  const tabValues = new Map();
  const openTabs = [
    { id: 1, url: "https://open.example.com/", incognito: false },
    { id: 2, url: "about:blank", incognito: false },
    { id: 3, url: "https://private.example.com/", incognito: true },
  ];

  const tracker = createSessionRestoreTracker({
    tabs: {
      async query() {
        return openTabs.map((t) => ({ ...t }));
      },
    },
    sessions: {
      async setTabValue(tabId, key, value) {
        tabValues.set(`${tabId}:${key}`, value);
      },
      async getTabValue(tabId, key) {
        return tabValues.get(`${tabId}:${key}`);
      },
    },
  });

  // Skip pending tab 2; incognito tab 3 is skipped automatically
  await tracker.stampOpenTabs((tab) => tab.url === "about:blank");
  assert.equal(tabValues.get(`1:${TAB_SESSION_SEEN_KEY}`), 1);
  assert.equal(tabValues.has(`2:${TAB_SESSION_SEEN_KEY}`), false);
  assert.equal(tabValues.has(`3:${TAB_SESSION_SEEN_KEY}`), false);

  // Cold wake-up (no getRecentlyClosed snapshot yet): restored tab 99 carries ntcp_seen = 1
  tabValues.set(`99:${TAB_SESSION_SEEN_KEY}`, 1);
  assert.equal(
    await tracker.isRestoredTab({
      tabId: 99,
      url: "https://open.example.com/",
      cookieStoreId: "firefox-default",
    }),
    true
  );

  // Brand-new external link tab 100 has no ntcp_seen value
  assert.equal(
    await tracker.isRestoredTab({
      tabId: 100,
      url: "https://external.example.com/",
      cookieStoreId: "firefox-default",
    }),
    false
  );

  tracker.destroy();
});

test("sessionRestoreTracker never blocks on slow getRecentlyClosed when no snapshot matches and bounds live refresh with syncTimeoutMs", async () => {
  let getCalls = 0;
  let hang = false;
  const recent = [
    {
      tab: {
        windowId: 10,
        sessionId: "s-1",
        url: "https://closed.example.com/",
        cookieStoreId: "firefox-default",
      },
    },
  ];

  const tracker = createSessionRestoreTracker(
    {
      sessions: {
        async getRecentlyClosed() {
          getCalls += 1;
          if (hang) {
            return new Promise(() => {});
          }
          return recent.map((e) => structuredClone(e));
        },
      },
    },
    { syncTimeoutMs: 20 }
  );

  // Before any snapshot exists, isRestoredTab does NOT call getRecentlyClosed
  assert.equal(
    await tracker.isRestoredTab({
      tabId: 10,
      url: "https://external.example.com/",
      cookieStoreId: "firefox-default",
    }),
    false
  );
  assert.equal(getCalls, 0);

  // After snapshot, an unrelated URL does NOT call getRecentlyClosed
  await tracker.syncRecentlyClosed();
  assert.equal(getCalls, 1);
  assert.equal(
    await tracker.isRestoredTab({
      tabId: 11,
      url: "https://unrelated.example.com/",
      cookieStoreId: "firefox-default",
    }),
    false
  );
  assert.equal(getCalls, 1);

  // If getRecentlyClosed hangs on a matching URL, syncTimeoutMs bounds the wait cleanly
  hang = true;
  assert.equal(
    await tracker.isRestoredTab({
      tabId: 12,
      url: "https://closed.example.com/",
      cookieStoreId: "firefox-default",
    }),
    false
  );
  assert.equal(getCalls, 2);

  tracker.destroy();
});
