export const DEFAULT_COOKIE_STORE_ID = "firefox-default";

export const FIREFOX_COLOR_FALLBACKS = Object.freeze({
  blue: "#37adff",
  turquoise: "#00c79a",
  green: "#51cd00",
  yellow: "#ffcb00",
  orange: "#ff9f00",
  red: "#ff613d",
  pink: "#ff4bda",
  purple: "#af51f5",
  toolbar: "#8f8f9d",
});

const HEX_COLOR_RE = /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;

/**
 * Validate a container's hex color code, falling back to Firefox's named palette.
 * @param {unknown} colorCode
 * @param {unknown} colorName
 * @returns {string | null}
 */
export function sanitizeColorCode(colorCode, colorName) {
  if (typeof colorCode === "string") {
    const trimmed = colorCode.trim();
    if (HEX_COLOR_RE.test(trimmed)) {
      return trimmed;
    }
  }

  if (typeof colorName === "string") {
    const fallback = FIREFOX_COLOR_FALLBACKS[colorName.trim().toLowerCase()];
    if (fallback) {
      return fallback;
    }
  }

  return null;
}

/**
 * Query Firefox contextualIdentities safely and append the transparent Default container after Firefox containers.
 * Returns { enabled: false, containers: [] } when containers are unavailable, disabled, or empty.
 * @param {{ query?: (details: object) => Promise<unknown> } | undefined} api
 * @returns {Promise<{ enabled: boolean, containers: Array<object> }>}
 */
export async function getAvailableContainers(api) {
  if (!api || typeof api.query !== "function") {
    return { enabled: false, containers: [] };
  }

  let identities;
  try {
    identities = await api.query({});
  } catch {
    return { enabled: false, containers: [] };
  }

  if (!Array.isArray(identities) || identities.length === 0) {
    return { enabled: false, containers: [] };
  }

  const defaultContainer = {
    cookieStoreId: DEFAULT_COOKIE_STORE_ID,
    name: "Default",
    color: "transparent",
    colorCode: null,
    icon: null,
    iconUrl: null,
    isDefault: true,
  };

  const mapped = identities.map((identity) => ({
    cookieStoreId: String(identity.cookieStoreId ?? ""),
    name: String(identity.name ?? ""),
    color: typeof identity.color === "string" ? identity.color : "toolbar",
    colorCode: sanitizeColorCode(identity.colorCode, identity.color),
    icon: typeof identity.icon === "string" ? identity.icon : null,
    iconUrl: typeof identity.iconUrl === "string" ? identity.iconUrl : null,
    isDefault: false,
  }));

  return {
    enabled: true,
    containers: [...mapped, defaultContainer],
  };
}
