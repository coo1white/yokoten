// `yokoten init` writes the `tests` job for the project's language (#550, #653): the setup
// action pinned to a commit, the install step, and the runner. Node uses `npm test` when
// no earlier language matches and package.json has a real test script. It asks first, as
// install's writes do (record 0014), and says how to undo it. doctor stays read-only: it
// reads a project and advises, never writes.

import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Ask } from '../install.ts';
import { runsTests, scriptedRuns, testLanguages } from './test-commands.ts';

/** One language's CI job: the setup action pinned to a commit, its input, and the install step. */
export interface TestsJob {
  language: string;
  /** The setup action, as owner/name. */
  action: string;
  /** The version the pin points at, kept as the comment after it. */
  version: string;
  /** The full commit SHA the action is pinned to. */
  commit: string;
  /** The setup input that picks the toolchain, such as `go-version`. */
  input: string;
  inputValue: string;
  /** The command that installs what the tests need. */
  install: string;
}

/** The Node line `action.yml` sets up when a project names no version of its own. */
const KIT_NODE = '^22.23.4';
/** The command the Node tests job runs. The script body stays in package.json. */
const NODE_RUNNER = 'npm test';
/** `engines.node` may name a range. Anything else is not a version we can copy. */
const ENGINES_NODE = /^[0-9A-Za-z.^~<>=* |]+$/;
/** One version on the first line of `.nvmrc` or `.node-version`, with one leading `v` dropped. */
const VERSION_LINE = /^v?(\d+\.\d+(?:\.\d+)?)$/;

/**
 * Languages `yokoten init` can write a job for. The first six follow the order in
 * test-commands.ts. Node.js is last, and only when none of those six is found.
 * The Node pin is the same commit as action.yml.
 */
export const TESTS_JOBS: TestsJob[] = [
  { language: 'Go', action: 'actions/setup-go', version: 'v7.0.0', commit: 'b7ad1dad31e06c5925ef5d2fc7ad053ef454303e', input: 'go-version', inputValue: 'stable', install: 'go mod download' },
  { language: 'Python', action: 'actions/setup-python', version: 'v7.0.0', commit: '5fda3b95a4ea91299a34e894583c3862153e4b97', input: 'python-version', inputValue: '3.x', install: 'pip install pytest' },
  { language: 'Rust', action: 'dtolnay/rust-toolchain', version: 'v1', commit: '683b588c487a69d01f6c6ddf40f036ff682cc2c8', input: 'toolchain', inputValue: 'stable', install: 'cargo fetch' },
  { language: '.NET', action: 'actions/setup-dotnet', version: 'v6.0.0', commit: 'a98b56852c35b8e3190ac28c8c2271da59106c68', input: 'dotnet-version', inputValue: '10.x', install: 'dotnet restore' },
  { language: 'Ruby', action: 'ruby/setup-ruby', version: 'v1.332.0', commit: 'b1da4809b005e0178fe08a1d57317bffc00b7b4c', input: 'ruby-version', inputValue: '3.4', install: 'bundle install' },
  { language: 'PHP', action: 'shivammathur/setup-php', version: '2.40.0', commit: 'eb7c497e18156a6bbabfef1d3a82760b9eda3962', input: 'php-version', inputValue: '8.4', install: 'composer install' },
  { language: 'Node.js', action: 'actions/setup-node', version: 'v7.1.0', commit: '949feb2413d6458794dcd2491c4babbbce0c15c1', input: 'node-version', inputValue: KIT_NODE, install: 'npm ci' },
];

/** The pinned checkout step copied from the project's workflow. `note` is its version comment, or empty. */
export interface CheckoutStep {
  uses: string;
  note: string;
}

