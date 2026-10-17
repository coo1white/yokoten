// One shape for everything yokoten reports (#42): what happened, why it matters, and the
// fix. Two readers get it: a person reads the text form, and an agent reads the same
// fields as JSON (`--json`), so it reads data, not prose.
//
// Every field is plain text with no full stop at the end; the text form adds them. A
// field never holds a private value (core rule 11): a hit is named by its place and its
// kind, never by what matched.

/** One message: a problem, a blocked action, a note, or a step on the road not done. */
export interface Finding {
  /** The rule or step behind it. `yokoten explain <id>` says more. */
  id: string;
  /** What happened. Written to follow a place (`a.md:3: `) or a prefix (`yokoten: `). */
  what: string;
  /** Why it matters. */
  why: string;
  /** What to do: a command or an edit. */
  fix: string;
  /** Where, relative to the repo root. With `check --history`, the path and the git object. */
  file?: string;
  line?: number;
}

/** A rule as `explain` tells it: the rule, its reason, and the check that holds it. */
export interface Rule {
  rule: string;
  why: string;
  check: string;
}

const RELEASE_WHY = 'only the owner decides when to release';
const PR_CHECK = '`yokoten check --pr` in CI reads the pull request';

/**
 * Every rule a check or a guard reports, by id. Step ids (the road) are in
 * src/setup/road.ts; the two lists never share an id.
 */
