'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const core = require('../src/core.js');

test('normalizeQuery - trims, lowercases and splits on whitespace', () => {
  assert.deepEqual(core.normalizeQuery('  GitHub   Docs '), ['github', 'docs']);
  assert.deepEqual(core.normalizeQuery(''), []);
  assert.deepEqual(core.normalizeQuery(null), []);
});

test('normalizeQuery - caps very long input', () => {
  const terms = core.normalizeQuery('a '.repeat(100));
  assert.equal(terms.length, 12);
});

test('extractHostname - handles common URL forms', () => {
  assert.equal(core.extractHostname('https://github.com/irvinm?tab=1'), 'github.com');
  assert.equal(core.extractHostname('http://user:pass@example.com:8080/path'), 'example.com');
  assert.equal(core.extractHostname('http://[::1]:8080/'), '[::1]');
  assert.equal(core.extractHostname('about:blank'), '');
  assert.equal(core.extractHostname(''), '');
});

test('matchesTab - searches title, URL and hostname', () => {
  const tab = {
    id: 1,
    title: 'Pull request',
    url: 'https://github.com/irvinm/TabSearch/pull/22',
  };
  assert.equal(core.matchesTab(tab, ['github']), true);
  assert.equal(core.matchesTab(tab, ['pull']), true);
  assert.equal(core.matchesTab(tab, ['tabsearch']), true);
  assert.equal(core.matchesTab(tab, ['reddit']), false);
});

test('matchesTab - every term must match and an empty query matches all', () => {
  const tab = { id: 1, title: 'GitHub Docs', url: 'https://docs.github.com/' };
  assert.equal(core.matchesTab(tab, ['github', 'docs']), true);
  assert.equal(core.matchesTab(tab, ['github', 'reddit']), false);
  assert.equal(core.matchesTab(tab, []), true);
});

test('computeMatchedIds - returns the IDs of matching tabs', () => {
  const tabs = [
    { id: 1, title: 'GitHub', url: 'https://github.com/' },
    { id: 2, title: 'Reddit', url: 'https://reddit.com/' },
    { id: 3, title: 'Docs', url: 'https://docs.github.com/' },
  ];
  assert.deepEqual(Array.from(core.computeMatchedIds(tabs, 'github')), [1, 3]);
  assert.deepEqual(Array.from(core.computeMatchedIds(tabs, '')), [1, 2, 3]);
});

test('buildVisibilityPlan - hides non-matching tabs and keeps matches', () => {
  const tabs = [
    { id: 1, active: true, pinned: false, hidden: false },
    { id: 2, active: false, pinned: false, hidden: false },
    { id: 3, active: false, pinned: false, hidden: false },
  ];
  const plan = core.buildVisibilityPlan(tabs, new Set([1, 2]));
  assert.deepEqual(plan.toHide, [3]);
  assert.deepEqual(plan.toShow, []);
  assert.equal(plan.matchedCount, 2);
  assert.equal(plan.visibleMatched, 2);
  assert.equal(plan.blockedActive, 0);
});

test('buildVisibilityPlan - counts active non-matching tabs as blocked', () => {
  const tabs = [
    { id: 1, active: true, pinned: false, hidden: false },
    { id: 2, active: false, pinned: false, hidden: false },
  ];
  const plan = core.buildVisibilityPlan(tabs, new Set([2]));
  assert.deepEqual(plan.toHide, []);
  assert.equal(plan.blockedActive, 1);
  assert.equal(plan.keptVisible, 1);
});

test('buildVisibilityPlan - restores owned tabs that became active or pinned', () => {
  const tabs = [
    { id: 1, active: true, pinned: false, hidden: true },
    { id: 2, active: false, pinned: true, hidden: true },
    { id: 3, active: false, pinned: false, hidden: false },
  ];
  const plan = core.buildVisibilityPlan(tabs, new Set([3]), new Set([1, 2]));
  assert.deepEqual(plan.toShow.sort((a, b) => a - b), [1, 2]);
  assert.deepEqual(plan.toHide, []);
  assert.equal(plan.blockedActive, 1);
  assert.equal(plan.blockedPinned, 1);
});

