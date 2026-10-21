// `yokoten learn` and `yokoten changelog`: what the project learned, and what it changed.

import { ghIn, readIncident, readLocalLogins } from '../host/github.ts';
import { formatChanges, readChanges, writeChanges } from '../run/changelog.ts';
import { existsSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { loadConfig } from '../rules/config.ts';
import { loadMarks, NO_HOME } from '../rules/privacy.ts';
import { draftLesson, formatDraft, KIT_LESSONS_DIR, LESSONS_TABLE, listNotes, makeNoteCleaner, NOTE_ID, type NotePlace, originParts, redactNote, removeNote, shipLesson, upstreamDir, writeDraft, writeNote } from '../run/learn.ts';
import { HOME_DIR, VERSION } from '../setup/files.ts';
import { isSelf } from '../setup/init.ts';
import { machineMarks, machineUserNames } from '../setup/install.ts';
import { readOriginUrl } from '../setup/plan.ts';
import { bullets, type Invocation, type Parsed, parse, print, rootOf, usage } from './shared.ts';

/**
 * A usage error for --upstream that repeats nothing typed (#392): a stray word or a note
 * that starts with `-` may be the very detail the note must not show.
 */
const upstreamUsage = (error: string): string =>
  error.startsWith('unexpected argument') ? 'give what happened as one argument, in quotes' : error.startsWith('unknown option') && !/^unknown option --[a-z][a-z-]*(?:\. Did you mean --[a-z-]+\?)?$/.test(error) ? 'a note cannot start with -' : error;

export function runChangelog(invocation: Invocation): number {
  const { cwd } = invocation;
  const options = parse('changelog', invocation.args);
  if (typeof options === 'string') return usage(invocation, options);
  const root = rootOf(cwd) ?? cwd;
  const isWrite = options.flags.has('--write');
  const { changes, problems } = isWrite ? writeChanges(root) : readChanges(root);
  if (problems.length) {
    print(invocation, [`yokoten changelog: ${problems.length} problem(s); nothing was written:`, ...bullets(problems)], invocation.stderr);
    return 1;
  }
  if (!changes.length) print(invocation, ['yokoten changelog: no change files in changes/; nothing to add']);
  else if (isWrite) print(invocation, [`yokoten changelog: wrote ${changes.length} change(s) under [Unreleased] in CHANGELOG.md, and deleted:`, ...changes.map((change) => `- ${change.file}`)]);
  else print(invocation, [`yokoten changelog: ${changes.length} change(s); \`--write\` adds these under [Unreleased] in CHANGELOG.md:`, '', ...formatChanges(changes)]);
  return 0;
}

export function runLearn(invocation: Invocation): number {
  const { args, cwd } = invocation;
  // A draft for review (#77), never a shipped check: it writes only with --write, and adds only.
  const options = parse('learn', args);
  if (typeof options === 'string') return usage(invocation, args.includes('--upstream') ? upstreamUsage(options) : options);
  const [reference] = options.positional;
  if (options.flags.has('--upstream')) return runUpstream(invocation, options);
  for (const option of ['--list', '--done', '--area', '--fix']) {
    if (options.flags.has(option) || option in options.values) return usage(invocation, `${option} goes with --upstream`);
  }
  const root = rootOf(cwd) ?? cwd;
  // A reviewed lesson ships in the kit (#147): doctor then runs it in every project.
  if (options.flags.has('--ship')) {
    if (options.flags.has('--write')) return usage(invocation, '--ship and --write are two steps: write the draft, review it, then ship it');
    if (reference === undefined) return usage(invocation, 'name the lesson to ship, by its id or its issue number');
    const shipped = shipLesson(root, reference, VERSION, invocation.env);
    if ('problems' in shipped) {
      print(invocation, [`yokoten learn --ship: ${shipped.problems.length} problem(s); nothing was moved:`, ...shipped.problems.map((problem) => `- ${problem}`)], invocation.stderr);
      return 1;
    }
    const { id, folder, url } = shipped.lesson;
    // A project runs the lessons of the yokoten that runs its doctor, so say how each one gets it (#77).
    print(invocation, [
      `yokoten learn --ship: ${id} is in ${KIT_LESSONS_DIR}/${folder}/, with a row in ${KIT_LESSONS_DIR}/${LESSONS_TABLE} (from ${url}, yokoten ${VERSION}).`,
      'Commit it in a pull request. Other projects get it from the yokoten that runs their doctor:',
      "- now: run this copy's bin/yokoten.ts doctor in the project",
      "- this machine: run install from this copy, so `yokoten doctor` has it",
      "- a project's .yokoten/: run init again from this copy, then commit .yokoten/",
      '- everyone else: the next yokoten release',
    ]);
    return 0;
  }
  if (reference === undefined) return usage(invocation, 'name an incident issue, by its number or its URL');
  const incident = readIncident(ghIn(root), reference);
  if (typeof incident === 'string') {
    print(invocation, [`yokoten learn: ${incident}`], invocation.stderr);
    return 1;
  }
  const draft = draftLesson(incident);
  const [first, ...rest] = formatDraft(incident, draft);
  if (!options.flags.has('--write')) {
    print(invocation, [`yokoten learn: ${first}`, ...rest, '', `Nothing was written. \`yokoten learn ${reference} --write\` adds these files for review.`]);
    return 0;
  }
  const { written, kept } = writeDraft(root, draft);
  print(invocation, [
    `yokoten learn: ${first}`,
    ...rest.slice(0, rest.indexOf('')),
    ...(written.length ? ['Wrote:', ...written.map((path) => `- ${path}`)] : []),
    ...(kept.length ? ['Kept, already there:', ...kept.map((path) => `- ${path}`)] : []),
    'Review the draft: fill in each TODO, write the check, and make its test pass.',
  ]);
  return 0;
}

/** What a note must not carry out of the project at hand (#392). Local git and files only, no network. */
function notePlace({ env, cwd }: Invocation, root: string | null, { withProject = true }: { withProject?: boolean } = {}): NotePlace {
  const found = machineMarks(env, { cwd: root ?? cwd });
  const owners = [
    ...found.filter((mark) => mark.kind === 'git name' || mark.kind === 'git email').map((mark) => mark.value),
    // The login gh keeps on this machine, read from its config file: gh's own lookup would call the network.
    ...readLocalLogins(env),
    // The Linux and Windows user names, which git and gh may not know (#404).
    ...machineUserNames(env),
  ];
  const hosts = found.filter((mark) => mark.kind === 'private remote host').map((mark) => mark.value);
  const projects: string[] = [];
  // In yokoten's own repo, "yokoten" is the subject of the note, not a detail to hide.
  if (withProject && root && !isSelf(root)) {
    projects.push(basename(root));
    try {
      const name: unknown = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).name;
      if (typeof name === 'string') projects.push(name, name.replace(/^@[^/]+\//, ''));
    } catch {}
    const origin = originParts(readOriginUrl(root));
    owners.push(...origin.owners);
    if (origin.project) projects.push(origin.project);
  }
  return { root, projects, owners, hosts, marks: loadMarks(env), cwd };
}

/** The areas a note may name: yokoten's own, when this copy has its yokoten.json; else any lowercase word. */
function knownAreas(): string[] {
  return existsSync(join(HOME_DIR, 'yokoten.json')) ? loadConfig(HOME_DIR).areas : [];
}

/** `learn --upstream`: keep, list or remove a note for the yokoten repo (#392). It never calls the network. */
function runUpstream(invocation: Invocation, options: Parsed): number {
  const { env, cwd } = invocation;
  const [text] = options.positional;
  const inbox = upstreamDir(env);
  for (const option of ['--write', '--ship']) if (options.flags.has(option)) return usage(invocation, `--upstream and ${option} don't go together`);
  const isList = options.flags.has('--list');
  const isDone = options.flags.has('--done');
  if (isList || isDone) {
    for (const option of ['--area', '--fix']) if (option in options.values) return usage(invocation, `${option} goes with a new note, not with ${isList ? '--list' : '--done'}`);
  }
  if (isList) {
    if (text !== undefined || isDone) return usage(invocation, '--list takes nothing more');
    const notes = listNotes(env);
    if (!notes.length) {
      print(invocation, ['yokoten learn --upstream: no lessons wait; the inbox is empty.']);
      return 0;
    }
    // Cleaned again as they are shown: a file in the inbox may have been edited by hand.
    const clean = makeNoteCleaner(notePlace(invocation, rootOf(cwd), { withProject: false }), env);
    print(invocation, [
      `yokoten learn --upstream: ${notes.length} ${notes.length === 1 ? 'lesson waits' : 'lessons wait'} to become an issue in the yokoten repo:`,
      ...notes.flatMap((note) => [
        `- ${note.id} (${clean(note.when.replace('T', ' ').replace(/:\d\dZ$/, ''))} UTC, part: ${clean(note.part)}): ${clean(note.what)}`,
        ...(note.fix ? [`  fix idea: ${clean(note.fix)}`] : []),
      ]),
      'Open an issue for each, then remove its note: yokoten learn --upstream --done <id>',
    ]);
    return 0;
  }
  if (isDone) {
    if (text === undefined) return usage(invocation, 'name the note to remove, by its id from --list');
    // The argument is never repeated back: it may be anything that was typed.
    if (!NOTE_ID.test(text)) return usage(invocation, 'that is not a note id; see the ids with `yokoten learn --upstream --list`');
    if (!removeNote(env, text)) {
      print(invocation, ['yokoten learn --upstream: there is no note with that id. See the ids with: yokoten learn --upstream --list'], invocation.stderr);
      return 1;
    }
    print(invocation, [`yokoten learn --upstream: removed note ${text}.`]);
    return 0;
  }
  if (text === undefined || !text.trim()) return usage(invocation, 'say what happened, in a few words: yokoten learn --upstream "<what happened>"');
  if (!inbox) {
    print(invocation, [`yokoten learn --upstream: the note was not kept, because ${NO_HOME}. Set HOME to your home folder, and try again.`], invocation.stderr);
    return 1;
  }
  const area = options.values['--area'];
  if (area !== undefined) {
    const areas = knownAreas();
    if (areas.length ? !areas.includes(area) : !/^[a-z][a-z0-9-]*$/.test(area)) return usage(invocation, areas.length ? `--area is one of: ${areas.join(', ')}` : '--area is one lowercase word, such as hook');
  }
  const place = notePlace(invocation, rootOf(cwd));
  const what = redactNote(text, place, env);
  const fixIdea = options.values['--fix'] === undefined ? undefined : redactNote(options.values['--fix'], place, env);
  const part = area === undefined ? undefined : redactNote(area, place, env);
  const problems = [what, fixIdea, part].flatMap((field) => (field && 'problems' in field ? field.problems : []));
  if (problems.length || !('text' in what)) {
    // The kind of detail only: the value itself is never printed (core rule 11).
    const kinds = [...new Set(problems.map((problem) => (problem.id === 'private-mark' ? 'a line of your private-marks file' : problem.what)))];
    print(invocation, [`yokoten learn --upstream: the note was not kept, because it holds ${kinds.join(' and ')}. Say what happened without it, and try again.`], invocation.stderr);
    return 1;
  }
  const fix = fixIdea && 'text' in fixIdea && fixIdea.text ? fixIdea.text : undefined;
  const note = writeNote(env, { part: part && 'text' in part ? part.text : 'unknown', what: what.text, ...(fix ? { fix } : {}) });
  print(invocation, [
    `yokoten learn --upstream: kept note ${note.id} in ${inbox}, outside every repo. It reads:`,
    `  ${note.what}`,
    ...(note.fix ? [`  fix idea: ${note.fix}`] : []),
    'In the yokoten repo, the session start counts it until you open an issue for it.',
  ]);
  return 0;
}
