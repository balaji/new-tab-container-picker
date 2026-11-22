import test from "node:test";
import assert from "node:assert/strict";
import { computePopupBounds } from "../src/lib/geometry.js";

test("computePopupBounds centers horizontally and calculates integer coordinates", () => {
  const bounds = computePopupBounds(
    { left: 100, top: 80, width: 1200, height: 800 },
    5
  );

  assert.equal(bounds.width, 360);
  assert.equal(bounds.height, 360); // 140 + 5 * 44
  assert.equal(bounds.left, 520); // 100 + (1200 - 360)/2
  assert.equal(bounds.top, 272); // 80 + 800*0.24
  assert.equal(Number.isInteger(bounds.left), true);
  assert.equal(Number.isInteger(bounds.top), true);
});

test("computePopupBounds preserves negative multi-monitor coordinates", () => {
  const bounds = computePopupBounds(
    { left: -1440, top: -100, width: 1440, height: 900 },
    3
  );

  assert.equal(bounds.left, -900);
  assert.ok(bounds.top > -100);
  assert.equal(bounds.width, 360);
});

test("computePopupBounds clamps height for very small and very large container lists", () => {
  const tiny = computePopupBounds(
    { left: 0, top: 0, width: 1000, height: 700 },
    1
  );
  assert.equal(tiny.height, 200);

  const many = computePopupBounds(
    { left: 0, top: 0, width: 1000, height: 700 },
    20
  );
  assert.equal(many.height, 492); // 140 + 8 * 44 = 492 <= 500
});

test("computePopupBounds falls back gracefully when parent geometry is missing", () => {
  const bounds = computePopupBounds(null, 4);
  assert.deepEqual(bounds, { width: 360, height: 316 });
});
