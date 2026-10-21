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
/** A link to a yokoten docs file on GitHub, for a message: a user who installed from npm has no such file (#524). */
export const docsLink = (file: string, section = ''): string => `https://github.com/yokoten-labs/yokoten/blob/main/docs/${file}${section ? `#${section}` : ''}`;
const guide = (section: string) => `${DOCS_URL}#${section}`;

const RELEASE_WHY = 'only the owner decides when to release';
const PR_CHECK = '`yokoten check --pr` in CI reads the pull request';
const UNSAVED_CHECK = '`doctor` and the session note read git and the file system, never change them, and give a note, never a failure';
const SERVER_CHECK ='full `doctor` reads it from the code host (for GitHub, with your `gh` sign-in), when the origin remote is on a host yokoten knows';

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
    why: 'git runs the commit check from core.hooksPath, so a folder whose pre-commit does not run it turns the check off',
    check: 'the tool-call guard lets every read of core.hooksPath through. In the repo\'s own config, `git config` may set .githooks, the value already set, or a folder whose pre-commit runs `yokoten check` (husky: .husky/pre-commit). It stops any other change: `--unset`, `--global`, `git -c`, `--config-env` and GIT_CONFIG_KEY_n. The commit-check step looks at the setting',
    docs: guide('the-core-rules'),
  },
  'blocked-command': {
    rule: 'an agent does not run a program the project blocks in yokoten.json "commands.block"',
    why: 'the project chose its stack, and an agent forgets a rule written only in prose',
    check: 'the tool-call guard stops a command whose program is on the list, with any folder or .exe, in any part of the command and after env, sudo, nice and other wrappers; the reason comes from yokoten.json',
    docs: guide('blocked-commands'),
  },
  'unreadable-command': {
    rule: 'a command the guard cannot read is refused, not let through',
    why: 'the guard reads command text, and a command it cannot read could hide anything',
    check: 'the tool-call guard refuses a tool call, with exit 2, when reading it fails or takes longer than its deadline (5 seconds; YOKOTEN_GUARD_DEADLINE_MS changes it)',
    docs: guide('what-it-doesnt-do'),
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
    check: 'for a worker (YOKOTEN_ROLE=worker, or a subagent named worker), the tool-call guard stops an edit or a shell write to a file that yokoten.json "leadOnly" matches, and a git commit that changes one; with YOKOTEN_ROLE=worker the commit check refuses it too. YOKOTEN_LEAD_ONLY_OK lists the paths the lead allows',
    docs: guide('the-core-rules'),
  },
  email: {
    rule: 'no personal email address in the repo (core rule 11)',
    why: 'an email address points at a person, and git keeps it after the file is gone',
    check: 'the commit check, CI and `check --history` look for email addresses; noreply addresses, example.com and team inboxes at public services pass, and yokoten.json "privacy.allow" lets one through; the tool-call guard also checks the text an agent posts with gh (issues, pull requests, comments, release notes)',
    docs: guide('privacy'),
  },
  ip: {
    rule: 'no IP address in the repo (core rule 11)',
    why: 'an IP address can lead to your server or your home network',
    check: 'the commit check, CI and `check --history` look for IPv4 addresses; localhost and the documentation ranges pass; the tool-call guard also checks the text an agent posts with gh (issues, pull requests, comments, release notes)',
    docs: guide('privacy'),
  },
  'private-mark': {
    rule: 'nothing in the repo points at you: your name, city, domain or servers (core rule 11)',
    why: 'a line of your private-marks file names something that points at you',
    check: 'the commit check reads ~/.config/yokoten/private-marks, outside the repo, and looks for each line; CI does not have the file; the tool-call guard also checks the text an agent posts with gh (issues, pull requests, comments, release notes)',
    docs: guide('privacy'),
  },
  secret: {
    rule: 'no secret in the repo: no token and no private key (core rule 11)',
    why: 'a secret opens your accounts to anyone who can read the repo, and git keeps it after the file is gone',
    check: 'the commit check, CI and `check --history` look for the real shape of tokens (GitHub, npm, AWS, Slack, Stripe, Google, Anthropic, OpenAI) and of private keys; the tool-call guard also checks the text an agent posts with gh (issues, pull requests, comments, release notes)',
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
    check: 'the commit check and CI count the entries of each folder below the root; changes/ and the folders in yokoten.json "layout.exempt" (paths, or globs with `*` and `**`) may grow',
    docs: guide('the-core-rules'),
  },
  'build-output': {
    rule: 'no build output in a commit',
    why: 'a build makes it again from the source, so a committed copy goes stale',
    check: 'the commit check refuses a file in a dist/, build/ or out/ folder; yokoten.json "allowBuild" lets a path through',
  },
  'missing-blob': {
    rule: 'the commit check reads every staged file',
    why: 'a staged file whose copy is not in the object store can\'t be checked, and the commit would fail or hold an unchecked entry',
    check: 'the commit check reads each staged file from the object store by its id, and refuses an entry it can\'t read',
    docs: guide('three-checks-and-a-lock'),
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
    check: `${PR_CHECK} and each change file it adds or edits; \`check\` reads every change file, and \`check --staged\` the staged ones; \`yokoten changelog\` writes nothing while a change file is wrong`,
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
  'pr-read': {
    rule: '`check --pr <number>` reads that pull request through gh',
    why: 'a repo without CI checks its pull requests this way, so without the read nothing is checked',
    check: '`check --pr <number>` asks gh for the title, body, labels, milestone and commits, and fails when gh can\'t read them',
    docs: guide('a-private-repo-without-ci'),
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
    check: '`check --pr` notes long sentences in changed Markdown, and `check --staged` in staged change files, skipping code, tables and headings; a note never fails CI',
  },
  'name-short': {
    rule: 'a one-letter name is used within 10 lines and not exported (record 0006)',
    why: 'a reader must scroll back to learn what a far-off letter holds',
    check: '`check --pr` notes a one-letter name used more than 10 lines after it is declared, or exported, on lines added to TypeScript and JavaScript files; `_` for an unused parameter passes; a note never fails CI',
    docs: guide('naming'),
  },
  'name-long': {
    rule: 'a name has at most 4 words (record 0006)',
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
  'config-key': {
    rule: 'yokoten.json holds the keys yokoten knows, each in its own shape (#228)',
    why: 'yokoten ignores a key it does not know, so a misspelled key looks set but does nothing',
    check: '`check` notes a key it does not know; a key with the wrong shape is a config error for `check` and `doctor`, and the tool-call hook uses that key\'s default and says so in one line',
    docs: guide('yokotenjson'),
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
  'copilot-hook': {
    rule: 'Copilot CLI trusts this folder, so it runs the hooks in .claude/settings.json',
    why: 'in a folder it does not trust, Copilot CLI skips the hooks without a word, so its commands and edits are not checked',
    check: "`doctor` looks for this folder, or a folder above it, in `trustedFolders` in Copilot's config.json (read-only); a note, not a missing step",
    docs: guide('works-with'),
  },
  'codex-hook': {
    rule: "the project has Codex's tool-call guard and stop check, and Codex trusts the folder and both hooks",
    why: "without them, Codex's commands and edits in this project are not checked, and its turn can end with a bad file. Codex skips an untrusted hook without a word",
    check:
      "`doctor` reads .codex/hooks.json for a PreToolUse hook and a Stop hook that each run `yokoten hook`, then Codex's config.toml for the folder's trust and each hook's trusted hash (read-only); a note, not a missing step",
    docs: guide('works-with'),
  },
  'gemini-hook': {
    rule: "the project has Gemini CLI's tool-call guard and stop check",
    why: "without them, Gemini CLI's commands and edits in this project are not checked, and its turn can end with a bad file",
    check: '`doctor` reads .gemini/settings.json for a BeforeTool hook and an AfterAgent hook that each run `yokoten hook`; a note, not a missing step',
    docs: guide('works-with'),
  },
  'antigravity-hook': {
    rule: "the project has Antigravity CLI's tool-call guard",
    why: "without it, Antigravity CLI's commands and edits in this project are not checked",
    check: '`doctor` reads .agents/hooks.json for the `yokoten` PreToolUse hook that runs `yokoten hook --agent antigravity`; a note, not a missing step',
    docs: guide('works-with'),
  },
  'muse-hook': {
    rule: "the project has Muse Code's tool-call guard and stop check, and Muse trusts the folder",
    why: "without them, Muse Code's commands and edits in this project are not checked. Muse skips the hooks of a folder it does not trust without a word",
    check: "`doctor` reads .muse/hooks.json for a PreToolUse hook and a Stop hook that each run `yokoten hook --agent muse`, then Muse's trust.json for the folder (read-only); a note, not a missing step",
    docs: guide('works-with'),
  },
  'deepseek-harness-hook': {
    rule: "the project has DeepSeek Harness's tool-call guard, and a dsh profile has the hook bridge",
    why: 'without the bridge and its peer in the profile, dsh runs no hooks and says nothing, so its commands and edits are not checked',
    check:
      "`doctor` reads .dsh/hooks.json for a PreToolUse hook on `bash|pwsh|edit|write` that runs `yokoten hook --agent deepseek-harness`. It checks .dsh/yokoten.patch.yml, and looks for both packages in the dsh profiles (read-only). It is a note, not a missing step. Only a real deny proves the guard runs. On Windows it says dsh is not checked yet",
    docs: guide('works-with'),
  },
  'grok-hook': {
    rule: "the project has Grok CLI's tool-call guard and stop check, and Grok trusts the folder",
    why: "without them, Grok CLI's commands and edits in this project are not checked. Grok skips the hooks of a folder it does not trust without a word",
    check: "`doctor` reads .grok/hooks/yokoten.json for a PreToolUse hook and a Stop hook that each run `yokoten hook --agent grok`, then Grok's trusted_folders.toml for the folder (read-only); a note, not a missing step",
    docs: guide('works-with'),
  },
  'codex-user-hook': {
    rule: "Codex runs yokoten's session-start doctor and command guard in every repo",
    why: 'without them, a Codex session does not hear the next step on the road, and a tag push, force push or skipped check in a repo without yokoten is not stopped',
    check: "when ~/.codex is a folder, `doctor` compares the SessionStart and PreToolUse hooks in ~/.codex/hooks.json with what `yokoten install` writes (command, matcher, runtime path); a missing or out-of-date hook, or a file it can't read, is a note, not a missing step",
    docs: guide('works-with'),
  },
  'gemini-user-hook': {
    rule: "Gemini CLI runs yokoten's session-start doctor and command guard in every repo",
    why: 'without them, a Gemini CLI session does not hear the next step on the road, and a tag push, force push or skipped check in a repo without yokoten is not stopped',
    check: "when ~/.gemini is a folder, `doctor` compares the SessionStart and BeforeTool hooks in ~/.gemini/settings.json with what `yokoten install` writes (command, matcher, name, runtime path); a missing or out-of-date hook, or a file it can't read, is a note, not a missing step",
    docs: guide('works-with'),
  },
  'grok-user-hook': {
    rule: "Grok CLI runs yokoten's command guard in every repo",
    why: 'without it, a tag push, force push or skipped check by Grok CLI in a repo without yokoten is not stopped',
    check: "when ~/.grok is a folder, `doctor` compares the PreToolUse hook in ~/.grok/hooks/yokoten.json with what `yokoten install` writes (command, matcher, timeout, runtime path); a missing or out-of-date hook, or a file it can't read, is a note, not a missing step",
    docs: guide('works-with'),
  },
  'core-rules': {
    rule: 'the core rules in AGENTS.md are the ones in the kit of the yokoten you run',
    why: 'a lesson added to the core rules reaches a project only when its AGENTS.md gets the new text',
    check: '`doctor` compares everything above `## This project` in AGENTS.md with the kit\'s core rules, and a session hears when they differ; without that heading it can\'t compare, as a note; a `<!-- yokoten kit X.Y.Z -->` mark newer than the yokoten you run is a note to update yokoten itself, and `update` refuses it; `yokoten update` shows the change, and `--write` makes it',
    docs: guide('updating-the-rules'),
  },
  'kit-workflows': {
    rule: "the project's CI workflows from the kit are the kit's newest, or the project's own on purpose",
    why: 'a fix to the kit\'s CI reaches a project only when its workflow file gets the new text',
    check: "`init` and full `doctor` compare each kit workflow in .github/workflows/ with the kit's list of the versions it wrote; `init` replaces an old copy the project never changed, and a copy with the project's changes is a note with the command that shows the difference",
    docs: guide('commands'),
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
  'plugin-version': {
    rule: 'the enabled Claude Code plugin is not older than the yokoten that runs doctor',
    why: "the plugin's hooks run the plugin's own copy, so an old plugin checks old rules",
    check: "`doctor` compares the plugin's package version with its own and, in yokoten's own repo, the plugin's commit with the default branch's tip (origin/HEAD, else origin/main, else main); a note, never a failure, and nothing when it can't compare offline",
    docs: guide('the-claude-code-plugin'),
  },
  'private-marks': {
    rule: 'this machine has a private-marks file with at least one line',
    why: 'without your marks, the privacy check knows only email addresses, IP addresses and secrets',
    check: '`doctor` reads ~/.config/yokoten/private-marks (or YOKOTEN_PRIVATE_MARKS) and counts its lines',
    docs: guide('privacy'),
  },
  'disk-space': {
    rule: 'the disk that holds the repo has room left (record 0012)',
    why: 'on a full disk, every agent session stops, and the agent cannot tell you why',
    check: '`doctor` reads the free space of the disk that holds the repo, with no child process; it warns below 20 GB when that is also under 10% of the disk (YOKOTEN_MIN_FREE_GB sets another limit). In WSL, full `doctor` also reads the Windows drive that holds the Linux disk file, and a session repeats the last reading; a note, never a failure',
    docs: guide('machine-notes'),
  },
  'agent-temp-dir': {
    rule: "the agent's temp folder belongs to you (record 0012)",
    why: 'Claude Code will not start when another user, such as root, owns its temp folder',
    check: "full `doctor` compares the owner of Claude Code's temp folder (`claude-<uid>` in the temp folder) with your uid; a note, never a failure, and doctor never deletes it",
    docs: guide('machine-notes'),
  },
  'leftover-temp-folders': {
    rule: 'test runs do not leave their folders in the temp folder (#400)',
    why: 'thousands of old test folders fill the disk, and a full disk stops every session',
    check: 'full `doctor` reads each temp folder once and counts the `yokoten-*` folders older than a day (one lstat each, no size); a note, never a failure, and doctor prints the command to remove them but never deletes',
    docs: guide('machine-notes'),
  },
  'private-output': {
    rule: 'an agent reads command output with your details hidden',
    why: 'output an agent reads goes into the transcript and to the model, and it cannot be taken back',
    check: 'the tool-call guard sends commands known to print account details through `yokoten redact`. In Claude Code it rewrites the command; other agents are stopped and shown the command to run',
    docs: guide('privacy'),
  },
  'no-ci': {
    rule: 'a repo that keeps CI off says so in yokoten.json "notNow", and knows what that leaves out',
    why: 'without CI, nothing on the server checks pull requests, issue titles or the workflows, and a commit made with the hook off reaches main unchecked',
    check: 'full `doctor` notes it while "notNow" names `ci`, and reminds you to end it when the repo goes public; a note, never a failure',
    docs: guide('a-private-repo-without-ci'),
  },
  'upstream-inbox': {
    rule: 'a gap in yokoten found in another project becomes an issue in the yokoten repo',
    why: 'a lesson that stays in a note on one machine never becomes a check',
    check: 'in the yokoten repo only, the session start and `doctor` count the notes in ~/.config/yokoten/upstream; `yokoten learn --upstream` writes them, with the project and the owner hidden; a note, never a failure',
    docs: guide('lessons-for-yokoten-itself'),
  },
  mailmap: {
    rule: 'git prints your name and emails as a placeholder',
    why: 'an agent reads git log and git show, and an author line names you',
    check: '`doctor` reads the global git setting mailmap.file; `install` points it at ~/.config/yokoten/mailmap unless you set your own',
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
  'uncommitted-changes': {
    rule: 'changes in a worktree are committed and pushed before they are forgotten',
    why: 'a crash, a power cut or a dead disk loses them, and only this machine has them',
    check: `${UNSAVED_CHECK}: \`git status\` in each worktree, and the time of its oldest changed file; a session hears only changes older than an hour`,
    docs: guide('work-only-on-this-machine'),
  },
  'unpushed-commits': {
    rule: 'every branch with commits of its own is pushed',
    why: 'a commit not pushed is still only on this machine, and a dead disk loses it',
    check: `${UNSAVED_CHECK}: one \`git for-each-ref\` gives each branch's upstream and commits ahead; a branch with no upstream counts the commits not on the default branch; one \`git rev-list\` finds a detached HEAD whose commits no branch holds`,
    docs: guide('work-only-on-this-machine'),
  },
  stashes: {
    rule: 'a stash does not hold work for long',
    why: 'a stash is never pushed, so it is only on this machine',
    check: `${UNSAVED_CHECK}: \`git stash list\``,
    docs: guide('work-only-on-this-machine'),
  },
  'finished-worktree': {
    rule: 'a worktree goes once its branch is merged',
    why: 'old worktrees pile up, and then nobody can tell which ones still hold work',
    check: `${UNSAVED_CHECK}: a worktree with no changes whose branch is in the default branch's history, or whose upstream is gone (a squash merge leaves no other sign), or a detached HEAD in its history; a branch or HEAD that has not moved since it was made is new, not merged; full doctor only`,
    docs: guide('work-only-on-this-machine'),
  },
  'missing-worktree': {
    rule: 'git lists only worktrees whose folder is there',
    why: 'a worktree whose folder was deleted still holds its branch, so git refuses to check that branch out anywhere else',
    check: `${UNSAVED_CHECK}: \`git worktree list\` marks it prunable, or its folder is gone; full doctor only`,
    docs: guide('work-only-on-this-machine'),
  },
  'stale-index-lock': {
    rule: 'no index.lock is left behind by a crash',
    why: 'git refuses to change a worktree while its index.lock is there',
    check: `${UNSAVED_CHECK}: each worktree's index.lock, and the running processes (/proc on Linux, \`ps\` on macOS, \`tasklist\` on Windows); when it can't tell, it says so and never says to delete it`,
    docs: guide('work-only-on-this-machine'),
  },
  'repo-on-tmpfs': {
    rule: 'a repo and its worktrees live on a disk, not in memory',
    why: 'a tmpfs lives in memory, so a restart empties it',
    check: `${UNSAVED_CHECK}: /proc/mounts, for each worktree, on Linux, named as for the temp folder; on macOS and Windows it says nothing`,
    docs: guide('work-only-on-this-machine'),
  },
  'repo-in-temp-folder': {
    rule: 'a repo and its worktrees live outside the temp folder',
    why: 'the system may empty its temp folder on restart, as WSL empties /tmp',
    check: `${UNSAVED_CHECK}: each worktree's real path against the temp folders: YOKOTEN_TEMP_DIRS (empty turns it off), else the system's temp folder and /tmp. The repo itself always gets a note; a worktree only when it holds work at risk, in that work's note; the rest get one line in full doctor`,
    docs: guide('work-only-on-this-machine'),
  },
  'not-a-repo': {
    rule: 'yokoten runs inside a git repo',
    why: 'the checks read commits, so yokoten needs git history',
    check: 'every command that reads or writes a project looks for its git repo first, and stops before it writes anything; `doctor --session` and the hooks do not report it, so a session in another folder gets no noise',
    docs: guide('commands'),
  },
  'git-read': {
    rule: 'a check stops when git can\'t answer it',
    why: 'a check that can\'t read git has not looked, so passing would call an unread repo clean',
    check: 'the commit check, `check`, `check --history` and `check --pr` stop with this finding when a git read they depend on fails, runs out of buffer or is stopped',
    docs: guide('three-checks-and-a-lock'),
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

/** Outside a git repo (#205): the one finding every command that needs a repo gives. */
export const notRepoFinding = (folder: string): Finding => finding('not-a-repo', `${folder} is not inside a git repo`, 'run it inside your project, or `git init` first');

const sentence = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** Where a finding is, as `file:line: `, or nothing. */
export const place = (f: Finding): string => (f.file === undefined ? '' : `${f.file}${f.line === undefined ? '' : `:${f.line}`}: `);

/**
 * The text form: `place: what. Why. Fix.` `what` is kept as written, to follow a prefix.
 * A link, when there is one, goes on its own line below: `  docs: <url>`.
 */
export const formatFinding = (f: Finding): string =>
  `${place(f)}${f.what}. ${sentence(f.why)}. ${sentence(f.fix)}.${f.docs === undefined ? '' : `\n  docs: ${f.docs}`}`;
