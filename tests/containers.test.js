import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_COOKIE_STORE_ID,
  getAvailableContainers,
  sanitizeColorCode,
} from "../src/lib/containers.js";

test("sanitizeColorCode keeps valid hex colors and falls back to Firefox palette", () => {
  assert.equal(sanitizeColorCode("#37adff", "blue"), "#37adff");
  assert.equal(sanitizeColorCode("  #FF9F00 ", "orange"), "#FF9F00");
  assert.equal(sanitizeColorCode("javascript:alert(1)", "orange"), "#ff9f00");
  assert.equal(sanitizeColorCode("red;background:url(x)", "purple"), "#af51f5");
  assert.equal(sanitizeColorCode(null, "unknown"), null);
});

test("getAvailableContainers returns disabled when API is missing or throws", async () => {
  assert.deepEqual(await getAvailableContainers(undefined), {
    enabled: false,
    containers: [],
  });

  const rejectingApi = {
    async query() {
      throw new Error("Contextual identities are disabled");
    },
  };
  assert.deepEqual(await getAvailableContainers(rejectingApi), {
    enabled: false,
    containers: [],
  });
});

test("getAvailableContainers handles legacy false return and empty identity list", async () => {
  const legacyFalseApi = {
    async query() {
      return false;
    },
  };
  assert.deepEqual(await getAvailableContainers(legacyFalseApi), {
    enabled: false,
    containers: [],
  });

  const emptyApi = {
    async query() {
      return [];
    },
  };
  assert.deepEqual(await getAvailableContainers(emptyApi), {
    enabled: false,
    containers: [],
  });
});

test("getAvailableContainers appends transparent Default after Firefox containers", async () => {
  const api = {
    async query(filter) {
      assert.deepEqual(filter, {});
      return [
        {
          cookieStoreId: "firefox-container-1",
          name: "Personal",
          color: "blue",
          colorCode: "#37adff",
          icon: "fingerprint",
          iconUrl: "resource://usercontext-content/fingerprint.svg",
        },
        {
          cookieStoreId: "firefox-container-2",
          name: "Work",
          color: "orange",
          colorCode: "#ff9f00",
          icon: "briefcase",
          iconUrl: "resource://usercontext-content/briefcase.svg",
        },
      ];
    },
  };

  const result = await getAvailableContainers(api);
  assert.equal(result.enabled, true);
  assert.equal(result.containers.length, 3);

  assert.deepEqual(result.containers[0], {
    cookieStoreId: "firefox-container-1",
    name: "Personal",
    color: "blue",
    colorCode: "#37adff",
    icon: "fingerprint",
    iconUrl: "resource://usercontext-content/fingerprint.svg",
    isDefault: false,
  });

  assert.equal(result.containers[1].name, "Work");
  assert.equal(result.containers[1].colorCode, "#ff9f00");

  assert.deepEqual(result.containers[2], {
    cookieStoreId: DEFAULT_COOKIE_STORE_ID,
    name: "Default",
    color: "transparent",
    colorCode: null,
    icon: null,
    iconUrl: null,
    isDefault: true,
  });
});
