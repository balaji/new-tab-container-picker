/**
 * Create a keydown handler for listbox navigation, confirmation, escape cancel, and focus management.
 * @param {{
 *   doc: Document,
 *   searchInput: HTMLInputElement,
 *   settingsBtn?: HTMLElement | null,
 *   focusSearchInput: () => void,
 *   getItemCount: () => number,
 *   onMove?: (delta: number) => void,
 *   onJump?: (edge: "start" | "end") => void,
 *   onConfirm?: () => void,
 *   onCancel?: () => void,
 * }} deps
 * @returns {(event: KeyboardEvent) => void}
 */
export function createKeyboardHandler({
  doc,
  searchInput,
  settingsBtn,
  focusSearchInput,
  getItemCount,
  onMove,
  onJump,
  onConfirm,
  onCancel,
}) {
  return function handleKeyDown(event) {
    if (event.key === "Escape") {
      event.preventDefault();
      onCancel?.();
      return;
    }

    const isSettingsFocused = Boolean(
      settingsBtn && doc.activeElement === settingsBtn
    );
    if (isSettingsFocused && (event.key === "Enter" || event.key === " ")) {
      return;
    }

    if (
      event.key === "ArrowDown" ||
      (event.ctrlKey && event.key.toLowerCase() === "n")
    ) {
      event.preventDefault();
      if (isSettingsFocused) {
        focusSearchInput();
      }
      onMove?.(1);
      return;
    }

    if (
      event.key === "ArrowUp" ||
      (event.ctrlKey && event.key.toLowerCase() === "p")
    ) {
      event.preventDefault();
      if (isSettingsFocused) {
        focusSearchInput();
      }
      onMove?.(-1);
      return;
    }

    if (
      (event.key === "Home" || event.key === "End") &&
      getItemCount() > 0 &&
      (doc.activeElement !== searchInput || searchInput.value === "")
    ) {
      event.preventDefault();
      onJump?.(event.key === "Home" ? "start" : "end");
      return;
    }

    if (event.key === "Enter") {
      event.preventDefault();
      onConfirm?.();
      return;
    }

    if (
      event.key.length === 1 &&
      !event.ctrlKey &&
      !event.metaKey &&
      !event.altKey &&
      doc.activeElement !== searchInput
    ) {
      focusSearchInput();
    }
  };
}