test('buildVisibilityPlan - shows only tabs hidden by this session', () => {
  const tabs = [
    { id: 1, active: false, pinned: false, hidden: true },
    { id: 2, active: false, pinned: false, hidden: true },
    { id: 3, active: false, pinned: false, hidden: true },
  ];
  const plan = core.buildVisibilityPlan(tabs, new Set([1, 2]), new Set([1]));
  assert.deepEqual(plan.toShow, [1]);
  assert.deepEqual(plan.toHide, []);
  assert.equal(plan.hiddenMatched, 1);
  assert.equal(plan.hiddenByOther, 2);
});

test('buildVisibilityPlan - never hides pinned, protected, new or exempt tabs', () => {
  const tabs = [
    { id: 1, active: false, pinned: true, hidden: false },
    { id: 2, active: false, pinned: false, hidden: false },
    { id: 3, active: false, pinned: false, hidden: false },
    { id: 4, active: false, pinned: false, hidden: false },
    { id: 5, active: false, pinned: false, hidden: false },
    { id: 6, active: false, pinned: false, hidden: false },
  ];
  const plan = core.buildVisibilityPlan(
    tabs,
    new Set([6]),
    new Set(),
    new Set([2]),
    new Set([3]),
    new Set([4])
  );
  assert.deepEqual(plan.toHide, [5]);
  assert.equal(plan.blockedPinned, 1);
  assert.equal(plan.protectedCount, 1);
  assert.equal(plan.newTabCount, 1);
  assert.equal(plan.exemptCount, 1);
  assert.equal(plan.keptVisible, 4);
});

test('buildVisibilityPlan - leaves tabs hidden by someone else alone', () => {
  const tabs = [
    { id: 1, active: false, pinned: false, hidden: true },
    { id: 2, active: false, pinned: false, hidden: false },
  ];
  const plan = core.buildVisibilityPlan(tabs, new Set(), new Set());
  assert.deepEqual(plan.toHide, [2]);
  assert.deepEqual(plan.toShow, []);
  assert.equal(plan.hiddenByOther, 1);
});

test('formatStatus - inactive and active states', () => {
  assert.equal(core.formatStatus({ active: false, total: 12 }), 'Open tabs: 12');
  assert.equal(core.formatStatus({ active: false, total: 0 }), '');
  assert.equal(
    core.formatStatus({ active: true, total: 62, matched: 5 }),
    'Found 5 of 62 tabs'
  );
  assert.equal(core.formatStatus({ active: true, total: 62, matched: 0 }), 'No tabs found');
});

test('formatStatus - reports protected, new and blocked tabs', () => {
  const text = core.formatStatus({
    active: true,
    total: 63,
    matched: 5,
    protectedCount: 1,
    newTabCount: 1,
    blockedActive: 1,
    blockedPinned: 2,
    blockedUnsupported: 0,
  });
  assert.equal(
    text,
    "Found 5 of 63 tabs \u00b7 1 kept for return \u00b7 1 new \u00b7 3 can't be hidden"
  );
});

test('formatStatus - externally shown tabs are reported', () => {
  const text = core.formatStatus({
    active: true,
    total: 10,
    matched: 2,
    exemptCount: 1,
  });
  assert.equal(text, "Found 2 of 10 tabs \u00b7 1 can't be hidden");
});

test('formatStatusTitle - explains the counters', () => {
  const title = core.formatStatusTitle({
    active: true,
    protectedCount: 1,
    newTabCount: 2,
    blockedActive: 1,
    blockedPinned: 0,
    blockedUnsupported: 3,
  });
  assert.match(title, /Kept for return: 1/);
  assert.match(title, /New tabs kept visible: 2/);
  assert.match(title, /Protected by browser: 3/);
});
