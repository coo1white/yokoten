// `yokoten init`, `update`, `install` and `uninstall`: they write yokoten into a project or a machine.

import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { ghIn } from '../host/github.ts';
import { loadConfig } from '../rules/config.ts';
import { init, updateCoreRules } from '../setup/init.ts';
import { install, uninstall } from '../setup/install.ts';
import { readOriginUrl, setUpPlanning } from '../setup/plan.ts';
import { env, parse, print, requireRoot, usage } from './shared.ts';

export function runInit(): number {
  const options = parse('init');
  if (typeof options === 'string') return usage(options);
  if (options.flags.has('--yes') && !options.flags.has('--github')) return usage('--yes goes with --github');
  if (options.flags.has('--remove-default-labels') && !options.flags.has('--github')) return usage('--remove-default-labels goes with --github');
  if (options.flags.has('--board') && !options.flags.has('--github')) return usage('--board goes with --github');
  const dir = resolve(options.positional[0] ?? '.');
  // Checked before anything is written (#205): a typo never becomes a new folder.
  if (!existsSync(dir)) {
    print([`yokoten init: ${options.positional[0]} does not exist; nothing was written. Create it and run \`git init\` there first.`], process.stderr);
    return 1;
  }
  const root = requireRoot(dir);
  if (!root) return 1;
  // Read first: a broken yokoten.json stops init before it writes a file.
  const { areas } = loadConfig(root);
  const done = init(root);
  print(done.lines);
  // The host is changed only when asked (#10): it is a remote, and other people see it.
  // Without --yes, init only reads it and says what it would do, or what it skipped.
  const planning = setUpPlanning(ghIn(root), readOriginUrl(root), {
    apply: options.flags.has('--yes'),
    removeDefaults: options.flags.has('--remove-default-labels'),
    areas,
    board: options.flags.has('--board'),
  });
  // --github --yes asked for changes on GitHub; a skip made none, so it fails (#208).
  const isRefused = planning.skipped && options.flags.has('--yes');
  print(planning.lines, planning.ok && !isRefused ? process.stdout : process.stderr);
  if (isRefused) print(['yokoten init: --github --yes changed nothing on GitHub (the reason is above). The project files are as listed above.'], process.stderr);
  return planning.ok && !isRefused && done.ok ? 0 : 1;
}

export function runUpdate(): number {
  // Its own command, not an init flag: init promises to add only, never to overwrite (#120).
  const options = parse('update');
  if (typeof options === 'string') return usage(options);
  const dir = resolve(options.positional[0] ?? '.');
  if (!existsSync(dir)) {
    print([`yokoten update: ${options.positional[0]} does not exist; nothing to update.`], process.stderr);
    return 1;
  }
  const root = requireRoot(dir);
  if (!root) return 1;
  const { ok, lines } = updateCoreRules(root, { write: options.flags.has('--write') });
  print([`yokoten update: ${lines[0]}`, ...lines.slice(1)], ok ? process.stdout : process.stderr);
  return ok ? 0 : 1;
}

export function runInstall(): number {
  const options = parse('install');
  if (typeof options === 'string') return usage(options);
  // gh may reach the network for the login: three seconds at most.
  const done = install(env, { cwd: process.cwd(), gh: ghIn(process.cwd(), 3000) });
  print(done.lines);
  return done.ok ? 0 : 1;
}

export function runUninstall(): number {
  const options = parse('uninstall');
  if (typeof options === 'string') return usage(options);
  const done = uninstall(env);
  print(done.lines);
  return done.ok ? 0 : 1;
}
