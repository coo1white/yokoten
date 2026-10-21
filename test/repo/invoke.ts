// Runs a yokoten command in this process, as `node bin/yokoten.ts <words>` would, but with
// no child process (#475): a child strips the types of every file it loads again, and costs
// far more than the command. The command gets its words, env and folder from the caller, and
// writes to two buffers. Keep one or two real child-process tests per command for the entry.
//
// No state crosses from one call to the next: the env is a copy, and a call that changes
// process.exitCode or the process's folder fails, since the next call would inherit it.

import './home.ts';
import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { main } from '../../bin/main.ts';
import { parse } from '../../src/commands/shared.ts';
import { HELP_OPTIONS } from '../../src/run/cli.ts';
import type { Env } from '../../src/rules/config.ts';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'bin', 'yokoten.ts');

// These read the process's own stdin (or hand it on): in-process, they would read the test
// runner's. Run them as a child, with runChild. Their help and their usage errors come
// before stdin is read, so those run here.
const STDIN_COMMANDS = ['hook', 'redact', 'bot'];

/** What a command did: its exit code and everything it wrote. */
export interface Invoked {
  code: number;
  stdout: string;
  stderr: string;
}

/** A stream that keeps what is written to it. */
function collect(): { stream: Writable; text: () => string } {
  const chunks: string[] = [];
  const stream = new Writable({
    decodeStrings: false,
    write(chunk: string | Buffer, _, done) {
      chunks.push(String(chunk));
      done();
    },
  });
  return { stream, text: () => chunks.join('') };
}

/** Run `yokoten <words>` in this process, in `cwd`, with `env` as the whole environment. */
export async function invoke(words: string[], { env, cwd }: { env: Env; cwd: string }): Promise<Invoked> {
  const [command, ...args] = words;
  if (command !== undefined && STDIN_COMMANDS.includes(command)) {
    const end = args.indexOf('--');
    const own = end === -1 ? args : args.slice(0, end);
    const isRefusedEarly = own.some((word) => HELP_OPTIONS.includes(word)) || typeof parse(command, own) === 'string';
    if (!isRefusedEarly) throw new Error(`yokoten ${command} reads stdin: run it as a child, with runChild`);
  }
  const stdout = collect();
  const stderr = collect();
  const exitCode = process.exitCode;
  const folder = process.cwd();
  const code = await main({ command, args, env: { ...env }, cwd, stdout: stdout.stream, stderr: stderr.stream, script: SCRIPT });
  assert.equal(process.exitCode, exitCode, `yokoten ${words.join(' ')} set process.exitCode; it must only return its code`);
  assert.equal(process.cwd(), folder, `yokoten ${words.join(' ')} changed the process's folder`);
  return { code, stdout: stdout.text(), stderr: stderr.text() };
}
