import test from "node:test";
import assert from "node:assert/strict";
import {
  PICKER_HTML_PATH,
  buildPickerTabUrl,
  getPickerUrlPrefix,
  isOwnPickerUrl,
} from "../src/background/browser-actions.js";

test("getPickerUrlPrefix, buildPickerTabUrl, and isOwnPickerUrl resolve runtime URLs and target URLs", () => {
  assert.equal(getPickerUrlPrefix(undefined), PICKER_HTML_PATH);
  assert.equal(
    getPickerUrlPrefix({ getURL: (p) => `moz-extension://id/${p}` }),
    "moz-extension://id/src/picker/picker.html"
  );

  const runtime = { getURL: (p) => `moz-extension://id/${p}` };
  assert.equal(
    buildPickerTabUrl(runtime),
    "moz-extension://id/src/picker/picker.html?mode=tab"
  );
  const withTarget = buildPickerTabUrl(
    runtime,
    "https://example.com/a?x=1&y=2"
  );
  assert.equal(
    withTarget,
    "moz-extension://id/src/picker/picker.html?mode=tab&url=https%3A%2F%2Fexample.com%2Fa%3Fx%3D1%26y%3D2"
  );
  assert.equal(isOwnPickerUrl(runtime, withTarget), true);
  assert.equal(isOwnPickerUrl(runtime, null), false);
  assert.equal(isOwnPickerUrl(runtime, 123), false);
  assert.equal(
    isOwnPickerUrl(runtime, "moz-extension://id/src/picker/picker.html?mode=tab"),
    true
  );
  assert.equal(isOwnPickerUrl(runtime, "https://example.com"), false);
  assert.equal(isOwnPickerUrl(undefined, "src/picker/picker.html?mode=tab"), true);
});
