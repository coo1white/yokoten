/// <reference lib="dom" />
// The usage view on the board (#611). Like the other browser files, these functions run
// in the page: they use only their arguments and the functions page.ts puts beside them.
// The numbers come from local session logs; this file only groups and words them.

import { roleGroup } from '../groups.ts';
import type { PageData, PageState } from './script.ts';
import { el, say } from './script.ts';
import { foldHead } from './column.ts';

/** A dollar amount in plain words. A tiny amount says so instead of "$0.00". */
export function usageUsd(usd: number): string {
  if (usd <= 0) return '$0.00';
  return usd < 0.01 ? 'less than $0.01' : `$${usd.toFixed(2)}`;
}

/** What some cells would cost on the API, in the page's language. */
export function usageCost(state: PageState, usd: number | null, isLocal: boolean): string {
  if (usd === null) return say(state, 'usagePartial');
  if (isLocal && usd === 0) return say(state, 'usageLocal');
  return say(state, 'usageAbout', { usd: usageUsd(usd) });
}

/** A token count grouped the page's way: 12450 is "12,450". */
function usageTokens(state: PageState, count: number): string {
  return new Intl.NumberFormat(state.ui.lang).format(count);
}

/** The role a filter word names, or '' for every role. */
function usageRoleGroup(word: string): string {
  if (word === 'checker') return 'group.verifier';
  if (word === 'everyone' || word === '') return '';
  return roleGroup(word);
}

/** One filter row: the words it offers, and which one is on. */
function usageFilter(attr: string, options: { word: string; label: string }[], current: string): HTMLElement {
  const row = el('div', { class: 'ubar' });
  for (const option of options) {
    row.append(el('button', { class: `ub${option.word === current ? ' on' : ''}`, [attr]: option.word, 'aria-pressed': String(option.word === current) }, option.label));
  }
  return row;
}

/**
 * The usage view: a fold in the agents column (#611). Each row is one agent, model and
 * day, with its tokens and what the same use would cost on the API. A row with no price
 * says "partial"; the note under the list says why and when the prices were checked.
 */
export function renderUsage(state: PageState, data: PageData): HTMLElement {
  const usage = data.usage;
  const box = el('div', { class: 'usage' });
  const cells = usage?.cells ?? [];
  box.append(foldHead(state, 'usage', cells.length ? cells.map((cell) => (cell.isPartial ? 'waiting' : 'done')) : []));
  if (state.ui.fold.usage) return box;
  if (!cells.length) {
    box.append(el('p', { class: 'quiet' }, say(state, 'usageEmpty')));
    return box;
  }
  const roleWord = state.ui.usageRole ?? '';
  const vendorWord = state.ui.usageVendor ?? '';
  const group = usageRoleGroup(roleWord);
  const vendors = [...new Set(cells.map((cell) => cell.vendor))];
  const shown = cells.filter((cell) => (!group || roleGroup(cell.role) === group) && (!vendorWord || cell.vendor === vendorWord));
  box.append(usageFilter('data-usage-role', [
    { word: '', label: say(state, 'usageAll') },
    { word: 'engineer', label: say(state, 'group.engineer') },
    { word: 'reviewer', label: say(state, 'group.reviewer') },
    { word: 'checker', label: say(state, 'usageChecker') },
  ], roleWord));
  if (vendors.length > 1) box.append(usageFilter('data-usage-vendor', [
    { word: '', label: say(state, 'usageAll') },
    ...vendors.map((vendor) => ({ word: vendor, label: vendor })),
  ], vendorWord));
  for (const cell of shown) {
    const total = cell.usd;
    box.append(el('div', { class: 'urow' },
      el('span', { class: 'uwho' }, `${cell.vendor} · ${cell.agent}`),
      el('span', { class: 'uday' }, cell.day || '—'),
      el('span', { class: 'utok' }, say(state, 'usageTokens', { input: usageTokens(state, cell.input), cached: usageTokens(state, cell.cached), output: usageTokens(state, cell.output) })),
      el('span', { class: `ucost${cell.isPartial ? ' partial' : ''}` }, usageCost(state, total, cell.isLocal))));
  }
  if (!shown.length) box.append(el('p', { class: 'quiet' }, say(state, 'usageEmpty')));
  const isPartial = shown.some((cell) => cell.isPartial);
  const usd = isPartial ? null : shown.reduce((sum, cell) => sum + (cell.usd ?? 0), 0);
  const isLocal = shown.length > 0 && shown.every((cell) => cell.isLocal);
  box.append(el('div', { class: 'utotal' },
    el('span', { class: 'uwho' }, say(state, 'usageTotal')),
    el('span', { class: 'utok' }, say(state, 'usageTokens', {
      input: usageTokens(state, shown.reduce((sum, cell) => sum + cell.input, 0)),
      cached: usageTokens(state, shown.reduce((sum, cell) => sum + cell.cached, 0)),
      output: usageTokens(state, shown.reduce((sum, cell) => sum + cell.output, 0)),
    })),
    el('span', { class: `ucost${isPartial ? ' partial' : ''}` }, usageCost(state, usd, isLocal))));
  for (const note of usage?.partial ?? []) box.append(el('p', { class: 'quiet' }, note));
  box.append(el('p', { class: 'quiet' }, say(state, 'usageHint')));
  box.append(el('p', { class: 'quiet' }, say(state, 'usagePrices', { date: usage?.checked ?? '' })));
  return box;
}

/** The usage functions, in the order page.ts writes them. */
export const USAGE_FUNCTIONS = [usageUsd, usageCost, usageTokens, usageRoleGroup, usageFilter, renderUsage];
