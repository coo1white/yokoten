// `yokoten adopt`: a first draft of the adoption table for an old project (record 0001,
// point 4). The user still decides every row; this only saves the first pass.
//
// Two parts. First the facts: what the project already does for each step on the road,
// read from files, with no model. Then the draft: a model proposes as-is, lighter or not
// now for each row, with a one-sentence reason. The model sees only the facts (short
// strings yokoten writes itself), never file contents. With no key, a bad answer or a
// failed call, a rule-based draft stands in, and the output says so.
//
//   files ──> facts ──> privacy check ──> model ──> valid answer? ──> table
//                            │ hit           │ fail        │ no
//                            └───────────────┴─────────────┴──> rule-based draft

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Env } from '../../rules/config.ts';
import { place } from '../../rules/message.ts';
import { loadMarks, scanText } from '../../rules/privacy.ts';
import { chat, KEY_HINT, type LlamaConfig, llamaConfig, type Message } from '../../agents/llama.ts';
import { findRulesGap } from '../init.ts';
import { orList, testLanguages } from './test-commands.ts';
import { type Found, gitConfig, hasIssueTemplate, hasPrTemplate, ROAD, road, securityLacking, todoFiles } from '../road.ts';

/** `unknown`: yokoten can't check the step from here (a server setting, in a session). */
export type Status = 'done' | 'missing' | 'partial' | 'unknown';
export type Decision = 'as-is' | 'lighter' | 'not-now';
export const DECISIONS: Decision[] = ['as-is', 'lighter', 'not-now'];

/** What the project does today for one step. `evidence` is short, and names files in the repo only. */
export interface Fact {
  key: string;
  status: Status;
  evidence: string;
  /** Why the step matters, from the road. */
  why: string;
}

export interface Row extends Fact {
  decision: Decision;
  reason: string;
}

export interface Draft {
  rows: Row[];
  /** Who drafted the decisions: the model (by name), or the rules. */
  by: string;
  /** Why the rules drafted it, when they did. */
  note?: string;
}

const read = (path: string) => {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return '';
  }
};
const has = (root: string, paths: string[]) => paths.filter((p) => existsSync(join(root, p)));
const packageJson = (root: string): Record<string, unknown> => {
  try {
    return JSON.parse(read(join(root, 'package.json'))) ?? {};
  } catch {
    return {};
  }
};
const listed = (dir: string) => {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
};

/** Commit hooks the project runs on its own, by tool name. */
function ownHooks(root: string, env: Env): string[] {
  const pkg = packageJson(root);
  const found: string[] = [];
  if (existsSync(join(root, '.husky')) || 'husky' in pkg) found.push('husky');
  if (has(root, ['lefthook.yml', 'lefthook.yaml', '.lefthook.yml', '.lefthook.yaml']).length) found.push('lefthook');
  if (has(root, ['.pre-commit-config.yaml', '.pre-commit-config.yml']).length) found.push('pre-commit');
  if ('simple-git-hooks' in pkg) found.push('simple-git-hooks');
  const hooksPath = gitConfig(root, 'core.hooksPath', env);
  if (!found.length && hooksPath) found.push('core.hooksPath');
  if (!found.length && existsSync(join(root, '.githooks', 'pre-commit'))) found.push('.githooks/pre-commit');
  return found;
}

/** CI the project has, other than yokoten's. */
function ownCi(root: string): string[] {
  const workflows = listed(join(root, '.github', 'workflows')).filter((f) => /\.ya?ml$/.test(f));
  return [
    ...(workflows.length ? [`${workflows.length} workflow(s) in .github/workflows`] : []),
    ...has(root, ['.gitlab-ci.yml', '.circleci', 'Jenkinsfile', '.gitea/workflows', '.forgejo/workflows', 'azure-pipelines.yml']),
  ];
}

/** A test command the project has, said in a few words; empty when none is found. */
function testCommand(root: string): string {
  const scripts = packageJson(root).scripts as Record<string, unknown> | undefined;
  const test = typeof scripts?.test === 'string' ? scripts.test : '';
  // npm init writes a test script that only fails.
  if (test && !/no test specified/.test(test)) return 'package.json has a test script';
  // The same table as doctor's tests step, so both name the same command.
  const found = testLanguages(root);
  return found.length ? `${orList(found.map((l) => l.runner))} (${found.map((l) => l.language).join(', ')})` : '';
}

