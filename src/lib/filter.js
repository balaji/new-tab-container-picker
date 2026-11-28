/**
 * Compute subsequence match span if all characters of query appear in target in order.
 * @param {string} targetLower
 * @param {string} queryLower
 * @returns {{ span: number, firstIdx: number } | null}
 */
function matchSubsequence(targetLower, queryLower) {
  let qi = 0;
  let firstIdx = -1;
  let lastIdx = -1;

  for (let ti = 0; ti < targetLower.length && qi < queryLower.length; ti += 1) {
    if (targetLower[ti] === queryLower[qi]) {
      if (firstIdx === -1) {
        firstIdx = ti;
      }
      lastIdx = ti;
      qi += 1;
    }
  }

  if (qi !== queryLower.length) {
    return null;
  }

  return {
    span: lastIdx - firstIdx,
    firstIdx,
  };
}

/**
 * Filter and rank containers by exact, prefix, substring, then fuzzy subsequence match.
 * @param {Array<{ name?: string }>} containers
 * @param {string} query
 * @returns {Array<object>}
 */
export function filterContainers(containers, query) {
  if (!Array.isArray(containers)) {
    return [];
  }

  const normalizedQuery = typeof query === "string" ? query.trim().toLowerCase() : "";
  if (!normalizedQuery) {
    return containers.slice();
  }

  const scored = [];

  for (let index = 0; index < containers.length; index += 1) {
    const item = containers[index];
    const nameLower = String(item?.name ?? "").toLowerCase();

    if (nameLower === normalizedQuery) {
      scored.push({ item, rank: 0, tie1: 0, tie2: 0, index });
      continue;
    }

    if (nameLower.startsWith(normalizedQuery)) {
      scored.push({ item, rank: 1, tie1: 0, tie2: 0, index });
      continue;
    }

    const subIndex = nameLower.indexOf(normalizedQuery);
    if (subIndex !== -1) {
      scored.push({ item, rank: 2, tie1: subIndex, tie2: 0, index });
      continue;
    }

    const fuzzy = matchSubsequence(nameLower, normalizedQuery);
    if (fuzzy) {
      scored.push({
        item,
        rank: 3,
        tie1: fuzzy.span,
        tie2: fuzzy.firstIdx,
        index,
      });
    }
  }

  scored.sort(
    (a, b) =>
      a.rank - b.rank ||
      a.tie1 - b.tie1 ||
      a.tie2 - b.tie2 ||
      a.index - b.index
  );

  return scored.map((entry) => entry.item);
}

const ELIGIBLE_SHORTCUT_CHAR_RE = /^[\p{L}\p{N}]$/u;
const COMBINING_MARK_START_RE = /^\p{M}/u;

/**
 * Compute the first unique single-character search shortcut (letter or digit)
 * for each container. Typing that character alone matches only that container.
 * @param {Array<{ cookieStoreId?: string, name?: string }>} containers
 * @returns {Map<string, string>}
 */
export function computeUniqueShortcutChars(containers) {
  const result = new Map();
  if (!Array.isArray(containers) || containers.length === 0) {
    return result;
  }

  const containerCounts = new Map();
  for (const item of containers) {
    const nameLower = String(item?.name ?? "").toLowerCase();
    const seen = new Set();
    for (const ch of nameLower) {
      seen.add(ch);
    }
    for (const ch of seen) {
      containerCounts.set(ch, (containerCounts.get(ch) ?? 0) + 1);
    }
  }

  for (const item of containers) {
    const key = item?.cookieStoreId;
    if (typeof key !== "string" || key.length === 0) {
      continue;
    }
    const name = String(item?.name ?? "");
    let offset = 0;
    for (const ch of name) {
      const len = ch.length;
      if (
        ELIGIBLE_SHORTCUT_CHAR_RE.test(ch) &&
        !COMBINING_MARK_START_RE.test(name.slice(offset + len))
      ) {
        const lower = ch.toLowerCase();
        if (lower.length === 1 && containerCounts.get(lower) === 1) {
          result.set(key, lower);
          break;
        }
      }
      offset += len;
    }
  }

  return result;
}

/**
 * Move selection index by delta with wrap-around across [0, length - 1].
 * @param {number} currentIndex
 * @param {number} delta
 * @param {number} length
 * @returns {number}
 */
export function getNextIndex(currentIndex, delta, length) {
  if (length <= 0) {
    return -1;
  }
  const base = currentIndex < 0 ? 0 : currentIndex;
  return (((base + delta) % length) + length) % length;
}
