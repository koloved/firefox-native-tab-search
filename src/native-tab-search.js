/**
 * Firefox Native Tab Search - privileged chrome integration.
 *
 * Loaded once per Firefox process by the Autoconfig loader. It injects a
 * search field above the native vertical tab strip and filters tabs directly
 * with gBrowser.hideTab()/showTab(). No extension, XPI or WebExtension API is
 * involved.
 */
var FirefoxNativeTabSearch = (function () {
  'use strict';

  const VERSION = '1.0.0';
  const LOG_PREFIX = '[Native Tab Search]';
  const HOST_ID = 'firefox-native-tab-search-host';
  const STYLE_ID = 'firefox-native-tab-search-style';
  const INPUT_ID = 'fnts-input';
  const CLEAR_ID = 'fnts-clear';
  const STATUS_ID = 'fnts-status';
  const EXPAND_ID = 'fnts-expand';
  const KEY_ID = 'fnts-focus-key';
  const XHTML_NS = 'http://www.w3.org/1999/xhtml';
  const COLLAPSED_HEIGHT = 38;
  const EXPANDED_HEIGHT = 64;
  const INPUT_DEBOUNCE_MS = 120;
  const EVENT_GRACE_MS = 300;
  const STARTUP_RETRY_MS = 500;
  const STARTUP_RETRY_MAX = 40;

  const core = typeof FirefoxNativeTabSearchCore !== 'undefined' ? FirefoxNativeTabSearchCore : null;

  /**
   * Resolves the Services module in a window or sandbox global.
   *
   * @returns {Object} Services module.
   */
  function getServices() {
    if (typeof Services !== 'undefined') return Services;
    return ChromeUtils.importESModule('resource://gre/modules/Services.sys.mjs').Services;
  }

  /**
   * Writes an informational message to the Browser Console.
   *
   * @param {...*} args - Values to log.
   * @returns {void}
   */
  function log(...args) {
    const message = `${LOG_PREFIX} ${args.map(value => String(value)).join(' ')}`;
    try {
      if (typeof console !== 'undefined' && typeof console.info === 'function') {
        console.info(LOG_PREFIX, ...args);
      }
    } catch {
      // Console is optional.
    }
    try {
      getServices().console.logStringMessage(message);
    } catch {
      // Console service is optional.
    }
  }

  /**
   * Writes a warning to the Browser Console.
   *
   * @param {...*} args - Values to log.
   * @returns {void}
   */
  function warn(...args) {
    try {
      if (typeof console !== 'undefined' && typeof console.warn === 'function') {
        console.warn(LOG_PREFIX, ...args);
      }
    } catch {
      // Console is optional.
    }
  }

  /**
   * Returns the Firefox application version.
   *
   * @returns {string} Version string or "unknown".
   */
  function getFirefoxVersion() {
    try {
      return getServices().appinfo.version;
    } catch {
      return 'unknown';
    }
  }

  /**
   * Creates an XHTML element inside the chrome document.
   *
   * @param {Document} doc - Browser chrome document.
   * @param {string} tag - Element name.
   * @param {string} [className] - Optional class attribute.
   * @param {string} [id] - Optional id attribute.
   * @returns {HTMLElement} Created element.
   */
  function createHtml(doc, tag, className, id) {
    const node = doc.createElementNS(XHTML_NS, tag);
    if (id) node.id = id;
    if (className) node.className = className;
    return node;
  }

  /**
   * Checks whether a browser window has the native vertical-tabs DOM.
   *
   * @param {Window} win - Browser chrome window.
   * @returns {boolean} True when the expected elements exist.
   */
  function hasVerticalTabsDom(win) {
    try {
      return !!(win && win.document && win.document.getElementById('vertical-tabs'));
    } catch {
      return false;
    }
  }

  /**
   * Injects the scoped stylesheet once per browser window.
   *
   * @param {Document} doc - Browser chrome document.
   * @returns {void}
   */
  function ensureStyle(doc) {
    if (doc.getElementById(STYLE_ID)) return;
    const style = doc.createElementNS(XHTML_NS, 'style');
    style.id = STYLE_ID;
    style.textContent = `
      /* The native #vertical-tabs is a row by default. Turn it into a column
         only while vertical tabs are visible, so the field sits directly above
         the tab strip. */
      #vertical-tabs[visible] {
        flex-direction: column !important;
      }
      #vertical-tabs[visible] > #${HOST_ID} {
        flex: 0 0 auto !important;
        width: 100% !important;
        min-width: 0 !important;
      }
      #vertical-tabs[visible] > #tabbrowser-tabs {
        flex: 1 1 auto !important;
        min-height: 0 !important;
      }
      #${HOST_ID} {
        box-sizing: border-box;
        display: flex;
        flex-direction: column;
        width: 100%;
        min-width: 0;
        height: ${EXPANDED_HEIGHT}px;
        padding: 5px 8px 4px;
        overflow: hidden;
        color: var(--toolbar-color, currentColor);
        font: menu;
        font-size: 13px;
        --fnts-text-dim: var(--text-color-deemphasized, color-mix(in srgb, currentColor 65%, transparent));
        --fnts-field-bg: color-mix(in srgb, currentColor 5%, transparent);
        --fnts-field-border: color-mix(in srgb, currentColor 18%, transparent);
        --fnts-field-hover: color-mix(in srgb, currentColor 10%, transparent);
        --fnts-accent: var(--focus-outline-color, #0060df);
      }
      #${HOST_ID} * {
        box-sizing: border-box;
      }
      #${HOST_ID} .fnts-row {
        position: relative;
        display: flex;
        align-items: center;
        width: 100%;
        min-width: 0;
      }
      #${HOST_ID} .fnts-field {
        position: relative;
        display: flex;
        width: 100%;
        min-width: 0;
      }
      #${HOST_ID} .fnts-search-icon {
        position: absolute;
        inset-inline-start: 9px;
        top: 50%;
        width: 14px;
        height: 14px;
        transform: translateY(-50%);
        background: currentColor;
        opacity: 0.65;
        pointer-events: none;
        -webkit-mask: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'%3E%3Cpath d='M10.5 3a5.5 5.5 0 1 0 3.36 9.86l2.14 2.14a.75.75 0 1 0 1.06-1.06l-2.14-2.14A5.5 5.5 0 0 0 10.5 3Zm0 1.5a4 4 0 1 1 0 8 4 4 0 0 1 0-8Z'/%3E%3C/svg%3E") center / contain no-repeat;
        mask: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'%3E%3Cpath d='M10.5 3a5.5 5.5 0 1 0 3.36 9.86l2.14 2.14a.75.75 0 1 0 1.06-1.06l-2.14-2.14A5.5 5.5 0 0 0 10.5 3Zm0 1.5a4 4 0 1 1 0 8 4 4 0 0 1 0-8Z'/%3E%3C/svg%3E") center / contain no-repeat;
      }
      #${INPUT_ID} {
        width: 100%;
        min-width: 0;
        height: 32px;
        margin: 0;
        padding: 0 30px 0 29px;
        border: 1px solid var(--fnts-field-border);
        border-radius: 24px;
        background: var(--fnts-field-bg);
        color: inherit;
        font: inherit;
        line-height: 30px;
        outline: none;
      }
      #${INPUT_ID}::placeholder {
        color: var(--fnts-text-dim);
        opacity: 1;
      }
      #${INPUT_ID}:hover {
        border-color: color-mix(in srgb, currentColor 32%, transparent);
      }
      #${INPUT_ID}:focus {
        border-color: var(--fnts-accent);
        outline: 1px solid var(--fnts-accent);
        outline-offset: -2px;
      }
      #${CLEAR_ID}[hidden] {
        display: none !important;
      }
      #${CLEAR_ID} {
        position: absolute;
        inset-inline-end: 4px;
        top: 50%;
        display: flex;
        align-items: center;
        justify-content: center;
        width: 24px;
        height: 24px;
        padding: 0;
        border: 0;
        border-radius: 50%;
        background: transparent;
        color: var(--fnts-text-dim);
        transform: translateY(-50%);
        cursor: pointer;
        -webkit-mask: none;
      }
      #${CLEAR_ID}:hover {
        background: var(--fnts-field-hover);
        color: inherit;
      }
      #${CLEAR_ID}:focus-visible {
        outline: 2px solid var(--fnts-accent);
        outline-offset: -2px;
      }
      #${CLEAR_ID}::before {
        content: "";
        width: 12px;
        height: 12px;
        background: currentColor;
        -webkit-mask: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'%3E%3Cpath d='M4.28 3.22a.75.75 0 0 0-1.06 1.06L6.94 8l-3.72 3.72a.75.75 0 1 0 1.06 1.06L8 9.06l3.72 3.72a.75.75 0 1 0 1.06-1.06L9.06 8l3.72-3.72a.75.75 0 0 0-1.06-1.06L8 6.94 4.28 3.22Z'/%3E%3C/svg%3E") center / contain no-repeat;
        mask: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'%3E%3Cpath d='M4.28 3.22a.75.75 0 0 0-1.06 1.06L6.94 8l-3.72 3.72a.75.75 0 1 0 1.06 1.06L8 9.06l3.72 3.72a.75.75 0 1 0 1.06-1.06L9.06 8l3.72-3.72a.75.75 0 0 0-1.06-1.06L8 6.94 4.28 3.22Z'/%3E%3C/svg%3E") center / contain no-repeat;
      }
      #${STATUS_ID} {
        display: block;
        min-height: 15px;
        margin-top: 8px;
        padding: 0 2px;
        overflow: hidden;
        color: var(--fnts-text-dim);
        font-size: 11px;
        line-height: 15px;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      #${EXPAND_ID} {
        position: relative;
        display: none;
        align-items: center;
        justify-content: center;
        width: 30px;
        height: 30px;
        margin: 0 auto;
        padding: 0;
        border: 0;
        border-radius: 6px;
        background: transparent;
        color: inherit;
        cursor: pointer;
      }
      #${EXPAND_ID}:hover {
        background: var(--fnts-field-hover);
      }
      #${EXPAND_ID}:focus-visible {
        outline: 2px solid var(--fnts-accent);
        outline-offset: -2px;
      }
      #${EXPAND_ID}::before {
        content: "";
        width: 16px;
        height: 16px;
        background: currentColor;
        opacity: 0.8;
        -webkit-mask: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'%3E%3Cpath d='M10.5 3a5.5 5.5 0 1 0 3.36 9.86l2.14 2.14a.75.75 0 1 0 1.06-1.06l-2.14-2.14A5.5 5.5 0 0 0 10.5 3Zm0 1.5a4 4 0 1 1 0 8 4 4 0 0 1 0-8Z'/%3E%3C/svg%3E") center / contain no-repeat;
        mask: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'%3E%3Cpath d='M10.5 3a5.5 5.5 0 1 0 3.36 9.86l2.14 2.14a.75.75 0 1 0 1.06-1.06l-2.14-2.14A5.5 5.5 0 0 0 10.5 3Zm0 1.5a4 4 0 1 1 0 8 4 4 0 0 1 0-8Z'/%3E%3C/svg%3E") center / contain no-repeat;
      }
      #${HOST_ID}[data-collapsed] {
        justify-content: center;
        height: ${COLLAPSED_HEIGHT}px;
        padding: 4px 0;
      }
      #${HOST_ID}[data-collapsed] .fnts-row,
      #${HOST_ID}[data-collapsed] #${STATUS_ID} {
        display: none;
      }
      #${HOST_ID}[data-collapsed] #${EXPAND_ID} {
        display: flex;
      }
      /* Hide a native tab group only while it has no visible or matching
         tabs. A private attribute is used so the user's collapsed/expanded
         state is never changed. */
      tab-group[data-fnts-hidden] {
        display: none !important;
      }
      #${HOST_ID} .fnts-dot {
        position: absolute;
        top: 4px;
        right: 4px;
        width: 6px;
        height: 6px;
        border-radius: 50%;
        background: var(--fnts-accent);
      }
    `;
    (doc.head || doc.documentElement).appendChild(style);
  }

  /**
   * Checks whether the vertical-tabs launcher is expanded.
   *
   * @param {Window} win - Browser chrome window.
   * @returns {boolean} True when tab titles are visible.
   */
  function isLauncherExpanded(win) {
    try {
      const tabContainer = win.document.getElementById('tabbrowser-tabs');
      if (tabContainer && tabContainer.hasAttribute('expanded')) return true;
      const sidebarMain = win.document.querySelector('sidebar-main');
      if (sidebarMain && (sidebarMain.expanded === true || sidebarMain.hasAttribute('expanded'))) {
        return true;
      }
      if (win.SidebarController && win.SidebarController._state) {
        return !!win.SidebarController._state.launcherExpanded;
      }
    } catch {
      // Fall through to collapsed.
    }
    return false;
  }

  /**
   * Expands (or reveals) the native vertical-tabs launcher.
   *
   * @param {Window} win - Browser chrome window.
   * @returns {boolean} True when an expansion path succeeded.
   */
  function expandSidebar(win) {
    const controller = win.SidebarController;
    if (!controller) return false;

    try {
      const state = controller._state;
      if (state) {
        if ('launcherVisible' in state) {
          try {
            state.launcherVisible = true;
          } catch {
            // Visibility may be fixed by the current sidebar.visibility pref.
          }
        }
        try {
          state.launcherExpanded = true;
          return true;
        } catch (err) {
          warn('SidebarState.launcherExpanded failed:', err);
        }
        if (typeof state.updateVisibility === 'function') {
          state.updateVisibility(true, true);
          return true;
        }
      }
    } catch (err) {
      warn('SidebarController expansion failed:', err);
    }

    try {
      const sidebarMain = controller.sidebarMain || win.document.querySelector('sidebar-main');
      if (sidebarMain) {
        sidebarMain.expanded = true;
        return true;
      }
    } catch (err) {
      warn('Could not expand sidebar-main directly:', err);
    }

    try {
      if (typeof controller.handleToolbarButtonClick === 'function') {
        controller.handleToolbarButtonClick();
        return true;
      }
    } catch (err) {
      warn('Could not toggle the sidebar toolbar button:', err);
    }

    return false;
  }

  /**
   * Updates the host height for the current expanded/collapsed state.
   *
   * @param {Object} instance - Per-window integration state.
   * @returns {void}
   */
  function updateLayout(instance) {
    if (!instance || !instance.host) return;
    const expanded = isLauncherExpanded(instance.win);
    instance.host.style.height = `${expanded ? EXPANDED_HEIGHT : COLLAPSED_HEIGHT}px`;
    instance.host.toggleAttribute('data-collapsed', !expanded);
    instance.host.style.display = 'flex';
    instance.host.style.flex = '0 0 auto';
    instance.host.style.width = '100%';
    instance.host.style.minWidth = '0';
    instance.host.style.overflow = 'hidden';
  }

  /**
   * Builds a plain descriptor for one tab.
   *
   * @param {Object} tab - XUL tab element.
   * @returns {{id: Object, title: string, url: string, active: boolean, pinned: boolean, hidden: boolean}} Tab descriptor.
   */
  function describeTab(tab) {
    let url = '';
    try {
      url = tab.linkedBrowser && tab.linkedBrowser.currentURI ? tab.linkedBrowser.currentURI.spec : '';
    } catch {
      url = '';
    }
    return {
      id: tab,
      title: typeof tab.label === 'string' ? tab.label : '',
      url,
      active: !!tab.selected,
      pinned: !!tab.pinned,
      hidden: !!tab.hidden,
    };
  }

  /**
   * Builds descriptors for every tab in a window.
   *
   * @param {Window} win - Browser chrome window.
   * @returns {Array<Object>} Tab descriptors.
   */
  function describeTabs(win) {
    const tabs = win.gBrowser && win.gBrowser.tabs ? win.gBrowser.tabs : [];
    return Array.from(tabs, describeTab);
  }

  /**
   * Returns the number of tabs in a window.
   *
   * @param {Window} win - Browser chrome window.
   * @returns {number} Tab count.
   */
  function getTabCount(win) {
    try {
      return win.gBrowser && win.gBrowser.tabs ? win.gBrowser.tabs.length : 0;
    } catch {
      return 0;
    }
  }

  /**
   * Creates a new inactive session state object.
   *
   * @param {Window} win - Browser chrome window.
   * @returns {Object} Session state.
   */
  function createSession(win) {
    return {
      active: false,
      query: '',
      ownedHidden: new Set(),
      protectedActive: new Set(),
      newTabs: new Set(),
      exempt: new Set(),
      recentlyChanged: new Map(),
      applying: false,
      inputTimer: null,
      applyTimer: null,
      state: { active: false, total: getTabCount(win) },
      disposed: false,
    };
  }

  /**
   * Updates the visible counter and the collapsed-mode active dot.
   *
   * @param {Object} instance - Per-window integration state.
   * @returns {void}
   */
  function updateStatus(instance) {
    if (!instance || instance.disposed) return;
    const session = instance.session;
    if (!session.active) {
      session.state = { active: false, total: getTabCount(instance.win) };
    }
    instance.status.textContent = core ? core.formatStatus(session.state) : '';
    const title = core ? core.formatStatusTitle(session.state) : '';
    if (title) {
      instance.status.title = title;
    } else {
      instance.status.removeAttribute('title');
    }
    const filterActive = !!(session.active && typeof session.query === 'string' && session.query.trim());
    instance.dot.hidden = !filterActive;
    instance.expand.title = filterActive ? 'Search tabs (filter active)' : 'Search tabs';
  }

  /**
   * Updates the clear-button visibility from the current input value.
   *
   * @param {Object} instance - Per-window integration state.
   * @returns {void}
   */
  function updateClearButton(instance) {
    instance.clear.hidden = instance.input.value.length === 0;
  }

  /**
   * Removes the integration's hidden marker from every tab group.
   *
   * @param {Object} instance - Per-window integration state.
   * @returns {void}
   */
  function restoreGroups(instance) {
    if (!instance || instance.disposed) return;
    try {
      const groups = instance.doc.querySelectorAll('tab-group[data-fnts-hidden]');
      for (const group of groups) {
        group.removeAttribute('data-fnts-hidden');
      }
    } catch (err) {
      warn('Could not restore tab groups:', err);
    }
  }

  /**
   * Hides tab groups that have no visible or potentially visible tabs.
   *
   * Expanded groups stay visible only while at least one tab is visible.
   * Collapsed groups stay visible while they contain a matching, active,
   * pinned, protected, new or externally shown tab. Empty groups are hidden
   * during the filter.
   *
   * @param {Object} instance - Per-window integration state.
   * @param {Set<*>|Array<*>} matchedIds - Tabs matching the current query.
   * @returns {void}
   */
  function updateGroupVisibility(instance, matchedIds) {
    if (!instance || instance.disposed) return;
    const session = instance.session;
    const matched = matchedIds instanceof Set ? matchedIds : new Set(matchedIds || []);
    let groups = [];
    try {
      groups = instance.win.gBrowser.getAllTabGroups
        ? instance.win.gBrowser.getAllTabGroups()
        : [];
    } catch (err) {
      warn('Could not enumerate tab groups:', err);
      return;
    }

    for (const group of groups) {
      if (!group || group.isConnected === false) continue;
      const groupTabs = Array.from(group.tabs || []);
      const kept = new Set();
      for (const tab of groupTabs) {
        if (
          tab.selected ||
          tab.pinned ||
          session.protectedActive.has(tab) ||
          session.newTabs.has(tab) ||
          session.exempt.has(tab)
        ) {
          kept.add(tab);
        }
      }
      const shouldHide = core.shouldHideGroup(
        {
          collapsed: !!group.collapsed,
          tabs: groupTabs.map(tab => ({ id: tab, hidden: !!tab.hidden })),
        },
        matched,
        kept
      );

      if (shouldHide) {
        group.setAttribute('data-fnts-hidden', 'true');
      } else {
        group.removeAttribute('data-fnts-hidden');
      }
    }
  }

  /**
   * Focuses the search field, expanding the sidebar first when necessary.
   *
   * @param {Object} instance - Per-window integration state.
   * @returns {void}
   */
  function focusField(instance) {
    if (!instance || instance.disposed) return;
    expandSidebar(instance.win);
    updateLayout(instance);
    const focus = () => {
      if (instance.disposed) return;
      try {
        instance.input.focus({ preventScroll: true });
        instance.input.select();
      } catch (err) {
        warn('Could not focus the search field:', err);
      }
    };
    focus();
    instance.win.setTimeout(focus, 40);
    instance.win.setTimeout(focus, 160);
    instance.win.setTimeout(focus, 400);
  }

  /**
   * Schedules a visibility pass for one window.
   *
   * @param {Object} instance - Per-window integration state.
   * @param {number} [delay=0] - Delay in milliseconds.
   * @returns {void}
   */
  function scheduleApply(instance, delay = 0) {
    if (!instance || instance.disposed) return;
    const session = instance.session;
    if (session.applyTimer) {
      if (delay === 0) return;
      instance.win.clearTimeout(session.applyTimer);
    }
    session.applyTimer = instance.win.setTimeout(() => {
      session.applyTimer = null;
      applyFilter(instance);
    }, delay);
  }

  /**
   * Returns the selected tab, if any.
   *
   * @param {Window} win - Browser chrome window.
   * @returns {Object|null} Selected XUL tab element.
   */
  function getSelectedTab(win) {
    try {
      return win.gBrowser.selectedTab || null;
    } catch {
      return null;
    }
  }

  /**
   * Starts a new filter session when the first query is typed.
   *
   * @param {Object} instance - Per-window integration state.
   * @param {string} query - Current query text.
   * @returns {void}
   */
  function beginSession(instance, query) {
    const session = instance.session;
    session.active = true;
    session.ownedHidden.clear();
    session.protectedActive.clear();
    session.newTabs.clear();
    session.exempt.clear();
    session.recentlyChanged.clear();

    const selected = getSelectedTab(instance.win);
    if (selected && core) {
      const descriptor = describeTab(selected);
      if (!core.matchesTab(descriptor, core.normalizeQuery(query))) {
        session.protectedActive.add(selected);
      }
    }
  }

  /**
   * Applies the current query to the window.
   *
   * @param {Object} instance - Per-window integration state.
   * @returns {void}
   */
  function applyFilter(instance) {
    if (!instance || instance.disposed || !core) return;
    const session = instance.session;
    const win = instance.win;
    const query = typeof session.query === 'string' ? session.query.trim() : '';

    if (!query) {
      clearSession(instance, { keepInput: false, showTabs: true });
      return;
    }

    if (!session.active) {
      beginSession(instance, query);
    }

    const tabs = describeTabs(win);
    const matchedIds = core.computeMatchedIds(tabs, query);
    const plan = core.buildVisibilityPlan(
      tabs,
      matchedIds,
      session.ownedHidden,
      session.protectedActive,
      session.newTabs,
      session.exempt
    );

    const toHide = plan.toHide.filter(tab => !session.exempt.has(tab));
    const toShow = Array.from(new Set(plan.toShow));
    let blockedUnsupported = 0;

    session.applying = true;
    try {
      const stamp = Date.now();
      for (const tab of toHide) {
        if (!tab.isConnected) continue;
        session.ownedHidden.add(tab);
        session.recentlyChanged.set(tab, stamp);
        try {
          win.gBrowser.hideTab(tab);
        } catch (err) {
          warn('Could not hide a tab:', err);
        }
        if (!tab.hidden) {
          session.ownedHidden.delete(tab);
          blockedUnsupported++;
        }
      }
      for (const tab of toShow) {
        if (!tab.isConnected) continue;
        session.recentlyChanged.set(tab, stamp);
        try {
          win.gBrowser.showTab(tab);
        } catch (err) {
          warn('Could not show a tab:', err);
        }
        if (!tab.hidden) {
          session.ownedHidden.delete(tab);
        }
      }
    } finally {
      session.applying = false;
    }

    updateGroupVisibility(instance, matchedIds);

    session.state = {
      active: true,
      query,
      total: tabs.length,
      matched: plan.matchedCount,
      visibleMatched: plan.visibleMatched,
      hiddenMatched: plan.hiddenMatched,
      hiddenByFilter: session.ownedHidden.size,
      blockedActive: plan.blockedActive,
      blockedPinned: plan.blockedPinned,
      blockedUnsupported,
      protectedCount: plan.protectedCount,
      newTabCount: plan.newTabCount,
      exemptCount: plan.exemptCount,
      keptVisible: plan.keptVisible + blockedUnsupported,
      updatedAt: Date.now(),
    };
    updateStatus(instance);
  }

  /**
   * Clears the current filter and restores every tab hidden by this session.
   *
   * @param {Object} instance - Per-window integration state.
   * @param {{keepInput?: boolean, showTabs?: boolean}} [options] - Clear options.
   * @returns {void}
   */
  function clearSession(instance, options = {}) {
    if (!instance || instance.disposed) return;
    const session = instance.session;
    const { keepInput = false, showTabs = true } = options;

    if (session.inputTimer) {
      instance.win.clearTimeout(session.inputTimer);
      session.inputTimer = null;
    }
    if (session.applyTimer) {
      instance.win.clearTimeout(session.applyTimer);
      session.applyTimer = null;
    }

    const hidden = Array.from(session.ownedHidden);
    session.applying = true;
    try {
      if (showTabs) {
        for (const tab of hidden) {
          if (!tab.isConnected) continue;
          session.recentlyChanged.set(tab, Date.now());
          try {
            instance.win.gBrowser.showTab(tab);
          } catch (err) {
            warn('Could not restore a tab:', err);
          }
        }
      }
    } finally {
      session.applying = false;
    }

    restoreGroups(instance);

    session.active = false;
    session.query = '';
    session.ownedHidden.clear();
    session.protectedActive.clear();
    session.newTabs.clear();
    session.exempt.clear();
    session.recentlyChanged.clear();
    session.state = { active: false, total: getTabCount(instance.win) };

    if (!keepInput) {
      instance.input.value = '';
      updateClearButton(instance);
    }
    updateStatus(instance);
  }

  /**
   * Handles input in the search field.
   *
   * @param {Object} instance - Per-window integration state.
   * @returns {void}
   */
  function onInput(instance) {
    const session = instance.session;
    session.query = instance.input.value;
    updateClearButton(instance);
    if (instance.composing) return;
    if (session.inputTimer) instance.win.clearTimeout(session.inputTimer);
    session.inputTimer = instance.win.setTimeout(() => {
      session.inputTimer = null;
      applyFilter(instance);
    }, INPUT_DEBOUNCE_MS);
  }

  /**
   * Handles key presses in the search field.
   *
   * @param {Object} instance - Per-window integration state.
   * @param {KeyboardEvent} event - Key event.
   * @returns {void}
   */
  function onKeyDown(instance, event) {
    if (event.key === 'Escape' || event.key === 'Esc') {
      event.preventDefault();
      event.stopPropagation();
      clearSession(instance);
      focusField(instance);
    }
  }

  /**
   * Shows the current tab count when no filter is active. The count is read
   * after the tab has actually been added to or removed from gBrowser.tabs.
   *
   * @param {Object} instance - Per-window integration state.
   * @returns {void}
   */
  function scheduleCountUpdate(instance) {
    if (!instance || instance.disposed) return;
    if (instance.countTimer) {
      instance.win.clearTimeout(instance.countTimer);
    }
    instance.countTimer = instance.win.setTimeout(() => {
      instance.countTimer = null;
      if (instance.disposed || instance.session.active) return;
      instance.session.state = { active: false, total: getTabCount(instance.win) };
      updateStatus(instance);
    }, 0);
  }

  /**
   * Handles a tab created while the filter is active.
   *
   * @param {Object} instance - Per-window integration state.
   * @param {Object} tab - New XUL tab element.
   * @returns {void}
   */
  function onTabOpened(instance, tab) {
    const session = instance.session;
    if (session.active && tab) {
      session.newTabs.add(tab);
    }
    if (!session.active) {
      scheduleCountUpdate(instance);
      return;
    }
    scheduleApply(instance, 0);
  }

  /**
   * Handles a tab that is closing.
   *
   * @param {Object} instance - Per-window integration state.
   * @param {Object} tab - Closing XUL tab element.
   * @returns {void}
   */
  function onTabClosed(instance, tab) {
    const session = instance.session;
    session.ownedHidden.delete(tab);
    session.protectedActive.delete(tab);
    session.newTabs.delete(tab);
    session.exempt.delete(tab);
    session.recentlyChanged.delete(tab);
    if (!session.active) {
      scheduleCountUpdate(instance);
      return;
    }
    scheduleApply(instance, 0);
  }

  /**
   * Handles tab selection changes.
   *
   * @param {Object} instance - Per-window integration state.
   * @param {Object} tab - Newly selected XUL tab element.
   * @returns {void}
   */
  function onTabSelected(instance, tab) {
    const session = instance.session;
    if (!session.active || !tab || !core) return;
    const descriptor = describeTab(tab);
    if (!core.matchesTab(descriptor, core.normalizeQuery(session.query))) {
      session.protectedActive.add(tab);
    }
    scheduleApply(instance, 0);
  }

  /**
   * Handles an externally shown tab. Tabs shown by this integration are
   * filtered out with the applying flag and the recent-change timestamp.
   *
   * @param {Object} instance - Per-window integration state.
   * @param {Object} tab - XUL tab element.
   * @returns {void}
   */
  function onTabShown(instance, tab) {
    const session = instance.session;
    if (!session.active || !tab) return;
    const stamp = session.recentlyChanged.get(tab) || 0;
    if (session.applying || Date.now() - stamp < EVENT_GRACE_MS) return;
    if (session.ownedHidden.has(tab)) {
      session.ownedHidden.delete(tab);
      session.exempt.add(tab);
      scheduleApply(instance, 0);
    }
  }

  /**
   * Handles a tab change event that may affect matching.
   *
   * @param {Object} instance - Per-window integration state.
   * @returns {void}
   */
  function onTabChanged(instance) {
    if (!instance.session.active) return;
    scheduleApply(instance, 30);
  }

  /**
   * Handles a document load in any tab.
   *
   * @param {Object} instance - Per-window integration state.
   * @param {Event} event - DOM load event.
   * @returns {void}
   */
  function onContentLoad(instance, event) {
    if (!instance.session.active) return;
    const target = event.target;
    if (!target || target.localName !== 'browser') return;
    scheduleApply(instance, 30);
  }

  /**
   * Creates and injects the search panel for one window.
   *
   * @param {Window} win - Browser chrome window.
   * @returns {Object|null} Instance state or null when vertical tabs are unavailable.
   */
  function createPanel(win) {
    if (!hasVerticalTabsDom(win)) return null;
    const doc = win.document;
    const verticalTabs = doc.getElementById('vertical-tabs');
    if (!verticalTabs) return null;

    const staleHost = doc.getElementById(HOST_ID);
    if (staleHost) staleHost.remove();

    ensureStyle(doc);

    const host = createHtml(doc, 'div', '', HOST_ID);
    host.setAttribute('data-firefox-native-tab-search', VERSION);
    host.style.height = `${COLLAPSED_HEIGHT}px`;

    const expand = createHtml(doc, 'button', '', EXPAND_ID);
    expand.setAttribute('type', 'button');
    expand.setAttribute('aria-label', 'Open tab search');
    expand.title = 'Search tabs';

    const dot = createHtml(doc, 'span', 'fnts-dot');
    dot.hidden = true;
    expand.appendChild(dot);

    const row = createHtml(doc, 'div', 'fnts-row');
    const field = createHtml(doc, 'div', 'fnts-field');
    const icon = createHtml(doc, 'span', 'fnts-search-icon');
    icon.setAttribute('aria-hidden', 'true');

    const input = createHtml(doc, 'input', '', INPUT_ID);
    input.setAttribute('type', 'text');
    input.setAttribute('placeholder', 'Search tabs...');
    input.setAttribute('autocomplete', 'off');
    input.setAttribute('autocapitalize', 'off');
    input.setAttribute('spellcheck', 'false');
    input.setAttribute('aria-label', 'Search tabs');

    const clearButton = createHtml(doc, 'button', '', CLEAR_ID);
    clearButton.setAttribute('type', 'button');
    clearButton.setAttribute('aria-label', 'Clear search');
    clearButton.title = 'Clear search';
    clearButton.hidden = true;

    field.appendChild(icon);
    field.appendChild(input);
    field.appendChild(clearButton);
    row.appendChild(field);

    const status = createHtml(doc, 'div', '', STATUS_ID);
    status.setAttribute('role', 'status');
    status.setAttribute('aria-live', 'polite');

    host.appendChild(expand);
    host.appendChild(row);
    host.appendChild(status);
    verticalTabs.prepend(host);

    const instance = {
      win,
      doc,
      host,
      input,
      clear: clearButton,
      status,
      expand,
      dot,
      session: createSession(win),
      listeners: [],
      observers: [],
      keyElement: null,
      countTimer: null,
      composing: false,
      unloadListener: null,
      disposed: false,
    };
    instance.shutdown = () => shutdownWindow(win);

    /**
     * Registers a DOM event listener and remembers it for cleanup.
     *
     * @param {EventTarget} target - Event target.
     * @param {string} type - Event type.
     * @param {Function} handler - Event handler.
     * @param {boolean|Object} [options] - Listener options.
     * @returns {void}
     */
    const listen = (target, type, handler, options) => {
      target.addEventListener(type, handler, options);
      instance.listeners.push({ target, type, handler, options });
    };

    listen(input, 'input', () => onInput(instance));
    listen(input, 'compositionstart', () => {
      instance.composing = true;
    });
    listen(input, 'compositionend', () => {
      instance.composing = false;
      onInput(instance);
    });
    listen(input, 'keydown', event => onKeyDown(instance, event));
    listen(clearButton, 'click', () => {
      clearSession(instance);
      focusField(instance);
    });
    listen(expand, 'click', () => focusField(instance));

    const tabContainer = win.gBrowser.tabContainer || win.gBrowser;
    listen(tabContainer, 'TabOpen', event => onTabOpened(instance, event.target));
    listen(tabContainer, 'TabClose', event => onTabClosed(instance, event.target));
    listen(tabContainer, 'TabSelect', event => onTabSelected(instance, event.target));
    listen(tabContainer, 'TabPinned', () => onTabChanged(instance));
    listen(tabContainer, 'TabUnpinned', () => onTabChanged(instance));
    listen(tabContainer, 'TabAttrModified', () => onTabChanged(instance));
    listen(tabContainer, 'TabShow', event => onTabShown(instance, event.target));
    listen(win.gBrowser, 'load', event => onContentLoad(instance, event), true);

    // Ctrl+Alt+F focuses the field from anywhere in the window. A XUL <key>
    // element works even while web content has keyboard focus.
    try {
      const key = doc.createXULElement('key');
      key.id = KEY_ID;
      key.setAttribute('key', 'F');
      key.setAttribute('modifiers', 'ctrl,alt');
      key.addEventListener('command', () => focusField(instance));
      const keyset = doc.getElementById('mainKeyset') || doc.documentElement;
      keyset.appendChild(key);
      instance.keyElement = key;
    } catch (err) {
      warn('Could not register the focus shortcut:', err);
    }

    // Keep the panel first if Firefox rebuilds the vertical tab strip.
    try {
      const childObserver = new win.MutationObserver(() => {
        if (instance.disposed) return;
        if (!verticalTabs.isConnected) return;
        if (host.parentNode !== verticalTabs) {
          verticalTabs.prepend(host);
        }
        updateLayout(instance);
      });
      childObserver.observe(verticalTabs, { childList: true });
      instance.observers.push(childObserver);
    } catch (err) {
      warn('Could not observe the vertical tab strip:', err);
    }

    // React to expand/collapse and vertical-tabs visibility changes.
    try {
      const layoutObserver = new win.MutationObserver(() => {
        if (instance.disposed) return;
        updateLayout(instance);
        if (instance.session.active && !verticalTabs.hasAttribute('visible')) {
          clearSession(instance);
        }
      });
      const tabContainer = doc.getElementById('tabbrowser-tabs');
      const sidebarMain = doc.querySelector('sidebar-main');
      if (tabContainer) {
        layoutObserver.observe(tabContainer, {
          attributes: true,
          attributeFilter: ['expanded'],
        });
      }
      if (sidebarMain) {
        layoutObserver.observe(sidebarMain, {
          attributes: true,
          attributeFilter: ['expanded'],
        });
      }
      layoutObserver.observe(verticalTabs, {
        attributes: true,
        attributeFilter: ['visible'],
      });
      instance.observers.push(layoutObserver);
    } catch (err) {
      warn('Could not observe the vertical tab layout:', err);
    }

    // Tab groups are added, removed, collapsed and expanded outside the
    // regular tab events. Re-run the filter so group headers disappear when
    // their last visible tab is hidden.
    try {
      const scrollbox = doc.getElementById('tabbrowser-arrowscrollbox');
      if (scrollbox) {
        const groupObserver = new win.MutationObserver(() => {
          if (instance.disposed || !instance.session.active) return;
          scheduleApply(instance, 30);
        });
        groupObserver.observe(scrollbox, { childList: true });
        instance.observers.push(groupObserver);

        const collapseObserver = new win.MutationObserver(() => {
          if (instance.disposed || !instance.session.active) return;
          scheduleApply(instance, 30);
        });
        collapseObserver.observe(scrollbox, {
          attributes: true,
          subtree: true,
          attributeFilter: ['collapsed'],
        });
        instance.observers.push(collapseObserver);
      }
    } catch (err) {
      warn('Could not observe tab groups:', err);
    }

    // If the whole sidebar DOM is replaced, recreate the panel.
    try {
      const sidebarContainer = doc.getElementById('sidebar-container');
      if (sidebarContainer) {
        const replaceObserver = new win.MutationObserver(() => {
          if (instance.disposed) return;
          if (doc.getElementById(HOST_ID)) return;
          shutdownWindow(win);
          initWindow(win);
        });
        replaceObserver.observe(sidebarContainer, { childList: true });
        instance.observers.push(replaceObserver);
      }
    } catch (err) {
      warn('Could not observe the sidebar container:', err);
    }

    updateLayout(instance);
    updateStatus(instance);
    log(`Panel injected (Firefox ${getFirefoxVersion()}, v${VERSION}).`);
    return instance;
  }

  /**
   * Removes a per-window panel and all of its listeners.
   *
   * @param {Window} win - Browser chrome window.
   * @returns {void}
   */
  function shutdownWindow(win) {
    let instance = null;
    try {
      instance = win.__firefoxNativeTabSearchInstance || null;
    } catch {
      instance = null;
    }
    if (!instance) return;
    if (instance.session.inputTimer) {
      try {
        win.clearTimeout(instance.session.inputTimer);
      } catch {
        // Window is closing.
      }
    }
    if (instance.session.applyTimer) {
      try {
        win.clearTimeout(instance.session.applyTimer);
      } catch {
        // Window is closing.
      }
    }
    if (instance.countTimer) {
      try {
        win.clearTimeout(instance.countTimer);
      } catch {
        // Window is closing.
      }
    }
    // Restore hidden tabs before marking the instance disposed. clearSession
    // refuses to run on a disposed instance, and hidden tabs would otherwise
    // be persisted by session restore.
    try {
      clearSession(instance, { keepInput: true, showTabs: true });
    } catch (err) {
      warn('Could not restore tabs while closing the window:', err);
    }
    instance.disposed = true;
    if (instance.unloadListener) {
      try {
        win.removeEventListener('unload', instance.unloadListener);
      } catch {
        // Window is closing.
      }
    }
    for (const listener of instance.listeners) {
      try {
        listener.target.removeEventListener(listener.type, listener.handler, listener.options);
      } catch {
        // Target is gone.
      }
    }
    for (const observer of instance.observers) {
      try {
        observer.disconnect();
      } catch {
        // Observer is gone.
      }
    }
    if (instance.keyElement) {
      try {
        instance.keyElement.remove();
      } catch {
        // Key element is gone.
      }
    }
    try {
      instance.host.remove();
    } catch {
      // Host is gone.
    }
    try {
      delete win.__firefoxNativeTabSearchInstance;
    } catch {
      win.__firefoxNativeTabSearchInstance = null;
    }
  }

  /**
   * Initializes the integration for one browser window.
   *
   * @param {Window} win - Browser chrome window.
   * @param {number} [attempt=0] - Startup retry attempt.
   * @returns {void}
   */
  function initWindow(win, attempt = 0) {
    if (!win || !win.document || win.document.documentURI !== 'chrome://browser/content/browser.xhtml') {
      return;
    }
    if (win.__firefoxNativeTabSearchInstance) return;

    const instance = createPanel(win);
    if (instance) {
      win.__firefoxNativeTabSearchInstance = instance;
      try {
        win.FirefoxNativeTabSearch = {
          version: VERSION,
          init: () => initWindow(win),
          shutdown: () => shutdownWindow(win),
        };
      } catch {
        // The window may be closing.
      }
      try {
        const unloadListener = () => shutdownWindow(win);
        win.addEventListener('unload', unloadListener, { once: true });
        instance.unloadListener = unloadListener;
      } catch {
        // Window may be closing.
      }
      return;
    }

    if (attempt < STARTUP_RETRY_MAX) {
      try {
        win.setTimeout(() => initWindow(win, attempt + 1), STARTUP_RETRY_MS);
      } catch {
        // Window is closing.
      }
    }
  }

  const windowRefs = new Set();
  let initialized = false;
  let observer = null;

  /**
   * Starts the integration for existing and future browser windows.
   *
   * @returns {void}
   */
  function init() {
    if (initialized) return;
    if (!core) {
      warn('Search core is missing; integration was not started.');
      return;
    }
    initialized = true;

    const services = getServices();
    const enumerator = services.wm.getEnumerator('navigator:browser');
    while (enumerator.hasMoreElements()) {
      const win = enumerator.getNext();
      windowRefs.add(win);
      initWindow(win);
    }

    observer = {
      observe(subject, topic) {
        if (topic !== 'browser-delayed-startup-finished') return;
        try {
          if (
            subject &&
            subject.document &&
            subject.document.documentURI === 'chrome://browser/content/browser.xhtml'
          ) {
            windowRefs.add(subject);
            initWindow(subject);
          }
        } catch (err) {
          warn('browser-delayed-startup-finished handler failed:', err);
        }
      },
    };
    services.obs.addObserver(observer, 'browser-delayed-startup-finished');
    log(`Integration loaded (Firefox ${getFirefoxVersion()}, v${VERSION}).`);
  }

  /**
   * Removes the integration from all windows and stops observing startup.
   *
   * @returns {void}
   */
  function shutdown() {
    if (!initialized) return;
    initialized = false;
    if (observer) {
      try {
        getServices().obs.removeObserver(observer, 'browser-delayed-startup-finished');
      } catch {
        // Observer is gone.
      }
      observer = null;
    }
    for (const win of Array.from(windowRefs)) {
      try {
        shutdownWindow(win);
      } catch {
        // Window is gone.
      }
    }
    windowRefs.clear();
  }

  return {
    version: VERSION,
    init,
    shutdown,
    initWindow,
    shutdownWindow,
  };
})();