const TESTS_WHY = 'a test command lets an agent check its own work before you read it';

/**
 * What the project does today, one row per step on the road, plus a test command. Reads
 * files only: no model, no network, no change to anything.
 */
export function facts(root: string, env: Env): Fact[] {
  const found = new Map(road(root, env).map((r) => [r.step.key, r.found]));
  const step = (key: string) => ROAD.find((s) => s.key === key);
  const rows: Fact[] = [];
  const add = (key: string, status: Status, evidence: string) => rows.push({ key, status, evidence, why: step(key)?.why ?? TESTS_WHY });
  const plain = (key: string, done: string, missing: string, f: Found = found.get(key) ?? null) =>
    add(key, f ? 'done' : f === null ? 'unknown' : 'missing', f ? done : f === null ? "yokoten can't check this here; `yokoten doctor` reads it" : missing);

  const ruleFiles = has(root, ['CLAUDE.md', '.claude/CLAUDE.md', 'CONTRIBUTING.md', '.github/CONTRIBUTING.md', '.cursorrules', '.github/copilot-instructions.md', 'GEMINI.md']);
  if (found.get('rules')) add('rules', 'done', 'AGENTS.md');
  else if (existsSync(join(root, 'AGENTS.md'))) add('rules', 'partial', `AGENTS.md, but ${findRulesGap(root)?.file ?? 'CLAUDE.md'} does not import it, so Claude Code does not read it`);
  else add('rules', ruleFiles.length ? 'partial' : 'missing', ruleFiles.length ? `no AGENTS.md, but ${ruleFiles.join(', ')}` : 'no AGENTS.md or other written rules');

  plain('tool-hook', 'the tool-call guard is in .claude/settings.json', 'no tool-call guard');

  const hooks = ownHooks(root, env);
  if (found.get('commit-check')) add('commit-check', 'done', 'commits run `yokoten check`');
  else add('commit-check', hooks.length ? 'partial' : 'missing', hooks.length ? `commits run the project's own hooks (${hooks.join(', ')}), not \`yokoten check\`` : 'no commit hook');

  plain('runtime', '.yokoten/ is this version', existsSync(join(root, '.yokoten')) ? '.yokoten/ is another version' : 'no .yokoten/ runtime');

  const tests = testCommand(root);
  add('tests', tests ? 'done' : 'missing', tests || 'no test command found (package.json, Makefile or a project file such as go.mod)');

  const ci = ownCi(root);
  if (found.get('ci')) add('ci', 'done', 'CI runs `yokoten check`');
  else add('ci', ci.length ? 'partial' : 'missing', ci.length ? `CI exists (${ci.join(', ')}), but does not run \`yokoten check\`` : 'no CI');

  const todos = todoFiles(root);
  add('issues', todos.length ? 'missing' : 'done', todos.length ? `a todo file (${todos.join(', ')})` : 'no todo file');

  const templates = [hasIssueTemplate(root) && 'issue templates', hasPrTemplate(root) && 'a pull request template'].filter((t): t is string => Boolean(t));
  add('templates', templates.length === 2 ? 'done' : templates.length ? 'partial' : 'missing', templates.length ? `has ${templates.join(' and ')}` : 'no issue or pull request templates');

  if (found.get('changelog')) add('changelog', 'done', 'CHANGELOG.md with an Unreleased section');
  else add('changelog', existsSync(join(root, 'CHANGELOG.md')) ? 'partial' : 'missing', existsSync(join(root, 'CHANGELOG.md')) ? 'CHANGELOG.md, with no Unreleased section' : 'no CHANGELOG.md');

  const commitlint = listed(root).filter((f) => /^(\.commitlintrc|commitlint\.config\.)/.test(f));
  if (found.get('titles')) add('titles', 'done', 'CI runs `yokoten check --pr`');
  else add('titles', commitlint.length ? 'partial' : 'missing', commitlint.length ? `commit messages are checked (${commitlint[0]}), pull request titles are not` : 'nothing checks pull request titles');

  plain('codeowners', 'a CODEOWNERS file', 'no CODEOWNERS file');
  plain('bot', 'a bot is set up on this machine', 'no bot on this machine');
  plain('skills', 'the yokoten skills are installed on this machine', 'the yokoten skills are not installed on this machine');

  const lacking = securityLacking(root);
  add('security-files', lacking.length === 0 ? 'done' : lacking.length < 3 ? 'partial' : 'missing', lacking.length ? `no ${lacking.join(', no ')}` : 'a security policy, Dependabot and a license');

  // A step with no reading of its own above gets a row from its own check and words, so a
  // step added to the road later is never left out of the draft.
  for (const other of ROAD.filter((s) => !rows.some((row) => row.key === s.key))) {
    plain(other.key, "yokoten's check for this step passes", found.get(other.key) === false ? other.what(root, env, undefined) : '');
  }
  const order = (key: string) => ROAD.findIndex((s) => s.key === key);
  return rows.sort((first, second) => order(first.key) - order(second.key));
}

