#!/usr/bin/env node
// yokoten: carry what one project learned into every project.

import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { DEFAULTS, loadConfig } from '../src/rules/config.ts';
import { botConfig, botEnv, installationToken, readIssue, readPullRequest, repoOf } from '../src/host/github.ts';
import { check, checkHistory, gitRoot, historyTimeZones, timeZoneNote } from '../src/run/check.ts';
import * as claudeCode from '../src/agents/claude-code.ts';
import * as codex from '../src/agents/codex.ts';
import * as gemini from '../src/agents/gemini.ts';
import { type Finding, formatFinding } from '../src/rules/message.ts';
import { changedLines, checkIssueTitle, checkPullRequest, largeDiff, longSentenceNote, longSentences } from '../src/rules/pr.ts';
import { hideHome } from '../src/rules/privacy.ts';
import { type Action, judge } from '../src/run/hook.ts';
import { doctor } from '../src/setup/doctor.ts';
import { explain, explainLines, ids } from '../src/setup/explain.ts';
import { VERSION } from '../src/setup/files.ts';
import { init } from '../src/setup/init.ts';
import { install } from '../src/setup/install.ts';

const HELP = `yokoten ${VERSION}

  yokoten install            skills, agents and user-level hooks for this machine
  yokoten init [dir]         put the practices into a project (adds only, never overwrites)
  yokoten doctor [--session] the road: where this project is and its next step (--session:
                             only the next step), and what this machine is missing
  yokoten check [--staged]   layout, privacy and lead-only files (--staged: the next commit)
  yokoten check --history    the privacy check over every commit; run before going public
  yokoten check --pr         the pull request of this CI run: title, tier, sections, issue, changelog
  yokoten check --issue      the issue of this CI run: a title of \`area: summary\`, 60 characters at most
  yokoten hook [--agent <name>] [--commands-only]
                             the tool-call guard: reads one tool call on stdin; <name> is
                             claude-code (the default), codex or gemini
  yokoten explain [<id>]     a rule or a step: what it is, why, and how it is checked
  yokoten bot -- <command>   run one command as the bot (gh, git push); the token is never printed

  --json on check, doctor, hook and explain: data on stdout, for an agent or a script.
  Exit codes: 0 ok, 1 problems found or a usage error, 2 the hook blocked the tool call.
`;

const [cmd, ...args] = process.argv.slice(2);
const env = process.env;

/** The command line, read strictly: an unknown option is refused, never ignored. */
interface Parsed {
  flags: Set<string>;
  values: Record<string, string>;
  positional: string[];
}
function parse(known: { flags: string[]; values?: string[]; positional?: number }): Parsed | string {
  const parsed: Parsed = { flags: new Set(), values: {}, positional: [] };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (known.values?.includes(a)) {
      const value = args[++i];
      if (value === undefined || value.startsWith('--')) return `${a} needs a value`;
      parsed.values[a] = value;
    } else if (known.flags.includes(a)) parsed.flags.add(a);
    else if (a.startsWith('-')) return `unknown option ${a}`;
    else parsed.positional.push(a);
  }
  if (parsed.positional.length > (known.positional ?? 0)) return `unexpected argument ${parsed.positional[known.positional ?? 0]}`;
  return parsed;
}

