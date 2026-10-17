// `yokoten explain <id>`: for a person who asks "why?", and for an agent that has to
// explain a finding. Every finding's id is here: a rule a check or a guard holds, or a
// step on the road.

import { RULES, type RuleId } from '../rules/message.ts';
import { ROAD, STAGES } from './road.ts';

/** What `explain --json` prints for a known id. */
export interface Explained {
  id: string;
  kind: 'rule' | 'step';
  /** The rule, or for a step, where it sits on the road. */
  what: string;
  why: string;
  /** How yokoten checks it. */
  check: string;
  stage?: number;
  standard?: string;
}

/** Every id `explain` knows: the rules first, then the road's steps in order. */
export const ids = (): string[] => [...Object.keys(RULES), ...ROAD.map((s) => s.key)];

/** The rule or step with this id, or null. */
export function explain(id: string): Explained | null {
  if (Object.hasOwn(RULES, id)) {
    const r = RULES[id as RuleId];
    return { id, kind: 'rule', what: r.rule, why: r.why, check: r.check };
  }
  const step = ROAD.find((s) => s.key === id);
  if (!step) return null;
  const e: Explained = { id, kind: 'step', what: `a step on the road: stage ${step.stage} of ${STAGES.length}, ${STAGES[step.stage - 1]}`, why: step.why, check: step.how, stage: step.stage };
  if (step.standard) e.standard = step.standard;
  return e;
}

/** The text form: the id and what it is, then why, how it is checked, and any standard. */
export const explainLines = (e: Explained): string[] => [
  `${e.id}: ${e.what}.`,
  `Why: ${e.why}.`,
  `Check: ${e.check}.`,
  ...(e.standard ? [`Standard: ${e.standard}.`] : []),
];
