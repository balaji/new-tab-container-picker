const POPUP_WIDTH = 360;
const ROW_HEIGHT = 44;
const CHROME_OVERHEAD = 140;
const MIN_HEIGHT = 200;
const MAX_HEIGHT = 500;
const MAX_VISIBLE_ROWS = 8;

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

/**
 * Compute centered floating popup bounds over the parent Firefox window.
 * Preserves negative multi-monitor coordinates and returns integer pixel values.
 * @param {{ left?: number, top?: number, width?: number, height?: number } | null | undefined} parentWindow
 * @param {number} containerCount
 * @returns {{ width: number, height: number, left?: number, top?: number }}
 */
export function computePopupBounds(parentWindow, containerCount) {
  const visibleRows = Math.min(Math.max(containerCount || 0, 1), MAX_VISIBLE_ROWS);
  const height = clamp(
    CHROME_OVERHEAD + visibleRows * ROW_HEIGHT,
    MIN_HEIGHT,
    MAX_HEIGHT
  );

  const hasWindowGeometry =
    parentWindow &&
    Number.isFinite(parentWindow.left) &&
    Number.isFinite(parentWindow.top) &&
    Number.isFinite(parentWindow.width) &&
    Number.isFinite(parentWindow.height);

  if (!hasWindowGeometry) {
    return {
      width: POPUP_WIDTH,
      height,
    };
  }

  const left = Math.round(parentWindow.left + (parentWindow.width - POPUP_WIDTH) / 2);
  const offsetFromTop = Math.max(
    48,
    Math.min(parentWindow.height * 0.24, parentWindow.height - height - 24)
  );
  const top = Math.round(parentWindow.top + offsetFromTop);

  return {
    width: POPUP_WIDTH,
    height,
    left,
    top,
  };
}