/** The `tests` job for one language, as YAML under `jobs:`. Every `uses:` is pinned. */
export const testsJobText = (job: TestsJob, runner: string, checkout: CheckoutStep): string =>
  [
    `  # Runs the ${job.language} tests.`,
    '  tests:',
    '    runs-on: ubuntu-latest',
    '    timeout-minutes: 10',
    '    permissions:',
    '      contents: read',
    '    steps:',
    `      - uses: ${checkout.uses}${checkout.note ? ` ${checkout.note}` : ''}`,
    '        with:',
    '          persist-credentials: false',
    `      - uses: ${job.action}@${job.commit} # ${job.version}`,
    '        with:',
    `          ${job.input}: ${job.inputValue}`,
    `      - run: ${job.install}`,
    `      - run: ${runner}`,
  ].join('\n');

/**
 * The `uses:` values in workflow text that name a remote action without a commit pin. A
 * local action (`./`, `/`) is not remote, so it is never listed. A tag or branch ref can
 * be moved, so only a full commit SHA counts as pinned.
 */
export const unpinnedUses = (text: string): string[] => {
  const found: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const uses = /^[ \t]*-[ \t]+uses:[ \t]*("?)([^"' \t]+)\1(?:[ \t]+#.*)?[ \t]*$/.exec(line)?.[2];
    if (!uses || uses.startsWith('./') || uses.startsWith('../') || uses.startsWith('/') || uses.includes('://')) continue;
    if (/^[^@\s]+@[0-9a-f]{40}$/.test(uses)) continue;
    found.push(uses);
  }
  return found;
};

/**
 * The workflow with `tests` added to the `needs` list of the `ci` job. Already there:
 * unchanged. No `ci` job, or a `needs` list that is not one line: null, so the caller
 * prints how to add it by hand instead of guessing.
 */
