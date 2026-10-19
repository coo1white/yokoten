#!/usr/bin/env node
// yokoten: carry what one project learned into every project.

import { execFileSync, spawnSync } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { DEFAULTS, loadConfig } from '../src/rules/config.ts';
import { annotations, botConfig, botEnv, ghIn, installationToken, isGitHubActions, readCodeOwners, readCommandTitle, readIssue, readPullRequest, repoOf, stepSummary } from '../src/host/github.ts';
import { formatChanges, parseChange, readChanges, writeChanges } from '../src/run/changelog.ts';
import { check, checkChanged, checkHistory, gitRoot, historyTimeZones, timeZoneNote } from '../src/run/check.ts';
import * as claudeCode from '../src/agents/claude-code.ts';
import * as codex from '../src/agents/codex.ts';
import * as gemini from '../src/agents/gemini.ts';
import { type Finding, formatFinding } from '../src/rules/message.ts';
import { isCodeFile, nameNotes } from '../src/run/names.ts';
import { addedLinesByFile, changedLines, checkIssueTitle, checkOwnedTier, checkPullRequest, checkPullRequestTitle, isChangeFile, largeDiff, longSentenceNote, longSentences } from '../src/rules/pr.ts';
import { closestWord, COMMANDS, commandHelp, findCommand, HELP_OPTIONS, commandList } from '../src/run/cli.ts';
import { hideHome } from '../src/rules/privacy.ts';
import { type Action, judge } from '../src/run/hook.ts';
import { draft, facts, table } from '../src/setup/advice/adopt.ts';
import { doctor } from '../src/setup/doctor.ts';
import { explain, explainLines, ids } from '../src/setup/advice/explain.ts';
import { VERSION } from '../src/setup/files.ts';
import { init, updateCoreRules } from '../src/setup/init.ts';
import { install } from '../src/setup/install.ts';
import { readOriginUrl, setUpPlanning } from '../src/setup/plan.ts';

// The help comes from one table, the same one the parser reads (#207).
const HELP = [
  `yokoten ${VERSION}`,
  '',
  'Usage: yokoten <command> [options]',
  '',
  ...commandList(),
  '',
  'Start: `yokoten install` once on this machine, then `yokoten init` in your project.',
  'Run `yokoten <command> --help` for its options and an example.',
  '--json on check, doctor, hook, explain and adopt: data on stdout,',
  'for an agent or a script.',
  'Exit codes: 0 ok, 1 problems found or a usage error, 2 the hook blocked the tool call',
  'or the end of the turn.',
].join('\n');

const [cmd, ...args] = process.argv.slice(2);
const env = process.env;

/** The command line, read strictly: an unknown option is refused, never ignored. */
interface Parsed {
  flags: Set<string>;
  values: Record<string, string>;
  positional: string[];
}
/** Reads the words by the options and argument the command's help lists, nothing else. */
function parse(name: string, words: string[] = args): Parsed | string {
  const command = findCommand(name);
  if (!command) throw new Error(`no help entry for ${name}`);
  const known = new Map(command.options.map((option) => [option.name, option]));
  const parsed: Parsed = { flags: new Set(), values: {}, positional: [] };
  for (let i = 0; i < words.length; i++) {
    const a = words[i];
    const option = known.get(a);
    if (option?.value) {
      const value = words[++i];
      if (value === undefined || value.startsWith('--')) return `${a} needs a value`;
      parsed.values[a] = value;
    } else if (option) parsed.flags.add(a);
    else if (a.startsWith('-')) {
      const near = closestWord(a, [...known.keys(), HELP_OPTIONS[0]]);
      return `unknown option ${a}${near ? `. Did you mean ${near}?` : ''}`;
    } else parsed.positional.push(a);
  }
  const allowed = command.argument ? 1 : 0;
  if (parsed.positional.length > allowed) return `unexpected argument ${parsed.positional[allowed]}`;
  return parsed;
}

