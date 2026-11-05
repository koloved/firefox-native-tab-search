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
   * @param {{title?: string, url?: string}} tab - Tab-like object.
   * @returns {{title: string, url: string, hostname: string}} Lower-case fields.
   */
  function getTabText(tab) {
    const title = tab && typeof tab.title === 'string' ? tab.title.toLowerCase() : '';
    const url = tab && typeof tab.url === 'string' ? tab.url.toLowerCase() : '';
    return { title, url, hostname: extractHostname(url) };
  }

  /**
   * Checks whether one tab satisfies every search term.
   *
   * @param {{title?: string, url?: string}} tab - Tab-like object.
   * @param {string[]} terms - Normalized search terms.
   * @returns {boolean} True when the tab matches (an empty query matches all).
   */
  function matchesTab(tab, terms) {
    if (!Array.isArray(terms) || terms.length === 0) return true;
    const text = getTabText(tab);
    const haystack = `${text.title}\n${text.url}\n${text.hostname}`;
    return terms.every(term => haystack.includes(term));
  }

  /**
   * Returns the IDs of tabs matching a query.
   *
   * @param {Array<{id: *, title?: string, url?: string}>} tabs - Tab-like objects.
   * @param {string} query - Raw query text.
   * @returns {Set<*>} Matching tab IDs.
   */
  function computeMatchedIds(tabs, query) {
    const terms = normalizeQuery(query);
    const matched = new Set();
    for (const tab of Array.isArray(tabs) ? tabs : []) {
      if (matchesTab(tab, terms)) matched.add(tab.id);
    }
    return matched;
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
    matchesTab,
    computeMatchedIds,
    buildVisibilityPlan,
    formatStatus,
    formatStatusTitle,
  };
})();

// Node's CommonJS loader. In Firefox this block is inert.
if (typeof module === 'object' && module.exports) {
  module.exports = FirefoxNativeTabSearchCore;
}
