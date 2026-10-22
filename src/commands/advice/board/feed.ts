// Each agent's recent steps on the board (#603). The board keeps them in memory while it
// runs: each read compares an agent with the last one, and a change becomes a step.
// Nothing is written to disk; a restarted board starts each feed from what the agent says now.

import type { AgentView } from './view.ts';

/** The most steps the board keeps for one agent. */
export const FEED_LIMIT = 50;

/**
 * One step in an agent's feed. `step` and `pass` are routine, and the page folds a run of
 * them; `wait`, `fail` and `done` never fold, so the owner always sees them.
 */
export interface FeedEvent {
  kind: 'step' | 'pass' | 'wait' | 'fail' | 'done';
  text: string;
  /** When the board saw it. */
  time: string;
}

/** The feeds by agent key, and the last view of each agent to compare with. */
export interface FeedStore {
  feeds: Map<string, FeedEvent[]>;
  last: Map<string, AgentView>;
}

export function makeFeedStore(): FeedStore {
  return { feeds: new Map(), last: new Map() };
}

/** The steps one agent's change makes: what it does now, then its checks and its state. */
function changesOf(before: AgentView | undefined, now: AgentView): Omit<FeedEvent, 'time'>[] {
  const events: Omit<FeedEvent, 'time'>[] = [];
  if (now.doing && now.doing !== before?.doing) events.push({ kind: 'step', text: now.doing });
  if (now.checks && now.checks !== before?.checks) {
    events.push(now.checks === 'failing' ? { kind: 'fail', text: 'Checks failed at its last stop' } : { kind: 'pass', text: 'Checks passed' });
  }
  if (now.dot !== before?.dot && before !== undefined) {
    if (now.dot === 'waiting') events.push({ kind: 'wait', text: 'Waiting for you' });
    if (now.dot === 'done') events.push({ kind: 'done', text: 'Finished' });
  }
  return events;
}

/** Add each agent's changes to its feed, keep at most FEED_LIMIT steps, and drop the feeds of agents that left. */
export function recordFeed(store: FeedStore, agents: AgentView[], time: string): void {
  const present = new Set(agents.map((agent) => agent.key));
  for (const key of [...store.feeds.keys()]) {
    if (!present.has(key)) {
      store.feeds.delete(key);
      store.last.delete(key);
    }
  }
  for (const agent of agents) {
    const events = changesOf(store.last.get(agent.key), agent).map((event) => ({ ...event, time }));
    store.last.set(agent.key, agent);
    if (!events.length) continue;
    const feed = [...(store.feeds.get(agent.key) ?? []), ...events];
    store.feeds.set(agent.key, feed.slice(-FEED_LIMIT));
  }
}

/** The feeds as a plain object for /data. */
export function feedsJson(store: FeedStore): Record<string, FeedEvent[]> {
  return Object.fromEntries(store.feeds);
}
