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
