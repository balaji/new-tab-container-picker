export const SAFE_ICON_URL_RE =
  /^resource:\/\/usercontext-content\/[a-z0-9_-]+\.svg$/i;

function createDefaultIconElement(doc) {
  const svgNs = "http://www.w3.org/2000/svg";
  const svg = doc.createElementNS(svgNs, "svg");
  svg.setAttribute("class", "container-icon container-icon--default");
  svg.setAttribute("viewBox", "0 0 16 16");
  svg.setAttribute("fill", "none");
  svg.setAttribute("aria-hidden", "true");

  const rect = doc.createElementNS(svgNs, "rect");
  rect.setAttribute("x", "2.25");
  rect.setAttribute("y", "3");
  rect.setAttribute("width", "11.5");
  rect.setAttribute("height", "10");
  rect.setAttribute("rx", "2");
  rect.setAttribute("stroke", "currentColor");
  rect.setAttribute("stroke-width", "1.4");

  const path = doc.createElementNS(svgNs, "path");
  path.setAttribute("d", "M2.5 6.25H13.5");
  path.setAttribute("stroke", "currentColor");
  path.setAttribute("stroke-width", "1.3");

  svg.append(rect, path);
  return svg;
}

/**
 * Create the visual icon element for a Default or named Firefox container row.
 * @param {Document} doc
 * @param {{ isDefault?: boolean, iconUrl?: string | null }} container
 * @returns {Element}
 */
export function createContainerIconElement(doc, container) {
  if (container.isDefault) {
    return createDefaultIconElement(doc);
  }

  const iconEl = doc.createElement("span");
  iconEl.setAttribute("aria-hidden", "true");

  if (
    typeof container.iconUrl === "string" &&
    SAFE_ICON_URL_RE.test(container.iconUrl)
  ) {
    iconEl.className = "container-icon container-icon--masked";
    iconEl.style.setProperty(
      "--container-icon-url",
      `url("${container.iconUrl}")`
    );
  } else {
    iconEl.className = "container-icon container-icon--dot";
  }

  return iconEl;
}

/**
 * Render container list items, empty state visibility, and active ARIA highlight state.
 * @param {{
 *   doc: Document,
 *   listEl: HTMLElement,
 *   emptyStateEl: HTMLElement,
 *   searchInput: HTMLElement,
 *   onHoverIndex?: (index: number) => void,
 *   onSelectContainer?: (cookieStoreId: string) => void,
 * }} deps
 */
export function createListRenderer({
  doc,
  listEl,
  emptyStateEl,
  searchInput,
  onHoverIndex,
  onSelectContainer,
}) {
  /**
   * Sync aria-selected across rendered options and aria-activedescendant on the search input.
   * @param {number} activeIndex
   * @param {{ scroll?: boolean }} [options]
   */
  function updateActiveHighlight(activeIndex, { scroll = true } = {}) {
    const items = listEl.querySelectorAll(".container-item");
    let activeId = "";

    items.forEach((el, idx) => {
      const isSelected = idx === activeIndex;
      el.setAttribute("aria-selected", isSelected ? "true" : "false");
      if (isSelected) {
        activeId = el.id;
        if (scroll && typeof el.scrollIntoView === "function") {
          el.scrollIntoView({ block: "nearest" });
        }
      }
    });

    if (activeId) {
      searchInput.setAttribute("aria-activedescendant", activeId);
    } else {
      searchInput.removeAttribute("aria-activedescendant");
    }
  }

  /**
   * Render the filtered list of containers and toggle empty state visibility.
   * @param {Array<object>} containers
   * @param {number} activeIndex
   */
  function render(containers, activeIndex) {
    const fragment = doc.createDocumentFragment();

    containers.forEach((container, index) => {
      const li = doc.createElement("li");
      li.id = `container-option-${index}`;
      li.setAttribute("role", "option");
      li.setAttribute("aria-selected", index === activeIndex ? "true" : "false");
      li.dataset.cookieStoreId = container.cookieStoreId;

      if (container.isDefault) {
        li.className = "container-item container-item--default";
      } else {
        li.className = "container-item container-item--colored";
        if (container.colorCode) {
          li.style.setProperty("--container-color", container.colorCode);
        }
      }

      const iconEl = createContainerIconElement(doc, container);
      const nameEl = doc.createElement("span");
      nameEl.className = "container-name";
      nameEl.textContent = container.name;

      li.append(iconEl, nameEl);

      if (container.isDefault) {
        const badgeEl = doc.createElement("span");
        badgeEl.className = "container-badge";
        badgeEl.textContent = "No container";
        li.append(badgeEl);
      }

      li.addEventListener("mouseenter", () => {
        onHoverIndex?.(index);
      });

      li.addEventListener("click", (event) => {
        event.preventDefault();
        onSelectContainer?.(container.cookieStoreId);
      });

      fragment.append(li);
    });

    listEl.replaceChildren(fragment);

    const isEmpty = containers.length === 0;
    listEl.hidden = isEmpty;
    emptyStateEl.hidden = !isEmpty;

    updateActiveHighlight(activeIndex, { scroll: false });
  }

  return {
    render,
    updateActiveHighlight,
  };
}