/** A usage error: said on stderr, exit 1, as for an unknown command. */
function usage(error: string): number {
  print([`yokoten ${cmd}: ${error}. Run \`yokoten help\`.`], process.stderr);
  return 1;
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

async function bot(command: string[]): Promise<number> {
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

function main(): number | Promise<number> {
  switch (cmd) {
    case 'hook': {
      const a = parse({ flags: ['--commands-only', '--json'], values: ['--agent'] });
      if (typeof a === 'string') return usage(a);
      const json = a.flags.has('--json');
      const agent = a.values['--agent'] ?? 'claude-code';
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
      const found = judge(action, { root, config, env, commandsOnly: a.flags.has('--commands-only') });
      if (json) printJson(found ? { blocked: true, finding: found } : { blocked: false, toolCall: true });
      if (!found) return 0;
      // The runtimes read the reason from stderr when the hook exits 2.
      say(`yokoten: ${formatFinding(found)}\n`, process.stderr);
      return 2;
    }
    case 'check': {
      const a = parse({ flags: ['--staged', '--history', '--pr', '--issue', '--json'] });
      if (typeof a === 'string') return usage(a);
      const modes = ['--staged', '--history', '--pr', '--issue'].filter((m) => a.flags.has(m));
      if (modes.length > 1) return usage(`${modes.join(' and ')} can't be used together`);
      const mode = modes[0]?.slice(2) ?? 'tree';
      const json = a.flags.has('--json');
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
        // Plain English (record 0005): long sentences in changed Markdown are notes, never failures.
        const long: Finding[] = [];
        for (const file of pr.files.filter((p) => /\.md$/i.test(p))) {
          let text = '';
          try {
            text = execFileSync('git', ['show', `${pr.head}:${file}`], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
          } catch {
            continue; // deleted in this pull request
          }
          for (const s of longSentences(text)) long.push(longSentenceNote(file, s));
        }
        notes.push(...long);
        if (long.length && !json) print([`${name}: note: ${long.length} long sentence(s)`, ...bullets(long.slice(0, 10)), ...(long.length > 10 ? [`- and ${long.length - 10} more`] : [])]);
        // A large pull request (record 0004) is a note too, never a failure.
        const large = largeDiff(changedLines(pr.numstat));
        if (large) {
          notes.push(large);
          if (!json) print([`${name}: note: ${formatFinding(large)}`]);
        }
        problems = checkPullRequest(pr, config);
      } else {
        problems = mode === 'history' ? checkHistory(root, { config, env }) : check(root, { config, env, staged: mode === 'staged' });
        const zones = mode === 'history' && config.privacy.utc ? historyTimeZones(root) : 0;
        if (zones) {
          notes.push(timeZoneNote(zones));
          if (!json) print([`${name}: note: ${formatFinding(timeZoneNote(zones))}`]);
        }
      }
      if (json) printJson({ check: mode, ok: !problems.length, findings: problems, notes });
      else if (!problems.length) print([`${name}: ok${mode === 'history' ? ' (every commit on every branch)' : ''}`]);
      else print([`${name}: ${problems.length} problem(s)`, ...bullets(problems)], process.stderr);
      return problems.length ? 1 : 0;
    }
    case 'doctor': {
      const a = parse({ flags: ['--session', '--json'] });
      if (typeof a === 'string') return usage(a);
      const session = a.flags.has('--session');
      const root = rootOf(process.cwd());
      const config = root ? loadConfig(root) : DEFAULTS;
      const { ok, lines, report } = doctor(root, { env, config, session });
      if (a.flags.has('--json')) printJson(report);
      else print(lines);
      // A session must start even when a project has steps left.
      return session || ok ? 0 : 1;
    }
    case 'explain': {
      const a = parse({ flags: ['--json'], positional: 1 });
      if (typeof a === 'string') return usage(a);
      const [id] = a.positional;
      const found = id === undefined ? null : explain(id);
      if (a.flags.has('--json')) printJson(found ? { found: true, ...found } : { id: id ?? null, found: false, ids: ids() });
      else if (found) print(explainLines(found));
      else print([id === undefined ? 'yokoten explain: name a rule or a step.' : `yokoten explain: no rule or step is called ${id}.`, `Ids: ${ids().join(', ')}`], process.stderr);
      return found ? 0 : 1;
    }
    case 'init': {
      const dir = resolve(args.find((a) => !a.startsWith('-')) ?? '.');
      print(init(rootOf(dir) ?? dir));
      return 0;
    }
    case 'bot':
      return bot(args.slice(args.indexOf('--') === -1 ? 0 : args.indexOf('--') + 1));
    case 'install':
      print(install(env));
      return 0;
    case 'version':
    case '--version':
      print([VERSION]);
      return 0;
    case undefined:
    case 'help':
    case '--help':
      print([HELP]);
      return 0;
    default:
      print([`unknown command: ${cmd}`, HELP], process.stderr);
      return 1;
  }
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