/** A usage error: said on stderr, exit 1, as for an unknown command. */
function usage(error: string): number {
  print([`yokoten ${cmd}: ${error}${/[.?]$/.test(error) ? '' : '.'} Run \`yokoten ${cmd} --help\`.`], process.stderr);
  return 1;
}

/** An unknown command: the closest one when it is near, or else the list. Exit 1. */
function unknownCommand(name: string): number {
  const near = closestWord(name, COMMANDS.map((command) => command.name));
  const hint = near ? `Did you mean "${near}"?` : `Commands: ${COMMANDS.map((command) => command.name).join(', ')}.`;
  print([`yokoten: unknown command "${name}". ${hint} Run \`yokoten help\`.`], process.stderr);
  return 1;
}

/**
 * True when the command line asks for help: `--help` or `-h` among its own words. For
 * `bot`, only the words before `--` count: after it, they belong to the command it runs.
 */
function isHelpAsked(words: string[]): boolean {
  const end = words.indexOf('--');
  return (end === -1 ? words : words.slice(0, end)).some((word) => HELP_OPTIONS.includes(word));
}

const rootOf = (dir: string): string | null => {
  try {
    return gitRoot(dir);
  } catch {
    return null;
  }
};

// Everything yokoten prints goes through here or `say`, never straight to a stream: the
// output lands in transcripts and CI logs, so the home folder is shown as ~ (core rule 11).
function print(lines: string[], stream: NodeJS.WritableStream = process.stdout): void {
  if (lines.length) say(`${lines.join('\n')}\n`, stream);
}
function say(text: string, stream: NodeJS.WritableStream): void {
  stream.write(hideHome(text, env));
}

// --json: stdout holds the JSON and nothing else. The home folder is hidden in every
// string before it is encoded, as in the text form.
function printJson(data: unknown): void {
  const hide = (v: unknown): unknown =>
    typeof v === 'string' ? hideHome(v, env) : Array.isArray(v) ? v.map(hide) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, hide(x)])) : v;
  process.stdout.write(`${JSON.stringify(hide(data), null, 2)}\n`);
}

const bullets = (findings: Finding[]) => findings.map((f) => `- ${formatFinding(f)}`);

/**
 * In a GitHub Actions job, the findings of a check also go on the pull request page
 * (#91): annotations on stdout, and a job summary. Outside Actions, nothing. With
 * --json, stdout holds only the JSON, so there are no annotations; the summary is a file.
 * A summary that can't be written is said on stderr; it never changes the result.
 */
function showOnPullRequest(name: string, problems: Finding[], notes: Finding[], { json, isPlaceAFile }: { json: boolean; isPlaceAFile: boolean }): void {
  if (!isGitHubActions(env)) return;
  if (!json) print(annotations(problems, notes, isPlaceAFile));
  if (!env.GITHUB_STEP_SUMMARY) return;
  try {
    appendFileSync(env.GITHUB_STEP_SUMMARY, hideHome(stepSummary(name, problems, notes), env));
  } catch (err) {
    say(`${name}: the job summary was not written: ${((err as Error).message ?? String(err)).split('\n')[0]}\n`, process.stderr);
  }
}

/**
 * Problems with the title a bot command is about to set (#117), by the rules CI uses:
 * `check --issue` for an issue, the title part of `check --pr` for a pull request. No
 * title in the command, no problems. It reads no token and no network.
 */
function checkCommandTitle(command: string[]): Finding[] {
  const found = readCommandTitle(command);
  if (!found) return [];
  const root = rootOf(process.cwd());
  const config = root ? loadConfig(root) : DEFAULTS;
  return found.kind === 'issue' ? checkIssueTitle(found.title, config, found.labels) : checkPullRequestTitle(found.title, config);
}

