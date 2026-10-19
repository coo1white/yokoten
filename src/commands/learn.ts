// `yokoten learn` and `yokoten changelog`: what the project learned, and what it changed.

import { ghIn, readIncident } from '../host/github.ts';
import { formatChanges, readChanges, writeChanges } from '../run/changelog.ts';
import { draftLesson, formatDraft, KIT_LESSONS_DIR, LESSONS_TABLE, shipLesson, writeDraft } from '../run/learn.ts';
import { VERSION } from '../setup/files.ts';
import { bullets, parse, print, rootOf, usage } from './shared.ts';

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
