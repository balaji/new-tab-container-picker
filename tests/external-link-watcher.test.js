import test from "node:test";
import assert from "node:assert/strict";
import { createExternalLinkWatcher } from "../src/background/external-link-watcher.js";

function createMockExternalBrowser(tabsById = new Map()) {
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

test("externalLinkWatcher tracks eligible newly created tabs and intercepts first HTTP(S) GET main_frame request", async () => {
  const detected = [];
  const watcher = createExternalLinkWatcher(createMockExternalBrowser(), {
    isEnabled: () => true,
    onExternalLinkDetected: async (details) => {
      detected.push(details);
      return true;
    },
  });

  // Ineligible tabs are never tracked
  watcher.trackCreatedTab({ id: 1, url: "about:newtab" });
  watcher.trackCreatedTab({ id: 2, url: "about:blank", openerTabId: 99 });
  watcher.trackCreatedTab({ id: 3, url: "about:blank", incognito: true });
  watcher.trackCreatedTab({ id: 4, url: "about:blank", pinned: true });
  watcher.trackCreatedTab({
    id: 6,
    url: "moz-extension://test/src/picker/picker.html?mode=tab",
  });
  watcher.trackCreatedTab({ id: 7, url: "about:preferences" });

  for (const id of [1, 2, 3, 4, 6, 7]) {
    assert.equal(watcher.hasCandidateTab(id), false);
  }

  // External link inheriting an active container tab IS tracked and intercepted
  watcher.trackCreatedTab({
    id: 5,
    url: "about:blank",
    cookieStoreId: "firefox-container-2",
  });
  assert.equal(watcher.hasCandidateTab(5), true);
  assert.deepEqual(
    await watcher.handleBeforeRequest({
      tabId: 5,
      type: "main_frame",
      frameId: 0,
      method: "GET",
      url: "https://github.com/org/repo/pull/2994",
      cookieStoreId: "firefox-container-2",
    }),
    { cancel: true }
  );
  assert.deepEqual(detected, [
    { tabId: 5, url: "https://github.com/org/repo/pull/2994" },
  ]);

  // One-shot allowNextNavigation permits picker-created container tab (even with #hash) once
  watcher.allowNextNavigation(
    "https://github.com/org/repo/pull/2994#discussion",
    "firefox-container-2"
  );
  watcher.trackCreatedTab({
    id: 8,
    url: "about:blank",
    cookieStoreId: "firefox-container-2",
  });
  assert.deepEqual(
    await watcher.handleBeforeRequest({
      tabId: 8,
      type: "main_frame",
      frameId: 0,
      method: "GET",
      url: "https://github.com/org/repo/pull/2994",
      cookieStoreId: "firefox-container-2",
    }),
    {}
  );
  assert.equal(detected.length, 1);

  // Eligible external-link tab starts as about:blank
  watcher.trackCreatedTab({
    id: 20,
    url: "about:blank",
    cookieStoreId: "firefox-default",
  });
  assert.equal(watcher.hasCandidateTab(20), true);

  // Page-initiated request (with originUrl) is ignored and preserves non-interception
  assert.deepEqual(
    await watcher.handleBeforeRequest({
      tabId: 20,
      type: "main_frame",
      frameId: 0,
      method: "GET",
      url: "https://example.com/from-page",
      originUrl: "https://referrer.example.com/",
      cookieStoreId: "firefox-default",
    }),
    {}
  );
  assert.equal(watcher.hasCandidateTab(20), true);

  // Actual external-app request (no originUrl) is intercepted and cancelled
  assert.deepEqual(
    await watcher.handleBeforeRequest({
      tabId: 20,
      type: "main_frame",
      frameId: 0,
      method: "GET",
      url: "https://example.com/external?token=123",
      cookieStoreId: "firefox-default",
    }),
    { cancel: true }
  );
  assert.equal(watcher.hasCandidateTab(20), false);
  assert.deepEqual(detected, [
    { tabId: 5, url: "https://github.com/org/repo/pull/2994" },
    { tabId: 20, url: "https://example.com/external?token=123" },
  ]);

  // Subsequent request on same tab is no longer a candidate
  assert.deepEqual(
    await watcher.handleBeforeRequest({
      tabId: 20,
      type: "main_frame",
      frameId: 0,
      method: "GET",
      url: "https://example.com/second",
      cookieStoreId: "firefox-default",
    }),
    {}
  );
  assert.equal(detected.length, 2);

  watcher.destroy();
});

test("externalLinkWatcher drops candidates on about:newtab, removal, TTL expiry, and ignores non-GET/subframe/non-HTTP/container requests", async () => {
  const detected = [];
  const ignored = new Set([40]);
  const watcher = createExternalLinkWatcher(createMockExternalBrowser(), {
    isEnabled: () => true,
    isTabIgnored: (id) => ignored.has(id),
    candidateTtlMs: 30,
    onExternalLinkDetected: async (details) => {
      detected.push(details);
      return true;
    },
  });

  // Transitioning to about:newtab clears candidate so typing a URL later is not intercepted
  watcher.trackCreatedTab({ id: 30, url: "about:blank" });
  assert.equal(watcher.hasCandidateTab(30), true);
  watcher.handleTabUpdated(30, { url: "about:newtab" }, { id: 30, url: "about:newtab" });
  assert.equal(watcher.hasCandidateTab(30), false);

  // Closing clears candidate
  watcher.trackCreatedTab({ id: 31, url: "about:blank" });
  watcher.handleTabRemoved(31);
  assert.equal(watcher.hasCandidateTab(31), false);

  // TTL expires candidate (e.g., Customize Toolbar tab that stays about:blank)
  watcher.trackCreatedTab({ id: 32, url: "about:blank", title: "Customize Firefox" });
  assert.equal(watcher.hasCandidateTab(32), true);
  await new Promise((r) => setTimeout(r, 45));
  assert.equal(watcher.hasCandidateTab(32), false);

  // Ignored tab is skipped
  watcher.trackCreatedTab({ id: 40, url: "about:blank" });
  assert.equal(watcher.hasCandidateTab(40), false);

  // Non-GET, subframe, incognito, and non-HTTP requests are ignored
  watcher.trackCreatedTab({ id: 41, url: "about:blank" });
  assert.deepEqual(
    await watcher.handleBeforeRequest({
      tabId: 41,
      type: "sub_frame",
      frameId: 1,
      method: "GET",
      url: "https://example.com",
    }),
    {}
  );
  assert.deepEqual(
    await watcher.handleBeforeRequest({
      tabId: 41,
      type: "main_frame",
      frameId: 0,
      method: "POST",
      url: "https://example.com",
    }),
    {}
  );
  assert.deepEqual(
    await watcher.handleBeforeRequest({
      tabId: 41,
      type: "main_frame",
      frameId: 0,
      method: "GET",
      incognito: true,
      url: "https://example.com",
    }),
    {}
  );
  assert.deepEqual(
    await watcher.handleBeforeRequest({
      tabId: 41,
      type: "main_frame",
      frameId: 0,
      method: "GET",
      url: "about:config",
    }),
    {}
  );
  assert.equal(detected.length, 0);

  watcher.destroy();
});

test("externalLinkWatcher cold fallback inspects tabs.get when waking up mid-navigation", async () => {
  const tabsById = new Map([
    [
      50,
      {
        id: 50,
        windowId: 10,
        url: "about:blank",
        cookieStoreId: "firefox-default",
        incognito: false,
        pinned: false,
      },
    ],
    [
      51,
      {
        id: 51,
        windowId: 10,
        url: "https://existing-site.example.com",
        cookieStoreId: "firefox-default",
        incognito: false,
        pinned: false,
      },
    ],
  ]);

  const detected = [];
  const watcher = createExternalLinkWatcher(createMockExternalBrowser(tabsById), {
    isEnabled: () => true,
    onExternalLinkDetected: async (details) => {
      detected.push(details);
      return true;
    },
  });

  // Brand-new blank tab on cold wake-up is intercepted
  assert.deepEqual(
    await watcher.handleBeforeRequest(
      {
        tabId: 50,
        type: "main_frame",
        frameId: 0,
        method: "GET",
        url: "https://slack.example.com/link",
        cookieStoreId: "firefox-default",
      },
      { allowColdFallback: true }
    ),
    { cancel: true }
  );

  // Existing tab already on a real URL is NOT intercepted
  assert.deepEqual(
    await watcher.handleBeforeRequest(
      {
        tabId: 51,
        type: "main_frame",
        frameId: 0,
        method: "GET",
        url: "https://typed.example.com/",
        cookieStoreId: "firefox-default",
      },
      { allowColdFallback: true }
    ),
    {}
  );

  assert.deepEqual(detected, [
    { tabId: 50, url: "https://slack.example.com/link" },
  ]);

  watcher.destroy();
});

test("externalLinkWatcher handles warm onBeforeRequest-before-tabs.onCreated race without hijacking reloads or settled tabs", async () => {
  const tabsById = new Map([
    [
      60,
      {
        id: 60,
        windowId: 10,
        url: "about:blank",
        cookieStoreId: "firefox-default",
        incognito: false,
        pinned: false,
      },
    ],
    [
      61,
      {
        id: 61,
        windowId: 10,
        url: "https://reload-me.example.com/",
        cookieStoreId: "firefox-default",
        incognito: false,
        pinned: false,
      },
    ],
    [
      62,
      {
        id: 62,
        windowId: 10,
        url: "about:blank",
        cookieStoreId: "firefox-default",
        incognito: false,
        pinned: false,
      },
    ],
  ]);

  const detected = [];
  const logs = [];
  const watcher = createExternalLinkWatcher(createMockExternalBrowser(tabsById), {
    isEnabled: () => true,
    debugLog: (event, data) => logs.push({ event, data }),
    onExternalLinkDetected: async (details) => {
      detected.push(details);
      return true;
    },
  });

  // Warm race: onBeforeRequest arrives BEFORE tabs.onCreated for a brand-new about:blank tab
  assert.deepEqual(
    await watcher.handleBeforeRequest({
      tabId: 60,
      type: "main_frame",
      frameId: 0,
      method: "GET",
      url: "https://linear.app/issue/123",
      cookieStoreId: "firefox-default",
    }),
    { cancel: true }
  );
  assert.ok(
    logs.some(
      (entry) =>
        entry.event === "request:match" &&
        entry.data?.tabId === 60 &&
        entry.data?.source === "warm-fallback"
    )
  );

  // Late tabs.onCreated arriving after warm-fallback must not re-arm the tab
  watcher.trackCreatedTab({ id: 60, url: "about:blank" });
  assert.equal(watcher.hasCandidateTab(60), false);

  // Warm Cmd+R reload on an existing tab (tab.url === targetUrl) is NOT intercepted
  assert.deepEqual(
    await watcher.handleBeforeRequest({
      tabId: 61,
      type: "main_frame",
      frameId: 0,
      method: "GET",
      url: "https://reload-me.example.com/",
      cookieStoreId: "firefox-default",
    }),
    {}
  );

  // Tab that already settled on about:newtab must NOT trigger warm fallback later
  watcher.trackCreatedTab({ id: 62, url: "about:blank" });
  watcher.handleTabUpdated(62, { url: "about:newtab" }, { id: 62, url: "about:newtab" });
  assert.deepEqual(
    await watcher.handleBeforeRequest({
      tabId: 62,
      type: "main_frame",
      frameId: 0,
      method: "GET",
      url: "https://typed-after-newtab.example.com/",
      cookieStoreId: "firefox-default",
    }),
    {}
  );

  assert.deepEqual(detected, [
    { tabId: 60, url: "https://linear.app/issue/123" },
  ]);

  watcher.destroy();
});

test("externalLinkWatcher consumes one-shot allowance when our own picker request carries originUrl so repeated clicks still show picker", async () => {
  const detected = [];
  const watcher = createExternalLinkWatcher(createMockExternalBrowser(), {
    isEnabled: () => true,
    onExternalLinkDetected: async (details) => {
      detected.push(details);
      return true;
    },
  });

  const url = "https://example.com/same-link";

  // Picker registers a one-shot allowance, then Firefox delivers originUrl from our extension
  watcher.allowNextNavigation(url, "firefox-default");
  assert.deepEqual(
    await watcher.handleBeforeRequest({
      tabId: 70,
      type: "main_frame",
      frameId: 0,
      method: "GET",
      url,
      originUrl: "moz-extension://test/src/picker/picker.html?mode=tab",
      cookieStoreId: "firefox-default",
    }),
    {}
  );

  // Clicking the exact same external link again immediately MUST still trigger the picker
  watcher.trackCreatedTab({
    id: 71,
    url: "about:blank",
    cookieStoreId: "firefox-default",
  });
  assert.deepEqual(
    await watcher.handleBeforeRequest({
      tabId: 71,
      type: "main_frame",
      frameId: 0,
      method: "GET",
      url,
      cookieStoreId: "firefox-default",
    }),
    { cancel: true }
  );
  assert.deepEqual(detected, [{ tabId: 71, url }]);

  watcher.destroy();
});

test("externalLinkWatcher cold fallback never hijacks reloads, session restore, or discarded-tab activation of existing tabs", async () => {
  const existingUrl = "https://mail.example.com/inbox";
  const tabsById = new Map([
    [
      70,
      {
        id: 70,
        windowId: 10,
        url: existingUrl,
        cookieStoreId: "firefox-default",
        incognito: false,
        pinned: false,
      },
    ],
  ]);

  const detected = [];
  const watcher = createExternalLinkWatcher(createMockExternalBrowser(tabsById), {
    isEnabled: () => true,
    coldCreateGraceMs: 20,
    onExternalLinkDetected: async (details) => {
      detected.push(details);
      return true;
    },
  });

  const reloadRequest = {
    tabId: 70,
    type: "main_frame",
    frameId: 0,
    method: "GET",
    url: existingUrl,
    cookieStoreId: "firefox-default",
  };

  // Cold wake-up + existing tab reloading its own URL (no tabs.onCreated) is NOT intercepted
  assert.deepEqual(
    await watcher.handleBeforeRequest(reloadRequest, { allowColdFallback: true }),
    {}
  );
  // ...and the tab is settled so later reloads skip tabs.get entirely
  assert.deepEqual(
    await watcher.handleBeforeRequest(reloadRequest, { allowColdFallback: true }),
    {}
  );
  assert.deepEqual(detected, []);

  watcher.destroy();
});

test("externalLinkWatcher cold fallback intercepts a new tab already showing the target URL once tabs.onCreated confirms it", async () => {
  const targetUrl = "https://slack.example.com/archives/C1/p2";
  const tabsById = new Map([
    [
      71,
      {
        id: 71,
        windowId: 10,
        url: targetUrl,
        cookieStoreId: "firefox-default",
        incognito: false,
        pinned: false,
      },
    ],
  ]);

  const detected = [];
  const watcher = createExternalLinkWatcher(createMockExternalBrowser(tabsById), {
    isEnabled: () => true,
    coldCreateGraceMs: 200,
    onExternalLinkDetected: async (details) => {
      detected.push(details);
      return true;
    },
  });

  const pending = watcher.handleBeforeRequest(
    {
      tabId: 71,
      type: "main_frame",
      frameId: 0,
      method: "GET",
      url: targetUrl,
      cookieStoreId: "firefox-default",
    },
    { allowColdFallback: true }
  );

  // tabs.onCreated is dispatched shortly after onBeforeRequest on the same wake-up
  setTimeout(() => {
    watcher.trackCreatedTab({
      id: 71,
      windowId: 10,
      url: targetUrl,
      cookieStoreId: "firefox-default",
    });
  }, 5);

  assert.deepEqual(await pending, { cancel: true });
  assert.deepEqual(detected, [{ tabId: 71, url: targetUrl }]);
  assert.equal(watcher.hasCandidateTab(71), false);

  watcher.destroy();
});