const sentence = (text: string) => `${text[0].toUpperCase()}${text.slice(1)}.`;

/** The draft with no model: done or missing is as-is, partial is lighter, unknown is as-is once checked. */
export function ruleDraft(rows: Fact[]): Row[] {
  return rows.map((f) => ({
    ...f,
    decision: f.status === 'partial' ? 'lighter' : 'as-is',
    reason: f.status === 'done' ? 'The project already does this; keep it as it is.' : f.status === 'partial' ? 'The project has its own way; keep it and add only the missing part.' : f.status === 'unknown' ? 'Run `yokoten doctor` to see whether the project already does this.' : sentence(f.why),
  }));
}

const SYSTEM = [
  'You help a developer adopt yokoten, a kit of working practices for AI coding agents, in an existing project.',
  'You get one row per practice: its key, what the project does today (done, missing, partial, or unknown when yokoten could not check it), short evidence, and why the practice matters.',
  'For every row, propose one decision. "as-is": take the practice as yokoten has it. "lighter": take a smaller form; say what is left out. "not-now": leave it out; say when to look again.',
  'Give a reason in one plain English sentence of at most 25 words.',
  'For an unknown row, do not say the practice is missing: say to check it with `yokoten doctor` first.',
  'Keep what the project already does well. Do not propose not-now for a safety practice without a strong reason.',
  'Answer with JSON only: {"rows":[{"key":"...","decision":"as-is|lighter|not-now","reason":"..."}]}, one entry per row, every key once.',
].join('\n');

/** The messages sent to the model. Only the facts go in: no file contents, no paths outside the repo. */
export function prompt(rows: Fact[]): Message[] {
  return [
    { role: 'system', content: SYSTEM },
    { role: 'user', content: JSON.stringify({ rows: rows.map(({ key, status, evidence, why }) => ({ key, status, evidence, why })) }, null, 1) },
  ];
}

/** The JSON Schema the answer must match. */
export function answerSchema(rows: Fact[]): object {
  return {
    type: 'object',
    properties: {
      rows: {
        type: 'array',
        items: {
          type: 'object',
          properties: { key: { type: 'string', enum: rows.map((r) => r.key) }, decision: { type: 'string', enum: DECISIONS }, reason: { type: 'string' } },
          required: ['key', 'decision', 'reason'],
          additionalProperties: false,
        },
      },
    },
    required: ['rows'],
    additionalProperties: false,
  };
}

/**
 * Why the messages must not be sent: the privacy check's findings (an email, an IP, a
 * secret, a private mark), and any path in the home folder. Empty when they may go.
 */
