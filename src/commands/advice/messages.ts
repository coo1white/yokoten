// `yokoten msg`: agents of every vendor message each other (#674). Files on this machine,
// no server and no network. The rules are in src/agents/desk/team/.

import { hideHome } from '../../rules/privacy.ts';
import { deliveryText, messageProblem, senderLine, wrapMessage } from '../../agents/desk/team/deliver.ts';
import { appendMessage, changedSinceRead, keepReadState, loadReadState, outboxNames, readOutbox, sendProblem, unread } from '../../agents/desk/team/outbox.ts';
import { LEAD, makeTeam, readRoster } from '../../agents/desk/team/team.ts';
import { type Me, whoAmI } from '../../agents/desk/team/who.ts';
import { type Invocation, parse, print, readInput, rootOf, usage } from '../shared.ts';

/** How many unread messages `msg inbox` shows at once. */
const INBOX_MAX = 50;

export function runMsg(invocation: Invocation): number {
  const options = parse('msg', invocation.args);
  if (typeof options === 'string') return usage(invocation, options);
  const [action, to, text] = options.positional;
  const fail = (line: string) => {
    print(invocation, [`yokoten msg: ${line}`], invocation.stderr);
    return 1;
  };
  if (!action || !['send', 'inbox', 'who', 'log'].includes(action)) return usage(invocation, 'say what to do: yokoten msg send <to> <text>, inbox, who or log');
  const me = whoAmI(invocation.cwd, invocation.env);
  if ('refuse' in me) return fail(me.refuse);
  if (!me.inDesk) makeTeam(me.team);
  if (action === 'send') {
    if (!to) return usage(invocation, 'name who it goes to: yokoten msg send <to> <text>');
    return send(invocation, me, to, text ?? readInput(invocation.stdin), fail);
  }
  if (to !== undefined) return usage(invocation, `unexpected argument ${to}`);
  if (action === 'inbox') {
    const found = unread(me, INBOX_MAX);
    const shown = deliveryText(found.messages, found.problems, found.waiting, me, invocation.env, rootOf(invocation.cwd, invocation.env));
    keepReadState(me, found.state);
    print(invocation, [shown || `yokoten msg: no new messages for ${me.name}.`]);
    return 0;
  }
  if (action === 'who') return who(invocation, me);
  return log(invocation, me, fail);
}

function send(invocation: Invocation, me: Me, to: string, raw: string, fail: (line: string) => number): number {
  const text = hideHome(raw.replace(/\s+$/, ''), invocation.env);
  const problem = messageProblem(text, invocation.env, rootOf(invocation.cwd, invocation.env));
  if (problem) return fail(`not sent: the message holds ${problem.what}. Fix: ${problem.fix}, then send it again.`);
  const capped = sendProblem(me, to, text, new Date());
  if (capped) return fail(`not sent: ${capped}.`);
  const sent = appendMessage(me, to, text, new Date());
  print(invocation, [`yokoten msg: sent ${sent.messageId} to ${to}. The lead and the owner can read every message (\`yokoten msg log\`).`]);
  return 0;
}

function who(invocation: Invocation, me: Me): number {
  const roster = readRoster(me.team);
  const lines = [`yokoten msg: you are ${me.name}. The team:`, `- ${senderLine(LEAD, roster)}`];
  for (const name of roster.keys()) lines.push(`- ${senderLine(name, roster)}`);
  if (!roster.size) lines.push('No desk has joined yet: `yokoten desk` adds each agent.');
  print(invocation, lines);
  return 0;
}

/** Every message on the team, for the lead and the owner. A message that fails the privacy scan is withheld here too. */
function log(invocation: Invocation, me: Me, fail: (line: string) => number): number {
  if (me.name !== LEAD || me.inDesk) return fail('only the lead reads the whole log. Run `yokoten msg inbox` for your own messages.');
  const roster = readRoster(me.team);
  const seen = loadReadState(me.readState);
  const root = rootOf(invocation.cwd, invocation.env);
  const all: { time: string; lines: string[] }[] = [];
  const problems: string[] = [];
  for (const name of outboxNames(me.team)) {
    const outbox = readOutbox(me.team, name);
    problems.push(...outbox.problems);
    const changed = name === LEAD ? null : changedSinceRead(outbox, seen[name]);
    if (changed) problems.push(changed);
    for (const message of outbox.messages) {
      const [head, ...rest] = wrapMessage(message, roster, invocation.env, root);
      all.push({ time: message.time, lines: [head.replace(/ ---$/, ` to ${message.to} ---`), ...rest] });
    }
  }
  all.sort((a, b) => (a.time < b.time ? -1 : a.time > b.time ? 1 : 0));
  const lines = all.length ? [`yokoten msg: ${all.length} message(s) on the team, oldest first.`] : ['yokoten msg: no messages on the team yet.'];
  for (const entry of all) lines.push(...entry.lines);
  for (const problem of problems) lines.push(`yokoten msg: warning: ${problem}.`);
  print(invocation, lines);
  return 0;
}
