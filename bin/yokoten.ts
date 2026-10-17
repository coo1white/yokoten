#!/usr/bin/env node
// yokoten: carry what one project learned into every project.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { DEFAULTS, loadConfig } from '../src/rules/config.ts';
import { check, checkHistory, gitRoot } from '../src/run/check.ts';
import { judge, type ToolCall } from '../src/run/hook.ts';
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

function print(lines: string[], stream: NodeJS.WritableStream = process.stdout): void {
  if (lines.length) stream.write(`${lines.join('\n')}\n`);
}

function main(): number {
  switch (cmd) {
    case 'hook': {
      let input: ToolCall;
      try {
        input = JSON.parse(readFileSync(0, 'utf8'));
      } catch {
        return 0; // not a tool call; nothing to judge
      }
      const root = rootOf(input.cwd ?? process.cwd());
      const config = root ? loadConfig(root) : DEFAULTS;
      const reason = judge(input, { root, config, env, commandsOnly: flag('--commands-only') });
      if (!reason) return 0;
      process.stderr.write(`yokoten: ${reason}\n`);
      return 2;
    }
    case 'check': {
      const root = gitRoot(process.cwd());
      const config = loadConfig(root);
      const problems = flag('--history') ? checkHistory(root, { config, env }) : check(root, { config, env, staged: flag('--staged') });
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

try {
  process.exitCode = main();
} catch (err) {
  // Exit 1, not 2: a broken guard should be seen, not block every tool call.
  process.stderr.write(`yokoten ${cmd}: ${(err as Error).message}\n`);
  process.exitCode = 1;
}