export function promptProblems(messages: Message[], env: Env): string[] {
  const text = messages.map((m) => m.content).join('\n');
  let marks: string[] = [];
  try {
    marks = loadMarks(env);
  } catch {
    // An unreadable marks file: the patterns still run.
  }
  const problems = scanText(text, { file: 'prompt', marks }).map((found) => `${place(found)}${found.what}`);
  const home = (env.HOME ?? '').replace(/[\\/]+$/, '');
  if ((home.length > 1 && text.includes(home)) || /(^|[\s"'(])(\/(home|Users)\/|[A-Za-z]:\\)/.test(text)) problems.push('prompt: a path outside the repo.');
  return problems;
}

const MAX_REASON = 300;

/**
 * The model's answer as rows, or why it is not valid. Valid means: a JSON object with a
 * `rows` array, every fact's key exactly once and no other, a known decision, and a
 * one-line reason. A code fence around the JSON is allowed; anything else is not.
 */
export function parseAnswer(content: string, rows: Fact[]): { rows: Row[] } | { error: string } {
  const text = content.trim().replace(/^```(?:json)?\s*\n([\s\S]*)\n```$/, '$1');
  let answer: unknown;
  try {
    answer = JSON.parse(text);
  } catch {
    return { error: 'not JSON' };
  }
  const list = (answer as { rows?: unknown })?.rows;
  if (typeof answer !== 'object' || answer === null || Array.isArray(answer) || !Array.isArray(list)) return { error: 'no "rows" list' };
  if (Object.keys(answer).length !== 1) return { error: 'keys other than "rows"' };
  const byKey = new Map<string, { decision: Decision; reason: string }>();
  for (const item of list) {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) return { error: 'a row is not an object' };
    const { key, decision, reason, ...rest } = item as Record<string, unknown>;
    if (Object.keys(rest).length) return { error: `a row has unknown fields (${Object.keys(rest).join(', ')})` };
    if (typeof key !== 'string' || !rows.some((r) => r.key === key)) return { error: `an unknown key (${String(key).slice(0, 40)})` };
    if (byKey.has(key)) return { error: `the key ${key} twice` };
    if (typeof decision !== 'string' || !DECISIONS.includes(decision as Decision)) return { error: `${key}: an unknown decision` };
    if (typeof reason !== 'string' || !reason.trim() || reason.length > MAX_REASON || /[\r\n]/.test(reason)) return { error: `${key}: the reason is not one line of text` };
    byKey.set(key, { decision: decision as Decision, reason: reason.trim() });
  }
  const lacking = rows.filter((r) => !byKey.has(r.key)).map((r) => r.key);
  if (lacking.length) return { error: `no decision for ${lacking.join(', ')}` };
  return { rows: rows.map((r) => ({ ...r, ...(byKey.get(r.key) as { decision: Decision; reason: string }) })) };
}

export type Chat = (config: LlamaConfig, messages: Message[], options: { schema?: object; timeoutMs?: number }) => Promise<string>;

/** The draft: from the model when it can, from the rules when it can't, and why. */
export async function draft(rows: Fact[], { env, send = chat, timeoutMs }: { env: Env; send?: Chat; timeoutMs?: number }): Promise<Draft> {
  const byRules = (note: string): Draft => ({ rows: ruleDraft(rows), by: 'rules', note });
  const config = llamaConfig(env);
  if (!config) return byRules(`no model key; ${KEY_HINT}`);
  const messages = prompt(rows);
  const problems = promptProblems(messages, env);
  if (problems.length) return byRules(`nothing was sent: the facts hold something private (${problems.length} finding(s)); run \`yokoten check\``);
  let content: string;
  try {
    content = await send(config, messages, { schema: answerSchema(rows), timeoutMs });
  } catch (err) {
    return byRules(`the model call failed: ${(err as Error).message}`);
  }
  const answer = parseAnswer(content, rows);
  if ('error' in answer) return byRules(`the model's answer was not valid (${answer.error})`);
  return { rows: answer.rows, by: `the model (${config.model})` };
}

// A cell in a Markdown table: a backslash first, then a pipe, so neither can end the cell.
const cell = (text: string) => text.replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/\s+/g, ' ');

/** The one line that says who decides. */
export const YOU_DECIDE = 'This is a draft. You decide every row: as-is, lighter, or not now with a reason and when to look again.';

/** The draft as a Markdown table, with who drafted it and who decides. */
export function table(d: Draft): string[] {
  return [
    '| Practice | The project today | Draft | Why |',
    '|----------|-------------------|-------|-----|',
    ...d.rows.map((r) => `| ${r.key} | ${r.status}: ${cell(r.evidence)} | ${r.decision} | ${cell(r.reason)} |`),
    '',
    d.by === 'rules' ? `Drafted by rules (done, missing or unknown: as-is; partial: lighter), because ${d.note}.` : `Drafted by ${d.by}.`,
    YOU_DECIDE,
  ];
}
