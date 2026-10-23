/// <reference lib="dom" />
// The board page's right side (#603, #693): open pull requests, what merged today,
// and the board's own controls. The page does not mount this column (#737).

import type { BoardIssue, BoardLimits, BoardRun } from '../controls.ts';
import type { PullView } from '../view.ts';
import { el, foldHead, icon, localDay, say, type PageData, type PageState } from './browser/script.ts';

function pullCard(state: PageState, pull: PullView): HTMLElement {
  const steps = el('div', { class: 'steps' }, ...pull.steps.map((mark, index) => el('i', { class: mark, title: say(state, `step.${index}`) })));
  const title = el('span', { class: 'nm' }, el('span', { class: 'num' }, `#${pull.number}`), ` ${pull.title}`);
  return el('div', { class: 'pr' },
    el('div', { class: 'h' }, el('span', { class: 'open-i' }, icon('pr')), /^https?:\/\//i.test(pull.url) ? el('a', { href: pull.url, target: '_blank', rel: 'noopener noreferrer', class: 'grow' }, title) : el('div', { class: 'grow' }, title), pull.tier ? el('span', { class: `tier t${pull.tier}` }, say(state, 'tier', { tier: pull.tier })) : null),
    steps, el('div', { class: 'sl' }, el('span', { class: pull.tone }, say(state, `pull.${pull.status}`)), el('span', { class: 'mut' }, pull.branch)));
}

/** One labelled field of the start and limits forms. */
function field(label: string, input: HTMLElement): HTMLElement {
  return el('div', { class: 'fld' }, el('label', {}, label, input));
}

/** The form that starts an agent: the issue from the open list, the vendor, and the model. */
export function renderStart(state: PageState, issues: BoardIssue[] | string): HTMLElement {
  const box = el('div', {});
  box.append(el('h2', { class: 'sh' }, icon('term'), say(state, 'startAgent')));
  const rows = typeof issues === 'string' ? [] : issues;
  const issue = el('input', { id: 'start-issue', name: 'issue', inputmode: 'numeric', ...(rows.length ? { list: 'start-issues' } : {}) });
  const vendor = el('select', { id: 'start-vendor', name: 'vendor' }, ...['claude-code', 'codex', 'muse', 'grok', 'antigravity', 'deepseek-harness'].map((name) => el('option', { value: name }, name)));
  const model = el('input', { id: 'start-model', name: 'model', placeholder: say(state, 'modelName') });
  box.append(field(say(state, 'issueNumber'), issue));
  if (rows.length) box.append(el('datalist', { id: 'start-issues' }, ...rows.map((row) => el('option', { value: String(row.number) }, `#${row.number} ${row.title}`))));
  else if (typeof issues === 'string') box.append(el('p', { class: 'quiet' }, issues));
  box.append(field(say(state, 'vendorName'), vendor));
  box.append(field(say(state, 'modelName'), model));
  box.append(el('p', {}, el('button', { class: 'hbtn', 'data-start': '1' }, say(state, 'startNow'))));
  box.append(el('p', { class: 'quiet', id: 'start-note' }, ''));
  return box;
}

/** The form that sets the limits: how many agents run at once, and how many of one model. */
export function renderLimits(state: PageState, limits: BoardLimits): HTMLElement {
  const box = el('div', {});
  box.append(el('h2', { class: 'sh' }, icon('lock'), say(state, 'limitsTitle')));
  const caps = Object.keys(limits.byModel).map((name) => `${name}: ${limits.byModel[name]}`).join(', ');
  box.append(el('p', { class: 'quiet' }, say(state, 'limitsNow', { max: limits.maxAgents }) + (caps ? ` · ${say(state, 'limitsModels', { models: caps })}` : '')));
  box.append(field(say(state, 'maxAgents'), el('input', { id: 'limits-max', name: 'maxAgents', inputmode: 'numeric', value: String(limits.maxAgents) })));
  box.append(field(say(state, 'modelsPaired'), el('input', { id: 'limits-models', name: 'models', value: caps })));
  box.append(el('p', {}, el('button', { class: 'hbtn', 'data-limits': '1' }, say(state, 'saveNow'))));
  box.append(el('p', { class: 'quiet', id: 'limits-note' }, ''));
  return box;
}

/** One agent the board started, with a stop button while it runs. */
function runCard(state: PageState, run: BoardRun): HTMLElement {
  const status = run.status === 'running' ? say(state, 'runRunning') : run.stoppedBy === 'time limit' ? say(state, 'runLimited') : say(state, 'runStopped');
  return el('div', { class: 'pr' },
    el('p', {}, `${run.name} · ${run.vendor} · ${run.model} · issue ${run.issue} · ${status}`),
    run.worktree ? el('p', { class: 'mut' }, run.worktree) : null,
    run.status === 'running' ? el('p', {}, el('button', { class: 'hbtn', 'data-stop': run.name }, icon('x', true), say(state, 'stopNow'))) : null);
}

/** The agents the board started. */
export function renderRuns(state: PageState, runs: BoardRun[]): HTMLElement {
  const box = el('div', {});
  box.append(el('h2', { class: 'sh' }, icon('term'), say(state, 'startedHere'), el('span', { class: 'n' }, String(runs.length))));
  if (!runs.length) box.append(el('p', { class: 'quiet' }, say(state, 'noStarted')));
  else box.append(...runs.map((run) => runCard(state, run)));
  box.append(el('p', { class: 'quiet', id: 'runs-note' }, ''));
  return box;
}

/** The latest output of the agents the board started. */
export function renderOutput(state: PageState, runs: BoardRun[]): HTMLElement {
  const box = el('div', {});
  box.append(el('h2', { class: 'sh' }, icon('msg'), say(state, 'latestOutput')));
  if (!runs.length) box.append(el('p', { class: 'quiet' }, say(state, 'noOutput')));
  else {
    for (const run of runs) {
      box.append(el('div', { class: 'pr' }, el('p', {}, run.name), el('pre', { class: 'out' }, run.output.length ? run.output.join('\n') : say(state, 'noOutput'))));
    }
  }
  return box;
}

/**
 * A note on the GitHub lists, or '' (#688): "reading GitHub" before the first read
 * finishes, and when they were read after a read failed.
 */
export function githubNote(state: PageState, data: PageData, now: number): string {
  const github = data.github;
  if (!github || !data.repoUrl) return '';
  if (!github.readAt && !github.failed) return say(state, 'readingGitHub');
  if (!github.readAt || !github.failed) return '';
  return say(state, 'githubOld', { n: Math.max(1, Math.floor((now - Date.parse(github.readAt)) / 60000)) });
}

/** Open pull requests, what merged today, and the board's own controls. The page does not mount this (#737). */
export function renderRight(state: PageState, data: PageData, now: number): HTMLElement {
  const box = el('div', {});
  const pulls = typeof data.pulls === 'string' ? [] : data.pulls;
  const note = githubNote(state, data, now);
  // Before the first read, the lists say only that GitHub is being read, in the page's language.
  const isFirstRead = note !== '' && !data.github?.readAt && !data.github?.failed;
  box.append(foldHead(state, 'pulls', pulls.map((pull) => (pull.tone === 'fail' ? 'failing' : pull.tone === 'ok' ? 'ready' : 'moving'))));
  if (!state.ui.fold.pulls) {
    if (note && !isFirstRead) box.append(el('p', { class: 'quiet' }, note));
    if (isFirstRead) box.append(el('p', { class: 'quiet', role: 'status' }, note));
    else if (typeof data.pulls === 'string') box.append(el('p', { class: 'quiet' }, data.repoUrl ? data.pulls : say(state, 'noRemote')));
    else if (!pulls.length) box.append(el('p', { class: 'quiet' }, say(state, 'noPulls')));
    else box.append(...pulls.map((pull) => pullCard(state, pull)));
  }
  const today = localDay(now);
  const merged = data.merged.filter((pull) => localDay(Date.parse(pull.mergedAt)) === today);
  if (merged.length && state.ui.mergedCleared !== today) {
    box.append(foldHead(state, 'mergedToday', merged.map(() => 'merged'), el('button', { class: 'act', 'data-clear-merged': '1', title: say(state, 'hideTillTomorrow') }, say(state, 'clear'))));
    if (!state.ui.fold.mergedToday) box.append(...merged.map((pull) => el('div', { class: 'mrow' }, icon('merge', true), el('span', { class: 'num' }, `#${pull.number}`), pull.title)));
  }
  box.append(renderStart(state, isFirstRead ? note : data.issues));
  box.append(renderLimits(state, data.limits));
  box.append(renderRuns(state, data.runs));
  box.append(renderOutput(state, data.runs));
  return box;
}

/** The bar at the bottom: free seats, or idle agents when no seats file is set (#698). */
export function renderBar(state: PageState, data: PageData): HTMLElement[] {
  const vendors = new Map<string, { name: string; color: string; count: number; working: number; idle: number }>();
  for (const agent of data.agents) {
    if (agent.dot === 'done') continue;
    const name = agent.vendor.name;
    const seen = vendors.get(name) ?? { name, color: agent.vendor.color, count: 0, working: 0, idle: 0 };
    seen.count += 1;
    if (agent.isLive) seen.working += 1;
    else seen.idle += 1;
    vendors.set(name, seen);
  }
  const seats = data.seats ?? null;
  let free = 0;
  if (seats) {
    const used = new Set<string>();
    for (const seen of vendors.values()) {
      const key = seen.name.toLowerCase();
      used.add(key);
      free += Math.max(0, (seats[key] ?? 0) - seen.working);
    }
    for (const [key, count] of Object.entries(seats)) if (!used.has(key)) free += count;
  }
  const idle = [...vendors.values()].reduce((sum, seen) => sum + seen.idle, 0);
  const parts: HTMLElement[] = [el('span', {}, icon('shield', true), say(state, 'oneRuleSet', { n: vendors.size }))];
  parts.push(el('span', {}, say(state, seats ? 'barFree' : 'barIdle', { n: seats ? free : idle })));
  for (const seen of vendors.values()) {
    const mark = el('span', { class: seen.working > 0 ? 'vm live' : 'vm' });
    mark.style.background = seen.color;
    const key = seen.name.toLowerCase();
    const text = seats
      ? say(state, 'barSeats', { name: seen.name, working: seen.working, free: Math.max(0, (seats[key] ?? 0) - seen.working) })
      : say(state, 'barOpen', { name: seen.name, n: seen.count, idle: seen.idle });
    parts.push(el('span', {}, mark, text));
  }
  parts.push(el('span', { class: 'sp' }), el('span', {}, icon('lock', true), say(state, 'local')));
  return parts;
}

/** The right side's functions, in the order the page writes them. */
export const RIGHT_FUNCTIONS = [pullCard, field, renderStart, renderLimits, runCard, renderRuns, renderOutput, githubNote, renderRight, renderBar];
