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
  /** Where the rule is explained in full, as a URL. Left out when no section fits. */
  docs?: string;
  /** Where, relative to the repo root. With `check --history`, the path and the git object. */
  file?: string;
  line?: number;
}

/** A rule as `explain` tells it: the rule, its reason, and the check that holds it. */
export interface Rule {
  rule: string;
  why: string;
  check: string;
  /** Where the rule is explained in full, as a URL. */
  docs?: string;
}

/**
 * Where the rules are explained: the guide on GitHub for now (#94). The site's Docs
 * pages (#85) can replace it here, in one place.
 */
export const DOCS_URL = 'https://github.com/yokoten-labs/yokoten/blob/main/docs/guide.md';
const guide = (section: string) => `${DOCS_URL}#${section}`;

const RELEASE_WHY = 'only the owner decides when to release';
const PR_CHECK = '`yokoten check --pr` in CI reads the pull request';
const SERVER_CHECK = 'full `doctor` reads it from the code host (for GitHub, with your `gh` sign-in), when the origin remote is on a host yokoten knows';

/**
 * Every rule a check or a guard reports, by id. Step ids (the road) are in
 * src/setup/road.ts; the two lists never share an id.
 */
export const RULES = {
  release: {
    rule: 'only the owner creates tags and releases (core rule 3)',
    why: RELEASE_WHY,
    check: 'the tool-call guard stops a tag push (`--tags`, `--follow-tags`, `--mirror`, a `v*` or `refs/tags/` ref), `gh release` and `npm publish`, unless the session started with YOKOTEN_RELEASE_APPROVAL; a tag ruleset on the server is the lock',
    docs: guide('the-core-rules'),
  },
  'force-push': {
    rule: 'no plain force push (core rule 7)',
    why: 'a plain force push can throw away work that someone else pushed',
    check: 'the tool-call guard stops `git push --force`, `-f` and a `+ref`; `--force-with-lease` passes; a branch ruleset on the server is the lock',
    docs: guide('the-core-rules'),
  },
  'skip-check': {
    rule: 'never skip the commit check (core rule 6)',
    why: 'the commit check is the inspection step, and a skipped check makes a broken commit look reviewed',
    check: 'the tool-call guard stops `--no-verify` and `git commit -n`; CI runs the same check',
    docs: guide('the-core-rules'),
  },
  'hooks-path': {
    rule: 'never turn off the commit check (core rule 6)',
    why: 'git runs the commit check from core.hooksPath, so another value turns the check off',
    check: 'the tool-call guard lets a read of core.hooksPath through, and stops any other value than .githooks: `git config`, `git -c`, `--config-env` and GIT_CONFIG_KEY_n; the commit-check step looks at the setting',
    docs: guide('the-core-rules'),
  },
  'test-file': {
    rule: 'a fix task changes code, never tests (core rule 4)',
    why: 'a fix task changes the code until the test passes, never the test',
    check: 'with YOKOTEN_FIX_TASK=1, the tool-call guard stops an edit to a file that yokoten.json "tests" matches, and the commit check refuses it',
    docs: guide('the-core-rules'),
  },
  'lead-only': {
    rule: 'a worker does not change lead-only files: the rules, agent config, hooks and CI (core rule 5)',
    why: 'a worker must not change the rules it works under, and a pull request that edits CI runs that CI before anyone reads it',
    check: 'with YOKOTEN_ROLE=worker, the tool-call guard stops an edit to a file that yokoten.json "leadOnly" matches, and the commit check refuses it',
    docs: guide('the-core-rules'),
  },
  email: {
    rule: 'no personal email address in the repo (core rule 11)',
    why: 'an email address points at a person, and git keeps it after the file is gone',
    check: 'the commit check, CI and `check --history` look for email addresses; noreply addresses, example.com and team inboxes at public services pass, and yokoten.json "privacy.allow" lets one through',
    docs: guide('privacy'),
  },
  ip: {
    rule: 'no IP address in the repo (core rule 11)',
    why: 'an IP address can lead to your server or your home network',
    check: 'the commit check, CI and `check --history` look for IPv4 addresses; localhost and the documentation ranges pass',
    docs: guide('privacy'),
  },
  'private-mark': {
    rule: 'nothing in the repo points at you: your name, city, domain or servers (core rule 11)',
    why: 'a line of your private-marks file names something that points at you',
    check: 'the commit check reads ~/.config/yokoten/private-marks, outside the repo, and looks for each line; CI does not have the file',
    docs: guide('privacy'),
  },
  secret: {
    rule: 'no secret in the repo: no token and no private key (core rule 11)',
    why: 'a secret opens your accounts to anyone who can read the repo, and git keeps it after the file is gone',
    check: 'the commit check, CI and `check --history` look for the real shape of tokens (GitHub, npm, AWS, Slack, Stripe, Google, Anthropic, OpenAI) and of private keys',
    docs: guide('privacy'),
  },
  'shallow-history': {
    rule: '`check --history` reads the whole history, so it needs a full clone with no grafts file',
    why: 'a shallow clone holds only the newest commits, and a grafts file can hide commits, so a secret in a hidden commit goes unseen',
    check: '`check --history` asks git whether the clone is shallow (`git rev-parse --is-shallow-repository`) and looks for `info/grafts` in the git directory; if either is there, it scans nothing and fails with this finding. Replace refs are read past (`git --no-replace-objects`)',
    docs: guide('privacy'),
  },
  'time-zone': {
    rule: 'commit times are UTC (core rule 12)',
    why: 'a time zone narrows down where you live',
    check: 'the commit check reads the next commit\'s author and committer time; `check --history` counts older commits, as a note',
    docs: guide('privacy'),
  },
  layout: {
    rule: 'no folder holds more than 7 entries; the root is not counted (core rule 10)',
    why: 'a flat folder grows until nobody can find anything',
    check: 'the commit check and CI count the entries of each folder below the root; changes/ and the folders in yokoten.json "layout.exempt" may grow',
    docs: guide('the-core-rules'),
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
    docs: guide('the-core-rules'),
  },
  'pr-tier': {
    rule: 'a pull request body starts with `tier: A`, `tier: B` or `tier: C` (core rule 8)',
    why: 'the tier says how hard a mistake is to take back, and so who must review it',
    check: PR_CHECK,
    docs: guide('who-reviews-what'),
  },
  'pr-owned': {
    rule: 'a pull request that changes a file CODEOWNERS owns is tier A; the paths set the lowest tier, and the author can only raise it (core rule 8)',
    why: 'CODEOWNERS names the files where a mistake is hard to undo, and those need the owner\'s review',
    check: `${PR_CHECK}, with CODEOWNERS from the base branch, so a pull request can't change the file to lower its own tier; no CODEOWNERS file, no check`,
    docs: guide('who-reviews-what'),
  },
  'pr-section': {
    rule: 'a pull request body has Why, What changed and How tested sections (core rule 8)',
    why: 'a reviewer reads the same shape every time, and nothing is forgotten',
    check: PR_CHECK,
    docs: guide('the-core-rules'),
  },
  'pr-issue': {
    rule: 'a pull request links its issue (core rules 1 and 8)',
    why: 'every change starts as an issue',
    check: PR_CHECK,
    docs: guide('the-core-rules'),
  },
  'pr-changelog': {
    rule: 'a pull request that changes behaviour adds a file in changes/ (core rule 8)',
    why: 'each pull request adds its own file, so pull requests never conflict and a release needs no digging',
    check: `${PR_CHECK}; a new line in CHANGELOG.md counts too; docs, tests and CI need no entry, and \`No changelog: <reason>\` in the body lets code through`,
    docs: guide('the-changelog'),
  },
  'change-file': {
    rule: 'a change file has its section on line 1, a blank line 2, then the entry (core rule 8)',
    why: '`yokoten changelog` puts each entry under its section in CHANGELOG.md, so it must read the file',
    check: `${PR_CHECK} and each change file it adds or edits; \`yokoten changelog\` writes nothing while a change file is wrong`,
    docs: guide('the-changelog'),
  },
  'pr-kit': {
    rule: 'a pull request that changes kit/ says so (core rule 8)',
    why: 'a change in kit/ reaches every project on its next init',
    check: PR_CHECK,
    docs: guide('the-core-rules'),
  },
  'pr-milestone': {
    rule: 'a pull request has a milestone (core rule 8)',
    why: 'the board and the roadmap show work by milestone',
    check: PR_CHECK,
    docs: guide('the-core-rules'),
  },
  'pr-labels': {
    rule: 'a pull request has one type label, and one tier label that matches the `tier:` line in its body (core rule 8)',
    why: 'a reviewer filters on labels to find what kind of change it is and what needs the owner',
    check: PR_CHECK,
    docs: guide('the-core-rules'),
  },
  'pr-commits': {
    rule: 'the checkout of a pull request run has its base and head commits, and the history between them',
    why: 'yokoten reads the changed files from git, between the base and the head commit, so without them nothing in the pull request is checked',
    check: `${PR_CHECK}; it looks for both commits and a common commit before it reads the diff, and fails when one is missing`,
    docs: guide('use-it-as-a-github-action'),
  },
  'ci-event': {
    rule: '`check --pr` and `check --issue` read the event file of the CI run',
    why: 'the pull request or the issue is in that file, so without it nothing is checked',
    check: 'in a CI run, `check --pr` and `check --issue` fail when the event file is missing or is not a JSON object; with no event file named, they skip',
    docs: guide('use-it-as-a-github-action'),
  },
  'issue-area': {
    rule: 'an issue title starts with its area: `area: verb phrase` for a task, `area: symptom` for an incident',
    why: 'the area tells a reader which part of the project the issue is about',
    check: '`yokoten check --issue` in CI reads the issue when it is opened or edited; yokoten.json "areas" limits the areas',
    docs: guide('issue-titles'),
  },
  'issue-title': {
    rule: 'an issue title has at most 60 characters, no full stop at the end and no issue number',
    why: 'a long title is cut off in lists and boards',
    check: '`yokoten check --issue` in CI reads the issue when it is opened or edited',
    docs: guide('issue-titles'),
  },
  'long-sentence': {
    rule: 'plain English: a sentence has at most 25 words (record 0005)',
    why: 'beginners, second-language readers and agents misread long sentences',
    check: '`check --pr` notes long sentences in changed Markdown, skipping code, tables and headings; a note never fails CI',
  },
  'name-short': {
    rule: 'a one-letter name is used within 10 lines and not exported (record 0006; docs/guide.md#naming)',
    why: 'a reader must scroll back to learn what a far-off letter holds',
    check: '`check --pr` notes a one-letter name used more than 10 lines after it is declared, or exported, on lines added to TypeScript and JavaScript files; `_` for an unused parameter passes; a note never fails CI',
    docs: guide('naming'),
  },
  'name-long': {
    rule: 'a name has at most 4 words (record 0006; docs/guide.md#naming)',
    why: 'a long name is slow to read, and the words that matter get lost',
    check: '`check --pr` notes a name of more than 4 words on lines added to TypeScript and JavaScript files; camelCase, PascalCase and snake_case words count, an acronym as one; a note never fails CI',
    docs: guide('naming'),
  },
  'translation-behind': {
    rule: 'a translation follows its English source (record 0007)',
    why: 'a reader of the translation gets old or missing steps without knowing it',
    check: '`check` reads line 1 of each Markdown and HTML file; `<!-- source: <path> -->` names the English file; when the last commit that changed the English is later than the last commit that changed the translation, in first-parent history, it is a note (an older marker with `blob <sha>` still works, and a matching blob is current); yokoten.json `"translations": { "fail": true }` makes it a problem',
    docs: guide('translations'),
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
    docs: guide('works-with'),
  },
  'gemini-hook': {
    rule: "the project has Gemini CLI's tool-call guard",
    why: "without it, Gemini CLI's commands and edits in this project are not checked",
    check: '`doctor` reads .gemini/settings.json for a BeforeTool hook that runs `yokoten hook --agent gemini`; a note, not a missing step',
    docs: guide('works-with'),
  },
  'core-rules': {
    rule: 'the core rules in AGENTS.md are the ones in the kit of the yokoten you run',
    why: 'a lesson added to the core rules reaches a project only when its AGENTS.md gets the new text',
    check: '`doctor` compares everything above `## This project` in AGENTS.md with the kit\'s core rules, and a session hears when they differ; without that heading it can\'t compare, as a note; a `<!-- yokoten kit X.Y.Z -->` mark newer than the yokoten you run is a note to update yokoten itself, and `update` refuses it; `yokoten update` shows the change, and `--write` makes it',
    docs: guide('updating-the-rules'),
  },
  'session-doctor': {
    rule: 'every session starts with `yokoten doctor --session`',
    why: 'the agent then hears the next step on the road, and a drifted setup shows at once',
    check: '`doctor` reads ~/.claude/settings.json for a SessionStart hook that runs doctor',
    docs: guide('what-a-session-sees'),
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
    docs: guide('privacy'),
  },
  'server-settings': {
    rule: 'doctor reads the settings the owner sets on the server, and never changes them',
    why: 'the server is the lock: its settings hold even when a hook is off',
    check: `${SERVER_CHECK}; a part it can't read shows as "can't check", with the fix`,
  },
  'main-rules': {
    rule: 'a ruleset on the default branch requires a pull request and blocks force pushes and deletion (core rules 2 and 7)',
    why: 'without it, one push can change or delete main with no review',
    check: SERVER_CHECK,
    docs: guide('the-core-rules'),
  },
  'required-checks': {
    rule: 'the ruleset on the default branch names the CI checks that must pass (core rule 2)',
    why: 'without a named check, a pull request can merge while CI is red',
    check: SERVER_CHECK,
    docs: guide('the-core-rules'),
  },
  'code-owner-review': {
    rule: 'the ruleset on the default branch requires review from the code owners',
    why: 'then you review every pull request an agent opens before it merges',
    check: SERVER_CHECK,
    docs: guide('who-reviews-what'),
  },
  'squash-only': {
    rule: 'pull requests merge by squash only (core rule 8)',
    why: 'one pull request becomes one commit on main, with its title as the message',
    check: `${SERVER_CHECK}: the repo settings, or the merge methods the ruleset allows`,
    docs: guide('the-core-rules'),
  },
  'delete-branch': {
    rule: 'the host deletes a branch when its pull request merges',
    why: 'merged branches pile up, and nobody can tell which ones are still in use',
    check: SERVER_CHECK,
  },
  'tag-rules': {
    rule: 'a ruleset on v* tags limits who creates, moves or deletes a release tag (core rule 3)',
    why: 'only the owner decides when to release, whatever an agent\'s token can do',
    check: `${SERVER_CHECK}: an active tag ruleset on v* with creation, update and deletion restricted`,
    docs: guide('the-core-rules'),
  },
  'security-switches': {
    rule: 'secret scanning, push protection, private vulnerability reporting and Dependabot alerts are on',
    why: 'the host then stops a pushed secret, and people can report a hole in private',
    check: `${SERVER_CHECK}; some switches are visible only to a repo admin`,
  },
  'forgotten-branches': {
    rule: 'every branch on the server has an open pull request, or is deleted by its owner',
    why: 'a forgotten branch holds work nobody is looking at',
    check: `${SERVER_CHECK}; a note only, and doctor never deletes a branch`,
  },
} satisfies Record<string, Rule>;

export type RuleId = keyof typeof RULES;

/** A finding for a rule: its reason and its link come from the table, unless `why` says it better here. */
export function finding(id: RuleId, what: string, fix: string, more: { file?: string; line?: number; why?: string } = {}): Finding {
  const rule: Rule = RULES[id];
  const f: Finding = { id, what, why: more.why ?? rule.why, fix };
  if (rule.docs !== undefined) f.docs = rule.docs;
  if (more.file !== undefined) f.file = more.file;
  if (more.line !== undefined) f.line = more.line;
  return f;
}

const sentence = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** Where a finding is, as `file:line: `, or nothing. */
export const place = (f: Finding): string => (f.file === undefined ? '' : `${f.file}${f.line === undefined ? '' : `:${f.line}`}: `);

/**
 * The text form: `place: what. Why. Fix.` `what` is kept as written, to follow a prefix.
 * A link, when there is one, goes on its own line below: `  docs: <url>`.
 */
export const formatFinding = (f: Finding): string =>
  `${place(f)}${f.what}. ${sentence(f.why)}. ${sentence(f.fix)}.${f.docs === undefined ? '' : `\n  docs: ${f.docs}`}`;
