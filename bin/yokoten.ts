#!/usr/bin/env node
// yokoten: carry what one project learned into every project.

import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { DEFAULTS, loadConfig } from '../src/rules/config.ts';
import { botConfig, botEnv, installationToken, repoOf } from '../src/github/bot.ts';
import { check, checkHistory, gitRoot, historyTimeZones } from '../src/run/check.ts';
import { readToolCall } from '../src/agents/claude-code.ts';
import { hideHome } from '../src/rules/privacy.ts';
import { judge } from '../src/run/hook.ts';
import { doctor } from '../src/setup/doctor.ts';
import { VERSION } from '../src/setup/files.ts';
import { init } from '../src/setup/init.ts';
import { install } from '../src/setup/install.ts';

const HELP = `yokoten ${VERSION}

  yokoten install            skills, agents and user-level hooks for this machine
  yokoten init [dir]         put the practices into a project (adds only, never overwrites)
  yokoten doctor [--session] what this project and machine are missing
  yokoten check [--staged]   layout, privacy and lead-only files (--staged: the next commit)
  yokoten check --history    the privacy check over every commit; run before going public
  yokoten hook [--commands-only]  the tool-call guard (reads a PreToolUse call on stdin)
  yokoten bot -- <command>   run one command as the bot (gh, git push); the token is never printed
`;

const [cmd, ...args] = process.argv.slice(2);
const flag = (name: string) => args.includes(name);
const env = process.env;

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

function main(): number | Promise<number> {
  switch (cmd) {
    case 'hook': {
      let input: unknown;
      try {
        input = JSON.parse(readFileSync(0, 'utf8'));
      } catch {
        return 0; // not a tool call; nothing to judge
      }
      const action = readToolCall(input);
      const root = rootOf(action.cwd ?? process.cwd());
      const config = root ? loadConfig(root) : DEFAULTS;
      const reason = judge(action, { root, config, env, commandsOnly: flag('--commands-only') });
      if (!reason) return 0;
      say(`yokoten: ${reason}\n`, process.stderr);
      return 2;
    }
    case 'check': {
      const root = gitRoot(process.cwd());
      const config = loadConfig(root);
      const problems = flag('--history') ? checkHistory(root, { config, env }) : check(root, { config, env, staged: flag('--staged') });
      const zones = flag('--history') && config.privacy.utc ? historyTimeZones(root) : 0;
      if (zones) print([`yokoten check: note: ${zones} commit(s) record a time zone other than UTC. Rewriting history is the owner's call; new commits are checked.`]);
      if (!problems.length) {
        print([`yokoten check: ok${flag('--history') ? ' (every commit on every branch)' : ''}`]);
        return 0;
      }
      print([`yokoten check: ${problems.length} problem(s)`, ...problems.map((p) => `- ${p}`)], process.stderr);
      return 1;
    }
    case 'doctor': {
      const root = rootOf(process.cwd());
      const config = root ? loadConfig(root) : DEFAULTS;
      const { ok, lines } = doctor(root, { env, config, session: flag('--session') });
      print(lines);
      // A session must start even when a project is missing practices.
      return flag('--session') || ok ? 0 : 1;
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