export const RULES = {
  release: {
    rule: 'only the owner creates tags and releases (core rule 3)',
    why: RELEASE_WHY,
    check: 'the tool-call guard stops a tag push (`--tags`, `--follow-tags`, `--mirror`, a `v*` or `refs/tags/` ref), `gh release` and `npm publish`, unless the session started with YOKOTEN_RELEASE_APPROVAL; a tag ruleset on the server is the lock',
  },
  'force-push': {
    rule: 'no plain force push (core rule 7)',
    why: 'a plain force push can throw away work that someone else pushed',
    check: 'the tool-call guard stops `git push --force`, `-f` and a `+ref`; `--force-with-lease` passes; a branch ruleset on the server is the lock',
  },
  'skip-check': {
    rule: 'never skip the commit check (core rule 6)',
    why: 'the commit check is the inspection step, and a skipped check makes a broken commit look reviewed',
    check: 'the tool-call guard stops `--no-verify` and `git commit -n`; CI runs the same check',
  },
  'hooks-path': {
    rule: 'never turn off the commit check (core rule 6)',
    why: 'git runs the commit check from core.hooksPath, so another value turns the check off',
    check: 'the tool-call guard stops `git config core.hooksPath` with any value but .githooks; the commit-check step looks at the setting',
  },
  'test-file': {
    rule: 'a fix task changes code, never tests (core rule 4)',
    why: 'a fix task changes the code until the test passes, never the test',
    check: 'with YOKOTEN_FIX_TASK=1, the tool-call guard stops an edit to a file that yokoten.json "tests" matches, and the commit check refuses it',
  },
  'lead-only': {
    rule: 'a worker does not change lead-only files: the rules, agent config, hooks and CI (core rule 5)',
    why: 'a worker must not change the rules it works under, and a pull request that edits CI runs that CI before anyone reads it',
    check: 'with YOKOTEN_ROLE=worker, the tool-call guard stops an edit to a file that yokoten.json "leadOnly" matches, and the commit check refuses it',
  },
  email: {
    rule: 'no personal email address in the repo (core rule 11)',
    why: 'an email address points at a person, and git keeps it after the file is gone',
    check: 'the commit check, CI and `check --history` look for email addresses; noreply addresses, example.com and team inboxes at public services pass, and yokoten.json "privacy.allow" lets one through',
  },
  ip: {
    rule: 'no IP address in the repo (core rule 11)',
    why: 'an IP address can lead to your server or your home network',
    check: 'the commit check, CI and `check --history` look for IPv4 addresses; localhost and the documentation ranges pass',
  },
  'private-mark': {
    rule: 'nothing in the repo points at you: your name, city, domain or servers (core rule 11)',
    why: 'a line of your private-marks file names something that points at you',
    check: 'the commit check reads ~/.config/yokoten/private-marks, outside the repo, and looks for each line; CI does not have the file',
  },
  secret: {
    rule: 'no secret in the repo: no token and no private key (core rule 11)',
    why: 'a secret opens your accounts to anyone who can read the repo, and git keeps it after the file is gone',
    check: 'the commit check, CI and `check --history` look for the real shape of tokens (GitHub, npm, AWS, Slack, Stripe, Google, Anthropic, OpenAI) and of private keys',
  },
  'time-zone': {
    rule: 'commit times are UTC (core rule 12)',
    why: 'a time zone narrows down where you live',
    check: 'the commit check reads the next commit\'s author and committer time; `check --history` counts older commits, as a note',
  },
  layout: {
    rule: 'no folder holds more than 7 entries; the root is not counted (core rule 10)',
    why: 'a flat folder grows until nobody can find anything',
    check: 'the commit check and CI count the entries of each folder below the root; yokoten.json "layout.exempt" lets a log grow',
  },
  'build-output': {
    rule: 'no build output in a commit',
    why: 'a build makes it again from the source, so a committed copy goes stale',
    check: 'the commit check refuses a file in a dist/, build/ or out/ folder; yokoten.json "allowBuild" lets a path through',
  },
  binary: {
    rule: 'no binary file in a commit, apart from images and fonts',
    why: "a reviewer can't read it, and it may not match the source",
    check: 'the commit check refuses a file git sees as binary, and a built file by its name (.exe, .zip, .wasm and others); images and fonts pass',
  },
  'pr-title': {
    rule: 'a pull request title has the commit form, `type(area): summary`, in at most 72 characters (core rule 8)',
    why: 'the title becomes the one commit on main',
    check: PR_CHECK,
  },
  'pr-tier': {
    rule: 'a pull request body starts with `tier: A`, `tier: B` or `tier: C` (core rule 8)',
    why: 'the tier says how hard a mistake is to take back, and so who must review it',
    check: PR_CHECK,
  },
  'pr-section': {
    rule: 'a pull request body has Why, What changed and How tested sections (core rule 8)',
    why: 'a reviewer reads the same shape every time, and nothing is forgotten',
    check: PR_CHECK,
  },
  'pr-issue': {
    rule: 'a pull request links its issue (core rules 1 and 8)',
    why: 'every change starts as an issue',
    check: PR_CHECK,
  },
  'pr-changelog': {
    rule: 'a pull request that changes behaviour adds a line to CHANGELOG.md (core rule 8)',
    why: 'each pull request adds its line as it goes, so a release needs no digging',
    check: `${PR_CHECK}; docs, tests and CI need no line, and \`No changelog: <reason>\` in the body lets code through`,
  },
  'pr-kit': {
    rule: 'a pull request that changes kit/ says so (core rule 8)',
    why: 'a change in kit/ reaches every project on its next init',
    check: PR_CHECK,
  },
  'pr-milestone': {
    rule: 'a pull request has a milestone (core rule 8)',
    why: 'the board and the roadmap show work by milestone',
    check: PR_CHECK,
  },
  'pr-labels': {
    rule: 'a pull request has a type label and a tier label (core rule 8)',
    why: 'labels say what kind of change it is and how hard it is to take back',
    check: PR_CHECK,
  },
  'long-sentence': {
    rule: 'plain English: a sentence has at most 25 words (record 0005)',
    why: 'beginners, second-language readers and agents misread long sentences',
    check: '`check --pr` notes long sentences in changed Markdown, skipping code, tables and headings; a note never fails CI',
  },
  'large-diff': {
    rule: 'a pull request changes at most about 400 lines (record 0004)',
    why: 'smaller pull requests are easier to review',
    check: '`check --pr` counts lines added and deleted, without lock files and binary files; a note, never a failure',
  },
  'self-test': {
    rule: 'every check catches a known-bad input',
    why: 'a check that passes everything looks the same as a healthy project',
    check: '`doctor` feeds each check a known-bad input before anything else',
  },
  'codex-hook': {
    rule: "the project has Codex's tool-call guard",
    why: "without it, Codex's commands and edits in this project are not checked",
    check: '`doctor` reads .codex/hooks.json for a PreToolUse hook that runs `yokoten hook --agent codex`; a note, not a missing step',
  },
  'gemini-hook': {
    rule: "the project has Gemini CLI's tool-call guard",
    why: "without it, Gemini CLI's commands and edits in this project are not checked",
    check: '`doctor` reads .gemini/settings.json for a BeforeTool hook that runs `yokoten hook --agent gemini`; a note, not a missing step',
  },
  'session-doctor': {
    rule: 'every session starts with `yokoten doctor --session`',
    why: 'the agent then hears the next step on the road, and a drifted setup shows at once',
    check: '`doctor` reads ~/.claude/settings.json for a SessionStart hook that runs doctor',
  },
  'machine-runtime': {
    rule: 'the installed runtime is this version of yokoten',
    why: 'the user-level hooks run the installed copy, so an old copy checks old rules',
    check: '`doctor` compares the VERSION file in ~/.local/share/yokoten with its own version',
  },
  'private-marks': {
    rule: 'this machine has a private-marks file with at least one line',
    why: 'without your marks, the privacy check knows only email addresses, IP addresses and secrets',
    check: '`doctor` reads ~/.config/yokoten/private-marks (or YOKOTEN_PRIVATE_MARKS) and counts its lines',
  },
} satisfies Record<string, Rule>;

export type RuleId = keyof typeof RULES;

/** A finding for a rule: its reason comes from the table, unless `why` says it better here. */
export function finding(id: RuleId, what: string, fix: string, more: { file?: string; line?: number; why?: string } = {}): Finding {
  const f: Finding = { id, what, why: more.why ?? RULES[id].why, fix };
  if (more.file !== undefined) f.file = more.file;
  if (more.line !== undefined) f.line = more.line;
  return f;
}

const sentence = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** Where a finding is, as `file:line: `, or nothing. */
export const place = (f: Finding): string => (f.file === undefined ? '' : `${f.file}${f.line === undefined ? '' : `:${f.line}`}: `);

/** The text form: `place: what. Why. Fix.` `what` is kept as written, to follow a prefix. */
export const formatFinding = (f: Finding): string => `${place(f)}${f.what}. ${sentence(f.why)}. ${sentence(f.fix)}.`;
