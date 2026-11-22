import test from "node:test";
import assert from "node:assert/strict";
import {
  PICKER_HTML_PATH,
  getPickerUrlPrefix,
  isOwnPickerUrl,
} from "../src/background/browser-actions.js";

test("getPickerUrlPrefix and isOwnPickerUrl resolve runtime URLs and fall back cleanly", () => {
  assert.equal(getPickerUrlPrefix(undefined), PICKER_HTML_PATH);
  assert.equal(
    getPickerUrlPrefix({ getURL: (p) => `moz-extension://id/${p}` }),
    "moz-extension://id/src/picker/picker.html"
  );

  const runtime = { getURL: (p) => `moz-extension://id/${p}` };
  assert.equal(isOwnPickerUrl(runtime, null), false);
  assert.equal(isOwnPickerUrl(runtime, 123), false);
  assert.equal(
    isOwnPickerUrl(runtime, "moz-extension://id/src/picker/picker.html?mode=tab"),
    true
  );
  assert.equal(isOwnPickerUrl(runtime, "https://example.com"), false);
  assert.equal(isOwnPickerUrl(undefined, "src/picker/picker.html?mode=tab"), true);
});
