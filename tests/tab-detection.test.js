import test from "node:test";
import assert from "node:assert/strict";
import {
  classifyTabUrl,
  getEffectiveTabUrl,
  shouldIgnoreCreatedTab,
  shouldTriggerForWindow,
} from "../src/lib/tab-detection.js";

test("shouldIgnoreCreatedTab enforces all ignore guards", () => {
  const baseContext = {
    enabled: true,
    ignoredTabIds: new Set([99]),
  };

  const normalNewTab = {
    id: 10,
    windowId: 1,
    cookieStoreId: "firefox-default",
    incognito: false,
    pinned: false,
    openerTabId: undefined,
  };

  assert.equal(shouldIgnoreCreatedTab(normalNewTab, baseContext), false);
  assert.equal(
    shouldIgnoreCreatedTab(normalNewTab, { ...baseContext, enabled: false }),
    true
  );
  assert.equal(
    shouldIgnoreCreatedTab({ ...normalNewTab, incognito: true }, baseContext),
    true
  );
  assert.equal(
    shouldIgnoreCreatedTab({ ...normalNewTab, pinned: true }, baseContext),
    true
  );
  assert.equal(
    shouldIgnoreCreatedTab({ ...normalNewTab, openerTabId: 3 }, baseContext),
    true
  );
  assert.equal(
    shouldIgnoreCreatedTab(
      { ...normalNewTab, cookieStoreId: "firefox-container-1" },
      baseContext
    ),
    true
  );
  assert.equal(
    shouldIgnoreCreatedTab({ ...normalNewTab, id: 99 }, baseContext),
    true
  );
});

test("getEffectiveTabUrl prefers non-empty pendingUrl over about:blank/current url", () => {
  assert.equal(getEffectiveTabUrl({ url: "about:newtab" }), "about:newtab");
  assert.equal(getEffectiveTabUrl({ url: "about:blank" }), "about:blank");
  assert.equal(
    getEffectiveTabUrl({
      url: "about:blank",
      pendingUrl: "https://example.com",
    }),
    "https://example.com"
  );
  assert.equal(
    getEffectiveTabUrl({
      url: "about:newtab",
      pendingUrl: "https://example.com",
    }),
    "https://example.com"
  );
  assert.equal(
    getEffectiveTabUrl({ url: "about:blank", pendingUrl: "about:newtab" }),
    "about:newtab"
  );
  assert.equal(
    getEffectiveTabUrl({ url: "https://example.com", pendingUrl: "" }),
    "https://example.com"
  );
  assert.equal(getEffectiveTabUrl(null), undefined);
});

test("classifyTabUrl classifies about:newtab, pending, and other URLs", () => {
  assert.equal(classifyTabUrl("about:newtab"), "newtab");
  assert.equal(classifyTabUrl("about:blank"), "pending");
  assert.equal(classifyTabUrl(""), "pending");
  assert.equal(classifyTabUrl(undefined), "pending");
  assert.equal(classifyTabUrl(null), "pending");
  assert.equal(classifyTabUrl("https://example.com"), "other");
  assert.equal(classifyTabUrl("about:preferences"), "other");
  assert.equal(classifyTabUrl("about:home"), "other");
});

test("shouldTriggerForWindow requires normal window with >1 tab", () => {
  assert.equal(
    shouldTriggerForWindow({ type: "normal", tabs: [{ id: 1 }, { id: 2 }] }),
    true
  );
  assert.equal(
    shouldTriggerForWindow({ type: "normal", tabs: [{ id: 1 }] }),
    false
  );
  assert.equal(
    shouldTriggerForWindow({ type: "popup", tabs: [{ id: 1 }, { id: 2 }] }),
    false
  );
  assert.equal(shouldTriggerForWindow(null), false);
});