async function bot(command: string[]): Promise<number> {
  // The title first: a bad title is refused before anything is sent, so it never needs a rename.
  const titleProblems = checkCommandTitle(command);
  if (titleProblems.length) {
    print([`yokoten bot: ${titleProblems.length} problem(s) in the title; nothing was sent. Fix the title and run it again:`, ...bullets(titleProblems)], process.stderr);
    return 1;
  }
  const config = botConfig(env);
  if (typeof config === 'string') {
    print([`yokoten bot: ${config}`], process.stderr);
    return 1;
  }
  if (!command.length) {
    print(['yokoten bot: no command. Example: yokoten bot -- gh pr create --fill'], process.stderr);
    return 1;
  }
  const remote = execFileSync('git', ['remote', 'get-url', 'origin'], { encoding: 'utf8' });
  const repo = repoOf(remote);
  if (!repo) {
    print(['yokoten bot: the origin remote is not a GitHub repo'], process.stderr);
    return 1;
  }
  const token = await installationToken(config, repo);
  const [file, ...rest] = command;
  return spawnSync(file, rest, { stdio: 'inherit', env: botEnv(env, token) }).status ?? 1;
}

// Each runtime sends its tool call in its own shape; its adapter turns it into an Action.
const READERS: Record<string, (input: unknown) => Action> = {
  'claude-code': claudeCode.readToolCall,
  codex: codex.readToolCall,
  gemini: gemini.readToolCall,
};

/**
 * The stop check (#92). Claude Code runs it when the agent is about to end its turn
 * (code.claude.com/docs/en/hooks#stop). Findings in the changed files send the agent back
 * once: exit 2, with the findings on stderr as the reason. `stop_hook_active` means it was
 * already sent back, so the turn ends whatever is found: never a loop. On any error the
 * turn ends too, with one line on stderr: a broken check must not trap a session.
 */
function stopHook(json: boolean): number {
  let event: ReturnType<typeof claudeCode.readStop>;
  try {
    event = claudeCode.readStop(JSON.parse(readFileSync(0, 'utf8')));
  } catch {
    event = null;
  }
  if (!event) {
    if (json) printJson({ blocked: false, stop: false });
    return 0;
  }
  if (event.active) {
    if (json) printJson({ blocked: false, stop: true, skipped: 'the agent was already sent back once', findings: [] });
    return 0;
  }
  let findings: Finding[];
  try {
    const root = rootOf(event.cwd ?? process.cwd());
    findings = root ? checkChanged(root, { config: loadConfig(root), env }) : [];
  } catch (err) {
    say(`yokoten hook --stop: skipped, ${((err as Error).message ?? String(err)).split('\n')[0]}\n`, process.stderr);
    if (json) printJson({ blocked: false, stop: true, skipped: 'the check failed', findings: [] });
    return 0;
  }
  if (json) printJson({ blocked: findings.length > 0, stop: true, findings });
  if (!findings.length) return 0;
  // Claude Code gives stderr to the agent as the reason to go on when a Stop hook exits 2.
  print([`yokoten: ${findings.length} problem(s) in the changed files. Fix them before you end the turn:`, ...bullets(findings)], process.stderr);
  return 2;
}

