/**
 * Pure search and visibility logic for Firefox Native Tab Search.
 *
 * This file has no Firefox dependencies. It is loaded inside the privileged
 * Autoconfig sandbox together with native-tab-search.js, and it is also
 * require()-able from Node for unit tests.
 */
var FirefoxNativeTabSearchCore = (function () {
  'use strict';

  const MAX_QUERY_LENGTH = 200;
  const MAX_TERMS = 12;

  // Fuzzy scoring constants, modelled on fzf's FuzzyMatchV2. They only affect
  // ranking; whether a tab matches at all is decided by the subsequence and
  // word-boundary rules below.
  const SCORE_MATCH = 16;
  const BONUS_BOUNDARY = 10;
  const BONUS_CAMEL = 7;
  const BONUS_CONSECUTIVE = 4;
  const GAP_START = -3;
  const GAP_EXTENSION = -1;

  // A literal substring match always outranks a fuzzy one.
  const LITERAL_BASE = 100;
  const LITERAL_POSITION_PENALTY = 20;

  // Characters that start a new word inside a title or a URL.
  const BOUNDARY_CHARS = ' /-_.:;|,([{\\?&=+#@~';

  /**
   * Converts a Set, an Array or a nullish value into a Set.
   *
   * @param {Set<*>|Array<*>|null|undefined} value - Source collection.
   * @returns {Set<*>} A Set with the same values.
   */
  function toSet(value) {
    if (value instanceof Set) return value;
    if (Array.isArray(value)) return new Set(value);
    return new Set();
  }

  /**
   * Normalizes a search query into lower-case tokens.
   *
   * Whitespace separates tokens and every token must match. The input is
   * capped so a pathological paste cannot slow down filtering.
   *
   * @param {string} query - Raw text from the search field.
   * @returns {string[]} Lower-case search terms.
   */
  function normalizeQuery(query) {
    if (typeof query !== 'string') return [];
    const trimmed = query.slice(0, MAX_QUERY_LENGTH).trim().toLowerCase();
    if (!trimmed) return [];
    return trimmed.split(/\s+/).filter(Boolean).slice(0, MAX_TERMS);
  }

  /**
   * Extracts a hostname from a URL without relying on the URL constructor,
   * which is not guaranteed to exist inside the Autoconfig sandbox.
   *
   * @param {string} url - Tab URL.
   * @returns {string} Lower-case hostname, or an empty string.
   */
  function extractHostname(url) {
    if (typeof url !== 'string' || !url) return '';
    const match = /^[a-z][a-z0-9+.-]*:\/\/([^/?#]+)/i.exec(url);
    if (!match) return '';
    let host = match[1].toLowerCase();
    const at = host.lastIndexOf('@');
    if (at !== -1) host = host.slice(at + 1);
    if (host.startsWith('[')) {
      const close = host.indexOf(']');
      return close === -1 ? host : host.slice(0, close + 1);
    }
    const colon = host.indexOf(':');
    if (colon !== -1) host = host.slice(0, colon);
    return host;
  }

  /**
   * Builds the searchable text for one tab.
   *
   * The original case is preserved because camelCase boundaries ("TabSearch")
   * are only visible before lower-casing. Matching lower-cases the fields.
   *
   * @param {{title?: string, url?: string}} tab - Tab-like object.
   * @returns {{title: string, url: string, hostname: string}} Searchable fields.
   */
  function getTabText(tab) {
    const title = tab && typeof tab.title === 'string' ? tab.title : '';
    const url = tab && typeof tab.url === 'string' ? tab.url : '';
    return { title, url, hostname: extractHostname(url) };
  }

  /**
   * Returns the bonus for a character that starts a new word.
   *
   * A position is a boundary when it is the first character, follows a
   * separator, starts a camelCase hump, or follows a digit.
   *
   * @param {string} lower - Lower-case text being searched.
   * @param {string} raw - Original-case text, used for camelCase detection.
   * @param {number} index - Character position.
   * @returns {number} Boundary bonus, or 0 when the position is mid-word.
   */
  function boundaryBonus(lower, raw, index) {
    if (index <= 0) return BONUS_BOUNDARY;
    const previous = lower[index - 1];
    if (BOUNDARY_CHARS.indexOf(previous) !== -1) return BONUS_BOUNDARY;
    if (raw && raw.length === lower.length) {
      const previousRaw = raw[index - 1];
      const currentRaw = raw[index];
      if (previousRaw >= 'a' && previousRaw <= 'z' && currentRaw >= 'A' && currentRaw <= 'Z') {
        return BONUS_CAMEL;
      }
      if (previousRaw >= '0' && previousRaw <= '9' && !(currentRaw >= '0' && currentRaw <= '9')) {
        return BONUS_CAMEL;
      }
    }
    return 0;
  }

  /**
   * Checks whether a character starts a new word.
   *
   * @param {string} lower - Lower-case text being searched.
   * @param {string} raw - Original-case text.
   * @param {number} index - Character position.
   * @returns {boolean} True when the position is a word boundary.
   */
  function isBoundaryAt(lower, raw, index) {
    return boundaryBonus(lower, raw, index) > 0;
  }

  /**
   * Checks whether a needle fits as a subsequence of a window.
   *
   * @param {string} lower - Lower-case haystack.
   * @param {string} needle - Lower-case needle.
   * @param {number} from - First index of the window (inclusive).
   * @param {number} end - Last index of the window (exclusive).
   * @returns {boolean} True when every needle character can be found in order.
   */
  function fitsWithin(lower, needle, from, end) {
    let cursor = from;
    for (let i = 0; i < needle.length; i++) {
      const character = needle[i];
      while (cursor < end && lower[cursor] !== character) cursor++;
      if (cursor >= end) return false;
      cursor++;
    }
    return true;
  }

  /**
   * Scores a fuzzy (subsequence) match of one term against one field.
   *
   * The first matched character must sit on a word boundary. Without that rule
   * a two-letter query matches almost every URL, because short subsequences
   * occur by chance inside long strings.
   *
   * @param {string} needle - Lower-case search term.
   * @param {string} lower - Lower-case field text.
   * @param {string} raw - Original-case field text, for camelCase detection.
   * @returns {number|null} Score, or null when the term does not match.
   */
  function fuzzyScore(needle, lower, raw) {
    const needleLength = needle.length;
    const textLength = lower.length;
    if (needleLength === 0) return 0;
    if (needleLength > textLength) return null;

    // Forward pass: the earliest position where the whole needle fits.
    let cursor = 0;
    for (let i = 0; i < needleLength; i++) {
      const character = needle[i];
      while (cursor < textLength && lower[cursor] !== character) cursor++;
      if (cursor >= textLength) return null;
      cursor++;
    }
    const end = cursor;

    // The match must start on a word boundary. Try every boundary occurrence
    // of the first character and keep the earliest one that still fits.
    let start = -1;
    for (let position = 0; position < end; position++) {
      if (lower[position] !== needle[0]) continue;
      if (!isBoundaryAt(lower, raw, position)) continue;
      if (fitsWithin(lower, needle, position, end)) {
        start = position;
        break;
      }
    }
    if (start === -1) return null;

    // Greedy left-to-right scoring inside the matched window.
    let score = 0;
    let lastMatch = -2;
    let gapOpen = false;
    let position = start;
    for (let i = 0; i < needleLength; i++) {
      const character = needle[i];
      while (position < end && lower[position] !== character) {
        score += gapOpen ? GAP_EXTENSION : GAP_START;
        gapOpen = true;
        position++;
      }
      if (position >= end) return null;
      let bonus = boundaryBonus(lower, raw, position);
      if (position === lastMatch + 1) bonus = Math.max(bonus, BONUS_CONSECUTIVE);
      if (i === 0) bonus *= 2;
      score += SCORE_MATCH + bonus;
      lastMatch = position;
      gapOpen = false;
      position++;
    }
    return score - start;
  }

  /**
   * Scores one term against every searchable field of a tab.
   *
   * Fields are searched separately: a subsequence must not be assembled from
   * characters of different fields, which would let "gh" match a title
   * containing "g" plus a URL containing "h".
   *
   * @param {string} term - Lower-case search term.
   * @param {Array<{raw: string, lower: string}>} fields - Searchable fields.
   * @param {boolean} fuzzy - Whether fuzzy matching is enabled.
   * @returns {number|null} Best score across fields, or null when nothing matches.
   */
  function bestTermScore(term, fields, fuzzy) {
    let best = null;
    for (const field of fields) {
      const lower = field.lower;
      if (!lower) continue;

      const at = lower.indexOf(term);
      if (at !== -1) {
        const bonus = isBoundaryAt(lower, field.raw, at) ? BONUS_BOUNDARY : 0;
        const score = LITERAL_BASE + bonus - Math.min(at, LITERAL_POSITION_PENALTY);
        if (best === null || score > best) best = score;
        continue;
      }

      if (!fuzzy) continue;
      const score = fuzzyScore(term, lower, field.raw);
      if (score !== null && (best === null || score > best)) best = score;
    }
    return best;
  }

  /**
   * Scores a tab against every search term.
   *
   * @param {{title?: string, url?: string}} tab - Tab-like object.
   * @param {string[]} terms - Normalized search terms.
   * @param {{fuzzy?: boolean}} [options] - Matching options.
   * @returns {number|null} Total score, or null when the tab does not match.
   */
  function scoreTab(tab, terms, options) {
    if (!Array.isArray(terms) || terms.length === 0) return 0;
    const fuzzy = !options || options.fuzzy !== false;
    const text = getTabText(tab);
    const fields = [
      { raw: text.title, lower: text.title.toLowerCase() },
      { raw: text.url, lower: text.url.toLowerCase() },
      { raw: text.hostname, lower: text.hostname.toLowerCase() },
    ];
    let total = 0;
    for (const term of terms) {
      const score = bestTermScore(term, fields, fuzzy);
      if (score === null) return null;
      total += score;
    }
    return total;
  }

  /**
   * Checks whether one tab satisfies every search term.
   *
   * A term matches when it appears literally, or — with fuzzy matching on —
   * when its characters appear in order starting on a word boundary.
   *
   * @param {{title?: string, url?: string}} tab - Tab-like object.
   * @param {string[]} terms - Normalized search terms.
   * @param {{fuzzy?: boolean}} [options] - Matching options.
   * @returns {boolean} True when the tab matches (an empty query matches all).
   */
  function matchesTab(tab, terms, options) {
    if (!Array.isArray(terms) || terms.length === 0) return true;
    return scoreTab(tab, terms, options) !== null;
  }

  /**
   * Returns the IDs of tabs matching a query.
   *
   * @param {Array<{id: *, title?: string, url?: string}>} tabs - Tab-like objects.
   * @param {string} query - Raw query text.
   * @param {{fuzzy?: boolean}} [options] - Matching options.
   * @returns {Set<*>} Matching tab IDs.
   */
  function computeMatchedIds(tabs, query, options) {
    const terms = normalizeQuery(query);
    const matched = new Set();
    for (const tab of Array.isArray(tabs) ? tabs : []) {
      if (matchesTab(tab, terms, options)) matched.add(tab.id);
    }
    return matched;
  }

  /**
   * Ranks matching tabs from best to worst.
   *
   * Ties keep the tab order, so the result is stable across keystrokes.
   *
   * @param {Array<{id: *, title?: string, url?: string}>} tabs - Tab-like objects.
   * @param {string} query - Raw query text.
   * @param {{fuzzy?: boolean}} [options] - Matching options.
   * @returns {Array<{id: *, score: number, title: string}>} Ranked matches.
   */
  function rankTabs(tabs, query, options) {
    const terms = normalizeQuery(query);
    const ranked = [];
    for (const tab of Array.isArray(tabs) ? tabs : []) {
      const score = scoreTab(tab, terms, options);
      if (score === null) continue;
      ranked.push({
        id: tab.id,
        score,
        title: tab && typeof tab.title === 'string' ? tab.title : '',
      });
    }
    ranked.sort((a, b) => b.score - a.score);
    return ranked;
  }

  /**
   * Builds a safe hide/show plan for one window.
   *
   * Rules:
   * - Active and pinned tabs are never hidden.
   * - Only tabs hidden by this session may be shown again.
   * - A non-matching tab that was active during the session stays visible so
   *   the user can switch back without clearing the search.
   * - Tabs created while the filter is active stay visible until it is cleared.
   * - Tabs shown externally during the session stay visible (never re-hidden).
   *
   * @param {Array<{id: *, active?: boolean, pinned?: boolean, hidden?: boolean}>} tabs - Current tabs.
   * @param {Set<*>|Array<*>} matchedIds - Tabs matching the query.
   * @param {Set<*>|Array<*>} [ownedHidden=new Set()] - Tabs hidden by this session.
   * @param {Set<*>|Array<*>} [protectedIds=new Set()] - Non-matching tabs active during the session.
   * @param {Set<*>|Array<*>} [newTabIds=new Set()] - Tabs created during the session.
   * @param {Set<*>|Array<*>} [exemptIds=new Set()] - Tabs shown externally during the session.
   * @returns {{
   *   toHide: Array<*>,
   *   toShow: Array<*>,
   *   blockedActive: number,
   *   blockedPinned: number,
   *   protectedCount: number,
   *   newTabCount: number,
   *   exemptCount: number,
   *   hiddenByOther: number,
   *   matchedCount: number,
   *   visibleMatched: number,
   *   hiddenMatched: number,
   *   keptVisible: number
   * }} Visibility plan and counters.
   */
  function buildVisibilityPlan(
    tabs,
    matchedIds,
    ownedHidden = new Set(),
    protectedIds = new Set(),
    newTabIds = new Set(),
    exemptIds = new Set()
  ) {
    const safeTabs = Array.isArray(tabs) ? tabs : [];
    const matched = toSet(matchedIds);
    const owned = toSet(ownedHidden);
    const protectedTabs = toSet(protectedIds);
    const newTabs = toSet(newTabIds);
    const exempt = toSet(exemptIds);

    const toHide = [];
    const toShow = [];
    let blockedActive = 0;
    let blockedPinned = 0;
    let protectedCount = 0;
    let newTabCount = 0;
    let exemptCount = 0;
    let hiddenByOther = 0;
    let matchedCount = 0;
    let visibleMatched = 0;
    let hiddenMatched = 0;

    for (const tab of safeTabs) {
      if (matched.has(tab.id)) {
        matchedCount++;
        if (tab.hidden) {
          if (owned.has(tab.id)) {
            toShow.push(tab.id);
            hiddenMatched++;
          } else {
            hiddenByOther++;
          }
        } else {
          visibleMatched++;
        }
        continue;
      }

      if (tab.pinned) {
        blockedPinned++;
        if (tab.hidden && owned.has(tab.id)) toShow.push(tab.id);
        continue;
      }
      if (tab.active) {
        blockedActive++;
        if (tab.hidden && owned.has(tab.id)) toShow.push(tab.id);
        continue;
      }
      if (protectedTabs.has(tab.id)) {
        protectedCount++;
        continue;
      }
      if (newTabs.has(tab.id)) {
        newTabCount++;
        continue;
      }
      if (exempt.has(tab.id)) {
        exemptCount++;
        continue;
      }
      if (tab.hidden) {
        hiddenByOther++;
        continue;
      }

      toHide.push(tab.id);
    }

    return {
      toHide,
      toShow,
      blockedActive,
      blockedPinned,
      protectedCount,
      newTabCount,
      exemptCount,
      hiddenByOther,
      matchedCount,
      visibleMatched,
      hiddenMatched,
      keptVisible: blockedActive + blockedPinned + protectedCount + newTabCount + exemptCount,
    };
  }

  /**
   * Decides whether a native tab group should be hidden during a filter.
   *
   * Expanded groups stay visible while at least one tab is visible. Collapsed
   * groups stay visible while they contain a matching or explicitly kept tab.
   * Empty groups are hidden.
   *
   * @param {{collapsed?: boolean, tabs?: Array<{id: *, hidden?: boolean}>}} group - Group descriptor.
   * @param {Set<*>|Array<*>} matchedIds - Tabs matching the query.
   * @param {Set<*>|Array<*>} [keptIds=new Set()] - Tabs that must stay visible (active, new, protected, exempt).
   * @returns {boolean} True when the group header should be hidden.
   */
  function shouldHideGroup(group, matchedIds, keptIds = new Set()) {
    const tabs = group && Array.isArray(group.tabs) ? group.tabs : [];
    if (tabs.length === 0) return true;
    const matched = toSet(matchedIds);
    const kept = toSet(keptIds);
    if (group.collapsed) {
      return !tabs.some(tab => matched.has(tab.id) || kept.has(tab.id));
    }
    return !tabs.some(tab => !tab.hidden);
  }

  /**
   * Formats the one-line counter shown under the search field.
   *
   * @param {Object|null} state - Session state snapshot.
   * @returns {string} Status text, or an empty string when inactive.
   */
  function formatStatus(state) {
    if (!state || typeof state !== 'object') return '';
    const total = Number.isFinite(state.total) ? state.total : 0;
    if (!state.active) {
      return total > 0 ? `Open tabs: ${total}` : '';
    }

    const matched = Number.isFinite(state.matched) ? state.matched : 0;
    let text = matched === 0 ? 'No tabs found' : `Found ${matched} of ${total} tabs`;
    const notes = [];

    if (state.bestTitle) {
      notes.push(`\u21b5 ${state.bestTitle}`);
    }
    if (state.protectedCount > 0) {
      notes.push(`${state.protectedCount} kept for return`);
    }
    if (state.newTabCount > 0) {
      notes.push(`${state.newTabCount} new`);
    }
    const blocked =
      (state.blockedActive || 0) +
      (state.blockedPinned || 0) +
      (state.blockedUnsupported || 0) +
      (state.exemptCount || 0);
    if (blocked > 0) {
      notes.push(`${blocked} can't be hidden`);
    }

    if (notes.length > 0) text += ` \u00b7 ${notes.join(' \u00b7 ')}`;
    return text;
  }

  /**
   * Builds a detailed tooltip for the counter.
   *
   * @param {Object|null} state - Session state snapshot.
   * @returns {string} Tooltip text, or an empty string.
   */
  function formatStatusTitle(state) {
    if (!state || !state.active) return '';
    const parts = [];
    if (state.bestTitle) {
      parts.push(`Enter opens: ${state.bestTitle}`);
    }
    if (state.protectedCount > 0) {
      parts.push(`Kept for return: ${state.protectedCount}`);
    }
    if (state.newTabCount > 0) {
      parts.push(`New tabs kept visible: ${state.newTabCount}`);
    }
    if ((state.blockedActive || 0) + (state.blockedPinned || 0) + (state.blockedUnsupported || 0) + (state.exemptCount || 0) > 0) {
      parts.push(
        `Active tab: ${state.blockedActive || 0}`,
        `Pinned: ${state.blockedPinned || 0}`,
        `Protected by browser: ${state.blockedUnsupported || 0}`
      );
      if (state.exemptCount > 0) {
        parts.push(`Shown externally: ${state.exemptCount}`);
      }
    }
    return parts.join(' \u00b7 ');
  }

  return {
    normalizeQuery,
    extractHostname,
    getTabText,
    isBoundaryAt,
    fuzzyScore,
    scoreTab,
    matchesTab,
    computeMatchedIds,
    rankTabs,
    buildVisibilityPlan,
    shouldHideGroup,
    formatStatus,
    formatStatusTitle,
  };
})();

// Node's CommonJS loader. In Firefox this block is inert.
if (typeof module === 'object' && module.exports) {
  module.exports = FirefoxNativeTabSearchCore;
}