export const addTestsNeeds = (contents: string): string | null => {
  const lines = contents.split('\n');
  const ci = lines.findIndex((line) => /^  ci:[ \t]*(?:#.*)?$/.test(line));
  if (ci < 0) return null;
  for (let i = ci + 1; i < lines.length; i++) {
    const line = lines[i];
    if (/^  [^ \t#]/.test(line) || /^[^ \t\n]/.test(line)) return null;
    const needs = /^[ \t]*needs:[ \t]*\[([^\]]*)\][ \t]*(?:#.*)?$/.exec(line);
    if (!needs) continue;
    const names = needs[1].split(',').map((name) => name.trim()).filter(Boolean);
    if (names.includes('tests')) return contents;
    return [...lines.slice(0, i), `${/^[ \t]*/.exec(line)?.[0] ?? ''}needs: [${[...names, 'tests'].join(', ')}]`, ...lines.slice(i + 1)].join('\n');
  }
  return null;
};

/** The workflow with the job text before the `ci` job (past its comment block), or null with no `ci` job. */
const insertBeforeCi = (contents: string, jobText: string): string | null => {
  const lines = contents.split('\n');
  const ci = lines.findIndex((line) => /^  ci:[ \t]*(?:#.*)?$/.test(line));
  if (ci < 0) return null;
  let at = ci;
  while (at > 0 && /^  #/.test(lines[at - 1])) at--;
  const before = lines.slice(0, at);
  if (before.length && before[before.length - 1] !== '') before.push('');
  return [...before, jobText, '', ...lines.slice(at)].join('\n');
};

const readText = (path: string) => {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return '';
  }
};

// The package.json "test" script, as road.ts reads it: npm's placeholder is no command.
const testScript = (root: string): string => {
  try {
    const script = JSON.parse(readText(join(root, 'package.json')) || '{}')?.scripts?.test;
    return typeof script === 'string' && script.trim() && script.trim() !== 'echo "Error: no test specified" && exit 1' ? script.trim() : '';
  } catch {
    return '';
  }
};

// Whether the root holds a workspaces repo, as road.ts reads it.
const isWorkspaces = (root: string): boolean => {
  try {
    if (JSON.parse(readText(join(root, 'package.json')) || 'null')?.workspaces) return true;
  } catch {
    // No package.json to read: not workspaces by it.
  }
  return existsSync(join(root, 'pnpm-workspace.yaml'));
};

// Every workflow text joined, as road.ts reads it: a test command in any file counts.
const ciText = (root: string): string => {
  const dir = join(root, '.github', 'workflows');
  try {
    return readdirSync(dir).map((file) => readText(join(dir, file))).join('\n');
  } catch {
    return '';
  }
};

/** The pinned checkout step of the workflow, or null when it names none. */
const checkoutOf = (contents: string): CheckoutStep | null => {
  for (const line of contents.split(/\r?\n/)) {
    const match = /^[ \t]*-[ \t]+uses:[ \t]*("?)([^"' \t]+)\1(.*)$/.exec(line);
    if (!match || !match[2].startsWith('actions/checkout@')) continue;
    return { uses: match[2], note: /#[^\n]*/.exec(match[3])?.[0] ?? '' };
  }
  return null;
};

/** Whether an answer to a [Y/n] question is yes: Enter alone, y or yes, as install asks. */
const isYes = (answer: string | null): boolean => answer !== null && /^\s*(y|yes)?\s*$/i.test(answer);

const WORKFLOW = '.github/workflows/yokoten.yml';
/** A remote action pinned to a full commit. A tag or a branch can move, so neither counts. */
const isCommitPin = (uses: string) => /^[^@\s]+@[0-9a-f]{40}$/.test(uses);

/** The first line of a version file, or '' when the file is missing or the line is not a version. */
const versionFile = (root: string, name: string): string => VERSION_LINE.exec(readText(join(root, name)).split(/\r?\n/, 1)[0] ?? '')?.[1] ?? '';

/**
 * The `node-version` for setup-node: `engines.node`, else `.nvmrc`, else `.node-version`,
 * else the kit default.
 */
export const nodeVersion = (root: string): string => {
  try {
    const node = JSON.parse(readText(join(root, 'package.json')) || 'null')?.engines?.node;
    if (typeof node === 'string' && node.length <= 40 && ENGINES_NODE.test(node)) return node;
  } catch {
    // package.json is not JSON. A version file can still name one.
  }
  return versionFile(root, '.nvmrc') || versionFile(root, '.node-version') || KIT_NODE;
};

/** Node's version quoted, so `>=` and `22.10` stay text. The other jobs keep plain values. */
const quotedNodeJob = (job: TestsJob): TestsJob => (job.language === 'Node.js' ? { ...job, inputValue: JSON.stringify(job.inputValue) } : job);

const withNodeVersion = (job: TestsJob, root: string): TestsJob => (job.language === 'Node.js' ? { ...job, inputValue: nodeVersion(root) } : job);

/** The job init would write, or null when no covered language matches and there is no real test script. */
const pickedJob = (root: string): { job: TestsJob; runner: string } | null => {
  const found = testLanguages(root).find((named) => TESTS_JOBS.some((job) => job.language === named.language));
  if (found) {
    const job = TESTS_JOBS.find((named) => named.language === found.language);
    if (!job) return null;
    return { job: withNodeVersion(job, root), runner: job.language === 'Node.js' ? NODE_RUNNER : found.runner };
  }
  if (!testScript(root)) return null;
  const job = TESTS_JOBS.find((named) => named.language === 'Node.js');
  return job ? { job: withNodeVersion(job, root), runner: NODE_RUNNER } : null;
};

/**
 * One flow line for the Node tests job, copied from the workflow's pinned checkout.
 * Null when that pin is missing. The caller decides that the project is a Node project.
 */
export const nodeTestsLine = (root: string): string | null => {
  let contents = '';
  try {
    contents = readFileSync(join(root, WORKFLOW), 'utf8');
  } catch {
    return null;
  }
  const checkout = checkoutOf(contents);
  if (!checkout || !isCommitPin(checkout.uses)) return null;
  const job = TESTS_JOBS.find((named) => named.language === 'Node.js');
  if (!job) return null;
  const version = JSON.stringify(nodeVersion(root));
  const setup = `${job.action}@${job.commit}`;
  return `tests: {runs-on: ubuntu-latest, timeout-minutes: 10, steps: [{uses: ${checkout.uses}, with: {persist-credentials: false}}, {uses: ${setup}, with: {"${job.input}": ${version}}}, {run: ${job.install}}, {run: ${NODE_RUNNER}}]}`;
};

/**
 * The fix doctor shows for a Node project with a test script. Null when a language in
 * TESTS_JOBS comes first, or when there is no real test script. The line has no newline.
 */
export const nodeTestsFix = (root: string): string | null => {
  const picked = pickedJob(root);
  if (!picked || picked.job.language !== 'Node.js') return null;
  const line = nodeTestsLine(root);
  if (line) return `in ${WORKFLOW}, paste this under \`jobs:\`, then add \`tests\` to the \`needs\` list of \`ci\`: \`${line}\``;
  return `in ${WORKFLOW}, the checkout step is not pinned. Pin it, then run \`yokoten init\``;
};

/**
 * Write the `tests` job for the project's language into its workflow. Quiet (no lines)
 * when no covered language is found and package.json has no real test script. With `ask`
 * (a terminal), it asks once before it writes; without, it only says what it would do.
 * It never overwrites: a workflow that already runs the tests, or has a `tests` job of
 * its own, is kept. It copies the checkout step of the other jobs, and only when pinned.
 */
export function writeTestsJob(root: string, { ask }: { ask?: Ask } = {}): string[] {
  const picked = pickedJob(root);
  if (!picked) return [];
  const { job, runner } = picked;
  let contents: string;
  try {
    contents = readFileSync(join(root, WORKFLOW), 'utf8');
  } catch {
    return [`no ${WORKFLOW}; run \`yokoten init\` to add it, then run \`yokoten init\` again for the tests job`];
  }
  if (runsTests(ciText(root), testScript(root), isWorkspaces(root), scriptedRuns(root))) return [`kept ${WORKFLOW} (it already runs the tests)`];
  if (/^  tests:[ \t]*(?:#.*)?$/m.test(contents)) return [`kept ${WORKFLOW} (it has a tests job of its own)`];
  const checkout = checkoutOf(contents);
  if (!checkout) return [`left ${WORKFLOW} unchanged: it has no checkout step to copy; add the tests job under \`jobs:\` by hand, and add \`tests\` to the \`needs\` list of \`ci\``];
  if (!isCommitPin(checkout.uses))
    return [`left ${WORKFLOW} unchanged: its checkout step is not pinned to a commit (${checkout.uses}); pin it first, then run \`yokoten init\` again`];
  const jobText = testsJobText(quotedNodeJob(job), runner, checkout);
  const bad = unpinnedUses(jobText);
  if (bad.length) return [`did not write the tests job: ${bad.join(', ')} is not pinned to a commit`];
  const needs = addTestsNeeds(contents);
  const next = needs === null ? null : insertBeforeCi(needs, jobText);
  if (next === null) return [`left ${WORKFLOW} unchanged: add the tests job under \`jobs:\` by hand, and add \`tests\` to the \`needs\` list of \`ci\``];
  if (ask && isYes(ask(`Add a tests job for ${job.language} to ${WORKFLOW}? [Y/n]`))) {
    writeFileSync(join(root, WORKFLOW), next);
    return [`wrote the tests job for ${job.language} in ${WORKFLOW} (it runs \`${runner}\`); to undo, remove the \`tests\` job and remove \`tests\` from the \`needs\` list of \`ci\``];
  }
  if (ask) return [`left ${WORKFLOW} unchanged; to add the job later, run \`yokoten init\` on a terminal`];
  return [`would add a tests job for ${job.language} to ${WORKFLOW} (it runs \`${runner}\`); run \`yokoten init\` on a terminal to be asked, or add the job by hand and add \`tests\` to the \`needs\` list of \`ci\``];
}
