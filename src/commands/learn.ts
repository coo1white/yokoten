// `yokoten learn` and `yokoten changelog`: what the project learned, and what it changed.

import { ghIn, readIncident } from '../host/github.ts';
import { formatChanges, readChanges, writeChanges } from '../run/changelog.ts';
import { existsSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { loadConfig } from '../rules/config.ts';
import { loadMarks } from '../rules/privacy.ts';
import { draftLesson, formatDraft, KIT_LESSONS_DIR, LESSONS_TABLE, listNotes, type NotePlace, redactNote, removeNote, shipLesson, upstreamDir, writeDraft, writeNote } from '../run/learn.ts';
import { HOME_DIR, VERSION } from '../setup/files.ts';
import { isSelf } from '../setup/init.ts';
import { machineMarks } from '../setup/install.ts';
import { readOriginUrl } from '../setup/plan.ts';
import { bullets, env, type Parsed, parse, print, rootOf, usage } from './shared.ts';

export function runChangelog(): number {
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

export function runLearn(): number {
  // A draft for review (#77), never a shipped check: it writes only with --write, and adds only.
  const options = parse('learn');
  if (typeof options === 'string') return usage(options);
  const [reference] = options.positional;
  if (options.flags.has('--upstream')) return runUpstream(options);
  for (const option of ['--list', '--done', '--area', '--fix']) {
    if (options.flags.has(option) || option in options.values) return usage(`${option} goes with --upstream`);
  }
  const root = rootOf(process.cwd()) ?? process.cwd();
  // A reviewed lesson ships in the kit (#147): doctor then runs it in every project.
  if (options.flags.has('--ship')) {
    if (options.flags.has('--write')) return usage('--ship and --write are two steps: write the draft, review it, then ship it');
    if (reference === undefined) return usage('name the lesson to ship, by its id or its issue number');
    const shipped = shipLesson(root, reference, VERSION);
    if ('problems' in shipped) {
      print([`yokoten learn --ship: ${shipped.problems.length} problem(s); nothing was moved:`, ...shipped.problems.map((problem) => `- ${problem}`)], process.stderr);
      return 1;
    }
    const { id, folder, url } = shipped.lesson;
    // A project runs the lessons of the yokoten that runs its doctor, so say how each one gets it (#77).
    print([
      `yokoten learn --ship: ${id} is in ${KIT_LESSONS_DIR}/${folder}/, with a row in ${KIT_LESSONS_DIR}/${LESSONS_TABLE} (from ${url}, yokoten ${VERSION}).`,
      'Commit it in a pull request. Other projects get it from the yokoten that runs their doctor:',
      "- now: run this copy's bin/yokoten.ts doctor in the project",
      "- this machine: run install from this copy, so `yokoten doctor` has it",
      "- a project's .yokoten/: run init again from this copy, then commit .yokoten/",
      '- everyone else: the next yokoten release',
    ]);
    return 0;
  }
  if (reference === undefined) return usage('name an incident issue, by its number or its URL');
  const incident = readIncident(ghIn(root), reference);
  if (typeof incident === 'string') {
    print([`yokoten learn: ${incident}`], process.stderr);
    return 1;
  }
  const draft = draftLesson(incident);
  const [first, ...rest] = formatDraft(incident, draft);
  if (!options.flags.has('--write')) {
    print([`yokoten learn: ${first}`, ...rest, '', `Nothing was written. \`yokoten learn ${reference} --write\` adds these files for review.`]);
    return 0;
  }
  const { written, kept } = writeDraft(root, draft);
  print([
    `yokoten learn: ${first}`,
    ...rest.slice(0, rest.indexOf('')),
    ...(written.length ? ['Wrote:', ...written.map((path) => `- ${path}`)] : []),
    ...(kept.length ? ['Kept, already there:', ...kept.map((path) => `- ${path}`)] : []),
    'Review the draft: fill in each TODO, write the check, and make its test pass.',
  ]);
  return 0;
}

/** What a note must not carry out of the project at hand (#392). Local git and files only. */
function notePlace(root: string | null): NotePlace {
  const found = machineMarks(env, { cwd: root ?? process.cwd() });
  const owners = found.filter((mark) => mark.kind === 'git name' || mark.kind === 'git email').map((mark) => mark.value);
  const hosts = found.filter((mark) => mark.kind === 'private remote host').map((mark) => mark.value);
  const projects: string[] = [];
  // In yokoten's own repo, "yokoten" is the subject of the note, not a detail to hide.
  if (root && !isSelf(root)) {
    projects.push(basename(root));
    try {
      const name: unknown = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).name;
      if (typeof name === 'string') projects.push(name, name.replace(/^@[^/]+\//, ''));
    } catch {}
    // owner/repo at the end of the origin URL: the repo is the project, the owner may be a person.
    const origin = /([^/:]+)\/([^/]+?)(?:\.git)?\/?$/.exec(readOriginUrl(root));
    if (origin) {
      owners.push(origin[1]);
      projects.push(origin[2]);
    }
  }
  return { root, projects, owners, hosts, marks: loadMarks(env) };
}

/** The areas a note may name: yokoten's own, when this copy has its yokoten.json; else any lowercase word. */
function knownAreas(): string[] {
  return existsSync(join(HOME_DIR, 'yokoten.json')) ? loadConfig(HOME_DIR).areas : [];
}

/** `learn --upstream`: keep, list or remove a note for the yokoten repo (#392). It never calls the network. */
function runUpstream(options: Parsed): number {
  const [text] = options.positional;
  const inbox = upstreamDir(env);
  for (const option of ['--write', '--ship']) if (options.flags.has(option)) return usage(`--upstream and ${option} don't go together`);
  if (options.flags.has('--list')) {
    if (text !== undefined || options.flags.has('--done')) return usage('--list takes nothing more');
    const notes = listNotes(env);
    if (!notes.length) {
      print(['yokoten learn --upstream: no lessons wait; the inbox is empty.']);
      return 0;
    }
    print([
      `yokoten learn --upstream: ${notes.length} ${notes.length === 1 ? 'lesson waits' : 'lessons wait'} to become an issue in the yokoten repo:`,
      ...notes.flatMap((note) => [`- ${note.id} (${note.when.replace('T', ' ').replace(/:\d\dZ$/, '')} UTC, part: ${note.part}): ${note.what}`, ...(note.fix ? [`  fix idea: ${note.fix}`] : [])]),
      'Open an issue for each, then remove its note: yokoten learn --upstream --done <id>',
    ]);
    return 0;
  }
  if (options.flags.has('--done')) {
    if (text === undefined) return usage('name the note to remove, by its id from --list');
    if (!removeNote(env, text)) {
      print([`yokoten learn --upstream: there is no note ${text}. See the ids with: yokoten learn --upstream --list`], process.stderr);
      return 1;
    }
    print([`yokoten learn --upstream: removed note ${text}.`]);
    return 0;
  }
  if (text === undefined || !text.trim()) return usage('say what happened, in a few words: yokoten learn --upstream "<what happened>"');
  const area = options.values['--area'];
  if (area !== undefined) {
    const areas = knownAreas();
    if (areas.length ? !areas.includes(area) : !/^[a-z][a-z0-9-]*$/.test(area)) return usage(areas.length ? `--area is one of: ${areas.join(', ')}` : '--area is one lowercase word, such as hook');
  }
  const place = notePlace(rootOf(process.cwd()));
  const what = redactNote(text, place, env);
  const fixIdea = options.values['--fix'] === undefined ? undefined : redactNote(options.values['--fix'], place, env);
  const problems = [...('problems' in what ? what.problems : []), ...(fixIdea && 'problems' in fixIdea ? fixIdea.problems : [])];
  if (problems.length || !('text' in what)) {
    // The kind of detail only: the value itself is never printed (core rule 11).
    const kinds = [...new Set(problems.map((problem) => (problem.id === 'private-mark' ? 'a line of your private-marks file' : problem.what)))];
    print([`yokoten learn --upstream: the note was not kept, because it holds ${kinds.join(' and ')}. Say what happened without it, and try again.`], process.stderr);
    return 1;
  }
  const fix = fixIdea && 'text' in fixIdea && fixIdea.text ? fixIdea.text : undefined;
  const note = writeNote(env, { part: area ?? 'unknown', what: what.text, ...(fix ? { fix } : {}) });
  print([
    `yokoten learn --upstream: kept note ${note.id} in ${inbox}, outside every repo. It reads:`,
    `  ${note.what}`,
    ...(note.fix ? [`  fix idea: ${note.fix}`] : []),
    'In the yokoten repo, the session start counts it until you open an issue for it.',
  ]);
  return 0;
}
