export const DEFAULT_ANNOUNCE_DELAY_MS = 180;

/**
 * Manage debounced and immediate ARIA live-region announcements.
 * @param {HTMLElement | null | undefined} announcerEl
 * @param {{ delayMs?: number }} [options]
 */
export function createStatusAnnouncer(
  announcerEl,
  { delayMs = DEFAULT_ANNOUNCE_DELAY_MS } = {}
) {
  let timerId = null;

  /**
   * Cancel any pending scheduled announcement.
   */
  function clear() {
    if (timerId !== null) {
      clearTimeout(timerId);
      timerId = null;
    }
  }

  /**
   * Immediately update the live region text after canceling pending announcements.
   * @param {string} text
   */
  function announceImmediate(text) {
    clear();
    if (announcerEl) {
      announcerEl.textContent = text;
    }
  }

  /**
   * Debounce announcement of filtered container match counts.
   * @param {number} count
   * @param {boolean} hasQuery
   */
  function announceFilterCount(count, hasQuery) {
    if (!announcerEl) {
      return;
    }
    clear();
    timerId = setTimeout(() => {
      timerId = null;
      if (!hasQuery && count > 0) {
        announcerEl.textContent = "";
        return;
      }
      if (count === 0) {
        announcerEl.textContent = "No matching containers";
      } else if (count === 1) {
        announcerEl.textContent = "1 matching container";
      } else {
        announcerEl.textContent = `${count} matching containers`;
      }
    }, delayMs);
  }

  return {
    announceFilterCount,
    announceImmediate,
    clear,
  };
}