function main(): number | Promise<number> {
  // `<command> --help` prints that command's help and does nothing else (#207).
  const command = cmd === undefined ? undefined : findCommand(cmd);
  if (command && isHelpAsked(args)) {
    print(commandHelp(command));
    return 0;
  }
  switch (cmd) {
    case 'hook': {
      const options = parse('hook');
      if (typeof options === 'string') return usage(options);
      const json = options.flags.has('--json');
      if (options.flags.has('--stop')) {
        if (options.flags.has('--commands-only')) return usage("--stop and --commands-only can't be used together");
        if ((options.values['--agent'] ?? 'claude-code') !== 'claude-code') return usage('--stop reads a Claude Code Stop event only');
        return stopHook(json);
      }
      const agent = options.values['--agent'] ?? 'claude-code';
      const read = Object.hasOwn(READERS, agent) ? READERS[agent] : undefined;
      if (!read) {
        print([`yokoten hook: unknown --agent ${agent}; use one of: ${Object.keys(READERS).join(', ')}`], process.stderr);
        return 1;
      }
      let input: unknown;
      try {
        input = JSON.parse(readFileSync(0, 'utf8'));
      } catch {
        // Not a tool call; nothing to judge. A runtime never sends one, and blocking here
        // would stop every tool call the day a runtime changes its input.
        if (json) printJson({ blocked: false, toolCall: false });
        return 0;
      }
      const action = read(input);
      const root = rootOf(action.cwd ?? process.cwd());
      const config = root ? loadConfig(root) : DEFAULTS;
      const found = judge(action, { root, config, env, commandsOnly: options.flags.has('--commands-only') });
      if (json) printJson(found ? { blocked: true, finding: found } : { blocked: false, toolCall: true });
      if (!found) return 0;
      // The runtimes read the reason from stderr when the hook exits 2.
      say(`yokoten: ${formatFinding(found)}\n`, process.stderr);
      return 2;
    }
    case 'check': {
      const options = parse('check');
      if (typeof options === 'string') return usage(options);
      const modes = ['--staged', '--history', '--pr', '--issue'].filter((m) => options.flags.has(m));
      if (modes.length > 1) return usage(`${modes.join(' and ')} can't be used together`);
      const mode = modes[0]?.slice(2) ?? 'tree';
      const json = options.flags.has('--json');
      const root = gitRoot(process.cwd());
      const config = loadConfig(root);
      const name = `yokoten check${mode === 'pr' || mode === 'issue' ? ` --${mode}` : ''}`;
      const notes: Finding[] = [];
      let problems: Finding[];
      if (mode === 'issue') {
        const issue = readIssue(env);
        if (!issue) {
          const skipped = 'no issue in this run (it reads the CI event); nothing to check';
          if (json) printJson({ check: mode, ok: true, skipped, findings: [], notes: [] });
          else print([`${name}: ${skipped}`]);
          return 0;
        }
        problems = checkIssueTitle(issue.title, config, issue.labels);
      } else if (mode === 'pr') {
        const pr = readPullRequest(root, env);
        if (!pr) {
          const skipped = 'no pull request in this run (it reads the CI event); nothing to check';
          if (json) printJson({ check: mode, ok: true, skipped, findings: [], notes: [] });
          else print([`${name}: ${skipped}`]);
          return 0;
        }
        // The file as the pull request leaves it, or null when the pull request deletes it.
        const readAtHead = (file: string): string | null => {
          try {
            return execFileSync('git', ['show', `${pr.head}:${file}`], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
          } catch {
            return null;
          }
        };
        const printNotes = (found: Finding[], label: string) => {
          if (found.length && !json) print([`${name}: note: ${found.length} ${label}`, ...bullets(found.slice(0, 10)), ...(found.length > 10 ? [`- and ${found.length - 10} more`] : [])]);
        };
        // Plain English (record 0005): long sentences in changed Markdown are notes, never failures.
        const long: Finding[] = [];
        for (const file of pr.files.filter((p) => /\.md$/i.test(p))) {
          const text = readAtHead(file);
          if (text !== null) for (const s of longSentences(text)) long.push(longSentenceNote(file, s));
        }
        notes.push(...long);
        printNotes(long, 'long sentence(s)');
        // Names (record 0006): hard-to-read names on the lines a pull request adds to code
        // are notes too. Old lines are left alone, so a project is not noted all at once.
        const names: Finding[] = [];
        const codeFiles = pr.files.filter(isCodeFile);
        // One diff with renames found, so a moved file is not noted as all new. Fixed
        // prefixes and plain paths, whatever the user's git settings say.
        const diffArgs = ['-c', 'core.quotePath=false', 'diff', '-U0', '-M', '--no-color', '--no-ext-diff', '--no-textconv', '--src-prefix=a/', '--dst-prefix=b/', `${pr.base}...${pr.head}`];
        const added = codeFiles.length ? addedLinesByFile(execFileSync('git', diffArgs, { cwd: root, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 })) : new Map<string, Set<number>>();
        for (const file of codeFiles) {
          const text = added.has(file) ? readAtHead(file) : null;
          if (text !== null) names.push(...nameNotes(file, text, added.get(file) ?? new Set()));
        }
        notes.push(...names);
        printNotes(names, 'hard-to-read name(s)');
        // A large pull request (record 0004) is a note too, never a failure.
        const large = largeDiff(changedLines(pr.numstat));
        if (large) {
          notes.push(large);
          if (!json) print([`${name}: note: ${formatFinding(large)}`]);
        }
        problems = checkPullRequest(pr, config);
        // Each change file the pull request leaves (#132) must be one `yokoten changelog` can read.
        for (const file of pr.files.filter(isChangeFile)) {
          const text = readAtHead(file);
          if (text !== null) problems.push(...parseChange(file, text).problems);
        }
        // Owned paths set the lowest tier, from the base branch's CODEOWNERS.
        const owned = checkOwnedTier(pr, readCodeOwners(root, pr.base));
        if (owned) problems.push(owned);
      } else {
        problems = mode === 'history' ? checkHistory(root, { config, env }) : check(root, { config, env, staged: mode === 'staged', notes });
        // A translation behind its English source (#87) is a note, for the whole tree only.
        if (!json) for (const note of notes) print([`${name}: note: ${formatFinding(note)}`]);
        const zones = mode === 'history' && config.privacy.utc ? historyTimeZones(root) : 0;
        if (zones) {
          notes.push(timeZoneNote(zones));
          if (!json) print([`${name}: note: ${formatFinding(timeZoneNote(zones))}`]);
        }
      }
      if (json) printJson({ check: mode, ok: !problems.length, findings: problems, notes });
      else if (!problems.length) print([`${name}: ok${mode === 'history' ? ' (every commit on every branch)' : ''}`]);
      else print([`${name}: ${problems.length} problem(s)`, ...bullets(problems)], process.stderr);
      showOnPullRequest(`yokoten check${mode === 'tree' ? '' : ` --${mode}`}`, problems, notes, { json, isPlaceAFile: mode !== 'history' });
      return problems.length ? 1 : 0;
    }
    case 'changelog': {
      const options = parse('changelog');
      if (typeof options === 'string') return usage(options);
      const root = rootOf(process.cwd()) ?? process.cwd();
      const isWrite = options.flags.has('--write');
      const { changes, problems } = isWrite ? writeChanges(root) : readChanges(root);
      if (problems.length) {
        print([`yokoten changelog: ${problems.length} problem(s); nothing was written:`, ...bullets(problems)], process.stderr);
        return 1;
      }
      if (!changes.length) print(['yokoten changelog: no change files in changes/; nothing to add']);
      else if (isWrite) print([`yokoten changelog: wrote ${changes.length} change(s) under [Unreleased] in CHANGELOG.md, and deleted:`, ...changes.map((change) => `- ${change.file}`)]);
      else print([`yokoten changelog: ${changes.length} change(s); \`--write\` adds these under [Unreleased] in CHANGELOG.md:`, '', ...formatChanges(changes)]);
      return 0;
    }
    case 'doctor': {
      const options = parse('doctor');
      if (typeof options === 'string') return usage(options);
      const session = options.flags.has('--session');
      const root = rootOf(process.cwd());
      const config = root ? loadConfig(root) : DEFAULTS;
      const { ok, lines, report } = doctor(root, { env, config, session, gh: root ? ghIn(root) : undefined });
      if (options.flags.has('--json')) printJson(report);
      else print(lines);
      // A session must start even when a project has steps left.
      return session || ok ? 0 : 1;
    }
    case 'explain': {
      const options = parse('explain');
      if (typeof options === 'string') return usage(options);
      const [id] = options.positional;
      if (id === undefined) {
        if (options.flags.has('--json')) printJson({ ids: ids() });
        else print([`Ids: ${ids().join(', ')}`]);
        return 0;
      }
      const found = explain(id);
      if (options.flags.has('--json')) printJson(found ? { found: true, ...found } : { id, found: false, ids: ids() });
      else if (found) print(explainLines(found));
      else print([`yokoten explain: no rule or step is called ${id}.`, `Ids: ${ids().join(', ')}`], process.stderr);
      return found ? 0 : 1;
    }
    case 'adopt': {
      // Reads files and asks the model; never writes a file or changes config.
      const options = parse('adopt');
      if (typeof options === 'string') return usage(options);
      const root = gitRoot(process.cwd());
      return draft(facts(root, env), { env }).then((drafted) => {
        if (options.flags.has('--json')) {
          printJson(drafted.rows.map(({ key, status, evidence, decision, reason }) => ({ key, status, evidence, decision, reason })));
          print([`yokoten adopt: drafted by ${drafted.by}${drafted.note ? `, because ${drafted.note}` : ''}. You decide every row.`], process.stderr);
        } else print(table(drafted));
        return 0;
      });
    }
    case 'init': {
      const options = parse('init');
      if (typeof options === 'string') return usage(options);
      if (options.flags.has('--yes') && !options.flags.has('--github')) return usage('--yes goes with --github');
      if (options.flags.has('--remove-default-labels') && !options.flags.has('--github')) return usage('--remove-default-labels goes with --github');
      const dir = resolve(options.positional[0] ?? '.');
      const root = rootOf(dir) ?? dir;
      print(init(root));
      // The host is changed only when asked (#10): it is a remote, and other people see it.
      // Without --yes, init only reads it and says what it would do, or what it skipped.
      const planning = setUpPlanning(ghIn(root), readOriginUrl(root), { apply: options.flags.has('--yes'), removeDefaults: options.flags.has('--remove-default-labels') });
      print(planning.lines, planning.ok ? process.stdout : process.stderr);
      return planning.ok ? 0 : 1;
    }
    case 'update': {
      // Its own command, not an init flag: init promises to add only, never to overwrite (#120).
      const options = parse('update');
      if (typeof options === 'string') return usage(options);
      const dir = resolve(options.positional[0] ?? '.');
      const { ok, lines } = updateCoreRules(rootOf(dir) ?? dir, { write: options.flags.has('--write') });
      print([`yokoten update: ${lines[0]}`, ...lines.slice(1)], ok ? process.stdout : process.stderr);
      return ok ? 0 : 1;
    }
    case 'bot': {
      // No options of its own: everything after `--` is the command, passed on unchanged.
      const end = args.indexOf('--');
      const options = parse('bot', end === -1 ? args : args.slice(0, end));
      if (typeof options === 'string') return usage(options);
      return bot(end === -1 ? [] : args.slice(end + 1));
    }
    case 'install': {
      const options = parse('install');
      if (typeof options === 'string') return usage(options);
      print(install(env));
      return 0;
    }
    case 'version': {
      const options = parse('version');
      if (typeof options === 'string') return usage(options);
      print([VERSION]);
      return 0;
    }
    case '--version':
    case '-v':
      print([VERSION]);
      return 0;
    case 'help': {
      const options = parse('help');
      if (typeof options === 'string') return usage(options);
      const [name] = options.positional;
      if (name === undefined) break;
      const named = findCommand(name);
      if (!named) return unknownCommand(name);
      print(commandHelp(named));
      return 0;
    }
    case undefined:
    case '--help':
    case '-h':
      break;
    default:
      return unknownCommand(cmd);
  }
  print([HELP]);
  return 0;
}

// Exit 1, not 2, on an error: a broken guard should be seen, not block every tool call.
Promise.resolve()
  .then(main)
  .then(
    (code) => {
      process.exitCode = code;
    },
    (err: Error) => {
      say(`yokoten ${cmd}: ${err.message}\n`, process.stderr);
      process.exitCode = 1;
    },
  );
