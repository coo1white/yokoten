import { readFileSync, statSync } from 'node:fs';
import { basename, isAbsolute } from 'node:path';
import type { Config, Env } from '../../config.ts';
import { type Finding, finding, isFailingFinding, noteWork, type RuleId } from '../../message.ts';
import { gitAnswer, localKey, machineAllowed, repoKey, sameNameMarks, skipsOwnName, trimStart } from '../allow.ts';
import { homeOf, loadMarks, ownMarks } from '../home.ts';
import { foldLine, foldMark, hasMark, loadMarkKinds, mapMarkKinds } from '../marks.ts';
import { hideHome, scanText } from '../scan.ts';
import { CLOSE_OPTIONS, FIELD_OPTIONS, FILE_OPTIONS, GLOBAL_VALUES, type GhCommand, heredocBodies, hostApiClusterFinding, INPUT_OPTIONS, MAX_FILE_BYTES, MUTATION, optionValue, type Piece, POSTS, readHostApi, TEXT_OPTIONS, WRITE_METHODS } from './post.ts';

/**
 * A file's texts, `skip` for a file the guard does not read, `missing`, or `unsure`: the
 * command may change the file. `saw` is unsure too, and names what in the command (#498).
 */
type FileRead = { texts: string[] } | { saw: Risk } | 'skip' | 'missing' | 'unsure';

/** What in a command may change a body file (#498): its name, and a fix when "leave out" is not the one. */
export type Risk = { what: string; fix?: string };

/**
 * What the rest of the command does to the files gh reads (#439). `heredoc`: the command is
 * exactly `cat > path <<'EOF' && gh …`, and this is the path, as written, and the heredoc's
 * text. `mayWrite`: another command in it may write a file, so a file on disk is not read
 * as the one gh will post. `saw` names what may write it, for the message (#498). It runs
 * only on a refusal, so the marks file is read only then; `isMarked` keeps a private mark
 * out of the name.
 */
export interface CommandFiles {
  heredoc?: { path: string; text: string };
  mayWrite: boolean;
  saw?: (isMarked: (word: string) => boolean) => Risk | undefined;
  /** A cd in the command: a path with `..` goes up from the real folder, behind any symlink. */
  movesFolder?: boolean;
}

/** What a gh command posts: its pieces, a file the guard can't find, or a short-option cluster. Null when it posts nothing. */
type Missing = { missing: string; unsure: boolean; saw?: Risk };

function postedPieces(gh: GhCommand, readFile: (path: string) => FileRead, command: string): { pieces: Piece[] } | Missing | { cluster: true } | null {
  const { args } = gh;
  // The group and its subcommand: the first two words that are not options.
  const plain: string[] = [];
  for (let index = 0; index < args.length && plain.length < 2; index++) {
    if (GLOBAL_VALUES.has(args[index])) index++;
    else if (!args[index].startsWith('-')) plain.push(args[index]);
  }
  const [group, sub] = plain;
  const isApi = group === 'api';
  if (!isApi && !POSTS[group]?.includes(sub)) return null;
  const pieces: Piece[] = [];
  let missing: Missing | null = null;
  // A file named twice is read once: gh posts one of them, and a long body is scanned once.
  const seen = new Set<string>();
  // The queries the words may hold: a mutation in any of them counts (#659).
  const queries: string[] = [];
  const addFile = (option: string, path: string | undefined, key?: string) => {
    // No file after the option: the shell took it as a redirect, as in `-F <(echo x)` (#439).
    if (path === undefined) {
      missing ??= { missing: option, unsure: true };
      return;
    }
    if (path === '-') {
      // stdin: a here-string, a `< file`, or the heredocs in the command.
      if (gh.hereString !== undefined) pieces.push({ source: 'the here-string text', isFile: false, text: gh.hereString });
      else if (gh.stdinFile !== undefined) addFile('<', gh.stdinFile, key);
      else for (const body of heredocBodies(command)) pieces.push({ source: 'the heredoc text', isFile: false, text: body });
      if (key === 'query') queries.push(...[gh.hereString, ...heredocBodies(command)].filter((text) => text !== undefined));
      return;
    }
    if (seen.has(path)) return;
    seen.add(path);
    const read = readFile(path);
    if (read === 'missing' || read === 'unsure') missing ??= { missing: option, unsure: read === 'unsure' };
    else if (read === 'skip') return;
    else if ('saw' in read) missing ??= { missing: option, unsure: true, saw: read.saw };
    else {
      for (const text of read.texts) pieces.push({ source: path, isFile: true, text });
      if (key === 'query') queries.push(...read.texts);
    }
  };
  // Each word is read as a possible option, the value after an option too (#659). gh takes the
  // next word as the value of any option that wants one, `-H -f`, so skipping values would
  // trust the guard's list of such options; a word read twice only means more is scanned.
  for (let index = 0; index < args.length; index++) {
    if (isApi) {
      // The method and the path come from the host's walk below; here each field is read.
      const input = optionValue(args, index, INPUT_OPTIONS);
      if (input) {
        addFile(input.name, input.value);
        continue;
      }
      const field = optionValue(args, index, FIELD_OPTIONS);
      if (field) {
        const value = field.value ?? '';
        const equals = value.indexOf('=');
        const key = equals === -1 ? value : value.slice(0, equals);
        const content = equals === -1 ? '' : value.slice(equals + 1);
        // `-F key=@file` reads the file; `-f` always takes the text as it is.
        if ((field.name === '-F' || field.name === '--field') && content.startsWith('@')) addFile(field.name, content.slice(1), key);
        else if (content) {
          pieces.push({ source: `the ${key} field`, isFile: false, text: content });
          if (key === 'query') queries.push(content);
        }
      }
    } else {
      const file = optionValue(args, index, FILE_OPTIONS);
      if (file) {
        addFile(file.name, file.value);
        continue;
      }
      const text = optionValue(args, index, sub === 'close' ? CLOSE_OPTIONS : TEXT_OPTIONS);
      if (text?.value) pieces.push({ source: `the ${text.name} text`, isFile: false, text: text.value });
    }
  }
  if (isApi) {
    const apiAt = args.indexOf('api');
    const call = readHostApi(apiAt === -1 ? args : args.slice(apiAt + 1));
    // The same walk as the path. A cluster is refused here too, so a hidden field is not a quiet read.
    if (call?.cluster) return { cluster: true };
    if (call && !apiWrites(call.rawPath, call.method, call.hasFields, queries)) return null;
  }
  return missing ?? { pieces };
}

/**
 * Whether an API call writes: only then is what it sends posted. `method` is the host's
 * reading, upper case, or empty when the call names none. Fields with no method are a POST,
 * to any path: a label or a git blob is posted too (#659). Only a search reads with one.
 */
function apiWrites(path: string, method: string, hasFields: boolean, queries: string[]): boolean {
  if (path.replace(/^\//, '') === 'graphql') return queries.some((query) => MUTATION.test(query));
  if (method) return WRITE_METHODS.has(method);
  return hasFields && !path.replace(/^\//, '').startsWith('search/');
}

// The commit check's reasons end on what git does; a post is public as soon as it is sent.
const postWhy = (why: string) => why.replace(/, and git keeps it after the file is gone$/, '').replace('read the repo', 'read it').concat(', and a post is public the moment it is sent');

// The commit check's fix, and for an IP address the way to let a public one through.
// The email fix names privacy.allow already (EMAIL_FIX).
const ALLOW_FIX = 'If it is public on purpose, add it to "privacy.allow" in yokoten.json';
const postFix = (f: Finding) =>
  f.id === 'ip' ? `${f.fix}. ${ALLOW_FIX}` : f.id === 'secret' ? 'take it out of the text, and rotate it if it was ever sent' : f.fix;

/** A file's path as a finding may show it: home as `~`, and only its name, or no name, when the path holds a mark. */
function shownPath(path: string, env: Env, marks: string[]): string {
  const holdsMark = (text: string) => {
    const folded = foldLine(text);
    return marks.some((mark) => hasMark(text, mark, folded));
  };
  const shown = hideHome(path, env);
  if (!holdsMark(shown)) return shown;
  const name = basename(shown);
  return holdsMark(name) ? 'the body file' : name;
}

// The characters bash reads as plain text outside quotes: no expansion, glob, brace, operator or comment.
const PLAIN_WORD = /^[A-Za-z0-9_ \t./:,=+@%-]$/;

// The yokoten of `yokoten bot --` the guard trusts (#506): a plain `yokoten`, a path such as
// `bin/yokoten.ts` or `/opt/x/bin/yokoten.ts`, or one under `~/`, in plain path characters.
// `~user`, `~+` and `~-` are not your home folder, so the guard can't tell which yokoten runs.
// No `=` or `,`: `GH_REPO=x/yokoten` or `LD_PRELOAD=x/yokoten` sets a variable, it is no program.
// An absolute path or one with `..` is trusted on purpose: no looser than before #506, and the
// guard can't see what a program file holds, whatever its path.
const BOT_PROGRAM = String.raw`(?:~?\/)?(?:[\w.+@%:-]+\/)*yokoten(?:\.ts|\.mjs)?`;
const BOT_PROGRAM_WORD = new RegExp(`^${BOT_PROGRAM}$`);

/** Whether a word, quotes removed, is a yokoten the guard trusts as the bot's program (#506). */
export function isBotProgram(word: string): boolean {
  return BOT_PROGRAM_WORD.test(word);
}

// The start of a lone post: the allowed variables, then `gh` or the bot's `yokoten bot -- gh`.
const LONE_POST_START = new RegExp(String.raw`^(?:(?:(?:NODE_USE_ENV_PROXY|GH_REPO|GH_HOST)=[\w./:@-]*|TZ=UTC)[ \t]+)*(?:(?:node[ \t]+)?${BOT_PROGRAM}[ \t]+bot[ \t]+--[ \t]+)?gh[ \t]`);

/**
 * Whether the command line is one gh post and nothing else (#447): `gh …`, or the bot's
 * `yokoten bot -- gh …` with a yokoten `isBotProgram` trusts (#506), optionally after one
 * plain `cd <folder> &&`. Before it, only
 * NODE_USE_ENV_PROXY, GH_REPO or GH_HOST may be set, to a plain value (#498), or TZ to UTC
 * (#488); GH_REPO and GH_HOST name another target, so namesTarget still keeps the allow. Outside quotes only
 * letters, digits, spaces and `_ . / : , = + @ % -` are trusted, plus one here-string or
 * one heredoc whose end word is a name in single quotes (`<<'EOF'` or `<<-'EOF'`). Bash
 * expands nothing in that body, and the body ends at the first line that is the name alone.
 * After that line only blank lines (spaces and tabs) may follow. Inside double quotes `$`,
 * backquote and backslash are refused; single quotes hold anything. Anything else could
 * change where gh posts before it runs, so no allow applies (record 0014). Listing shell
 * features one by one missed one each round, so the check names what it trusts.
 * `cd` is true when the line starts with that `cd`; its target may start with `~`.
 */
export function lonePost(command: string): { cd: boolean; target?: string } | null {
  noteWork(command.length);
  let text = trimStart(command, ' \t');
  const cd = text.match(/^cd[ \t]+('[^'\n]*'|"[^"$`\\\n]*"|~?[\w./+@%:,=-]+|~)[ \t]*&&[ \t]*/);
  if (cd) text = text.slice(cd[0].length);
  const start = text.match(LONE_POST_START);
  if (!start) return null;
  let quote: string | null = null;
  let heredoc: { word: string; tabs: boolean } | null = null;
  let index = start[0].length;
  for (; index < text.length; index++) {
    noteWork(1);
    const char = text[index];
    if (quote === "'") {
      if (char === "'") quote = null;
      continue;
    }
    if (quote === '"') {
      if (char === '"') quote = null;
      else if (char === '$' || char === '`' || char === '\\') return null;
      continue;
    }
    if (char === "'" || char === '"') quote = char;
    else if (char === '\n') break;
    else if (PLAIN_WORD.test(char)) continue;
    else if (char === '<' && text[index + 1] === '<' && text[index + 2] !== '<') {
      if (heredoc) return null; // one heredoc at most
      // Only <<'NAME' or <<-'NAME', then a space, tab or newline, so bash reads the same end word.
      const quotedName = /<<(-?)'([A-Za-z_][A-Za-z0-9_]*)'(?=[ \t\n]|$)/y;
      quotedName.lastIndex = index;
      const found = quotedName.exec(text);
      if (!found) return null;
      heredoc = { word: found[2], tabs: found[1] === '-' };
      index += found[0].length - 1;
    } else if (char === '<' && text[index + 1] === '<') index += 2; // a here-string: its word is read as any other
    else return null;
  }
  if (quote) return null;
  const lone = cd ? { cd: true, target: cd[1] } : { cd: false };
  if (index >= text.length) return heredoc ? null : lone;
  // A newline: only a heredoc's body may follow, then nothing.
  if (!heredoc) return null;
  const { word, tabs } = heredoc;
  const lines = text.slice(index + 1).split('\n');
  const end = lines.findIndex((line) => (tabs ? trimStart(line, '\t') : line) === word);
  if (end === -1) return null;
  return lines.slice(end + 1).every((line) => /^[ \t]*$/.test(line)) ? lone : null;
}

// The programs a pipe at the end of a gh line may feed (#498): each only reads its input.
// sort, uniq and sed count only with the options readsOnly in guards.ts checks.
export const PIPE_READERS = new Set(['tail', 'head', 'grep', 'cut', 'wc', 'sort', 'uniq', 'tr', 'sed']);
const PIPE_PROGRAM = /[ \t]*([a-z]+)(?=[ \t]|$)/y;

/**
 * The command without a pipe at its end into programs that only read (#498):
 * `gh … 2>&1 | tail -2` gives `gh …`. The commands of a pipe run beside gh and leave this
 * shell's folder alone, so the file gh reads and where it posts stay the same. One shape
 * only: from the first `|` outside quotes to the end of the one line, each command starts
 * with a program in PIPE_READERS and holds only the characters lonePost trusts, plus
 * `$NAME` inside "...". A `2>&1` right before the pipe, or at the end of a line with no
 * pipe, goes too. Any other command comes back as it was, for the rest of the guard to read.
 */
export function withoutReadPipe(command: string): string {
  let quote = '';
  let at = -1;
  for (let index = 0; index < command.length && at === -1; index++) {
    noteWork(1);
    const char = command[index];
    if (char === '\n' || (char === '\\' && quote !== "'")) return command;
    if (quote) {
      if (char === quote) quote = '';
    } else if (char === "'" || char === '"') quote = char;
    else if (char === '|') at = index;
  }
  if (at !== -1 && !isReadPipe(command, at)) return command;
  return withoutStderrRedirect(at === -1 ? command : command.slice(0, at));
}

// The text without a `2>&1` at its end: stderr goes where stdout goes, and no file is
// opened. Only spaces and tabs count as blanks: bash reads any other character as a word.
function withoutStderrRedirect(text: string): string {
  let end = text.length;
  while (end > 0 && (text[end - 1] === ' ' || text[end - 1] === '\t')) end--;
  if (end < 5 || !text.startsWith('2>&1', end - 4)) return text;
  const before = text[end - 5];
  return before === ' ' || before === '\t' ? text.slice(0, end - 4) : text;
}

// Whether the text from `at`, a `|`, to the end is a pipe into PIPE_READERS in plain words.
// A sed may hold no `$` at all, in any quotes: bash fills in a value before sed reads its
// script, and a value can hold the delimiter and then `w` (see sedReadsOnly in guards.ts).
function isReadPipe(text: string, at: number): boolean {
  let quote = '';
  let program = '';
  for (let index = at; index < text.length; index++) {
    noteWork(1);
    const char = text[index];
    if (char === '$' && program === 'sed') return false;
    if (quote === "'") {
      if (char === "'") quote = '';
      else if (char === '\n' || char === '\r') return false;
    } else if (quote === '"') {
      if (char === '"') quote = '';
      // A `$NAME` inside "..." is one word of text: it runs nothing. `$(`, `${` and the rest may.
      else if (char === '$' && !/[A-Za-z_]/.test(text[index + 1] ?? '')) return false;
      else if ('`\\!\n\r'.includes(char)) return false;
    } else if (char === '|') {
      PIPE_PROGRAM.lastIndex = index + 1;
      const found = PIPE_PROGRAM.exec(text);
      if (!found || !PIPE_READERS.has(found[1])) return false;
      program = found[1];
      index += found[0].length;
    } else if (char === "'" || char === '"') quote = char;
    else if (!PLAIN_WORD.test(char)) return false;
  }
  return quote === '';
}

/**
 * Whether a gh command may post somewhere other than the repo it runs in (#447): it names a
 * repo (`-R`, `--repo`, an issue or pull request URL), GH_REPO or GH_HOST is set or appears anywhere in the
 * command, or it runs the api or gist group, whose target the guard does not read. Then no
 * allow for this repo applies.
 */
export function namesTarget(gh: GhCommand, command: string, env: Env): boolean {
  if (env.GH_REPO || env.GH_HOST || /\bGH_(?:REPO|HOST)\b/.test(command)) return true;
  const { args } = gh;
  let group: string | undefined;
  for (let index = 0; index < args.length && group === undefined; index++) {
    if (GLOBAL_VALUES.has(args[index])) index++;
    else if (!args[index].startsWith('-')) group = args[index];
  }
  if (group === 'api' || group === 'gist') return true;
  return args.some((arg) => arg === '-R' || arg === '--repo' || arg.startsWith('--repo=') || (arg.startsWith('-R') && arg.length > 2) || /^https?:\/\//i.test(arg));
}

/** The top folder of the repo at `dir`, links followed, or null. */
function repoTop(dir: string, env: Env): string | null {
  const top = gitAnswer(dir, ['rev-parse', '--show-toplevel'], env);
  return 'out' in top && top.out.trim() ? (localKey(top.out.trim()) ?? null) : null;
}

/**
 * Whether a gh post goes to the repo it runs in, so an allow for that repo may apply (#447):
 * the line is the post alone (`lonePost`), it names no other target, and a `cd` before it
 * stays in the repo the line started in (`from`).
 */
function isPostHere(gh: GhCommand, { env, command, cwd, from }: { env: Env; command: string; cwd: string | null; from?: string | null }): boolean {
  const lone = lonePost(withoutReadPipe(command));
  if (!lone || namesTarget(gh, command, env)) return false;
  if (!lone.cd) return true;
  if (!cwd || !from) return false;
  // bash searches CDPATH for a bare relative folder, and CDPATH may be set in the shell
  // without being exported, so only /, ./, ../ or an unquoted ~ or ~/ say where cd goes. A
  // quoted ~ is not your home: bash keeps it as a folder named ~, and searches CDPATH for it.
  if (lone.target !== undefined && !/^(?:~(?:\/|$)|['"]?(?:\/|\.\/|\.\.\/))/.test(lone.target)) return false;
  const top = repoTop(cwd, env);
  return top !== null && top === repoTop(from, env);
}

/**
 * The first privacy problem in the text a gh command is about to post, or null. `command`
 * is the whole command text, for the heredocs that feed stdin. `cwd` is where the command
 * runs, for a relative file; null when the guard cannot tell.
 */
export function checkPost(
  gh: GhCommand,
  { env, privacy, cwd, command, from, files }: { env: Env; privacy?: Partial<Pick<Config['privacy'], 'allow' | 'skipOwnName'>>; cwd: string | null; command: string; from?: string | null; files?: CommandFiles },
): Finding | null {
  // The path goes to the kernel as bash hands it to gh, never normalized: join and resolve
  // drop `..` as text, but the kernel goes up from the real folder when the working folder
  // or home is a symlink (#470).
  // A word in a refusal is tested against the marks as a path is in shownPath (#498). The
  // marks file is read only when a refusal names a word.
  let namedMarks: string[] | undefined;
  // Folded as the scan folds it (#507).
  const isMarked = (word: string) => {
    const { lower } = foldLine(word);
    return (namedMarks ??= loadMarks(env)).some((mark) => {
      const value = foldMark(mark);
      return value !== '' && lower.includes(value);
    });
  };
  const readFile = (path: string): FileRead => {
    let full = path;
    if (path.startsWith('~')) {
      // Bash takes `~` from HOME, or from the system when HOME is unset; only a full HOME
      // tells the guard which, and `~name` is another user's home (#470).
      const home = homeOf(env);
      if (!home || (path !== '~' && !path.startsWith('~/'))) return 'missing';
      full = `${home}/${path.slice(2)}`;
    }
    // A `..` past a `cd` escapes whatever folder the command lands in, so it is named
    // even from an unknown one: the file stays unreadable either way (#559).
    if (files?.movesFolder && full.split(/[\\/]/).includes('..')) return { saw: { what: 'a `cd` before a path with `..`' } };
    if (!isAbsolute(full) && cwd === null) return 'unsure';
    const at = isAbsolute(full) || !cwd ? full : `${cwd}/${full}`;
    let stat: ReturnType<typeof statSync> | null = null;
    try {
      stat = statSync(at);
    } catch {
      // missing, or not readable: as missing
    }
    const isReadable = stat !== null && stat.isFile() && stat.size <= MAX_FILE_BYTES;
    // `cat > path <<'EOF' && gh … path`: the heredoc's text, and what is there now as well,
    // in case cat can't replace it (#439).
    if (files?.heredoc && path === files.heredoc.path) {
      if (stat === null) return { texts: [files.heredoc.text] };
      return isReadable ? { texts: [files.heredoc.text, readFileSync(at, 'utf8')] } : 'unsure';
    }
    if (stat === null) return 'missing';
    if (files?.mayWrite) {
      const risk = files.saw?.(isMarked);
      return risk ? { saw: risk } : 'unsure';
    }
    return isReadable ? { texts: [readFileSync(at, 'utf8')] } : 'skip';
  };
  const posted = postedPieces(gh, readFile, command);
  if (!posted) return null;
  if ('cluster' in posted) return hostApiClusterFinding() ?? finding('run-remove', 'this host call joins short options, so its method is not clear', 'write each short option as its own word, so the guard can read the method');
  if ('missing' in posted) {
    // The guard runs before the command (#439): a file the command writes, or a path only
    // the running command knows, can't be read yet.
    // What the guard saw is named, so the agent knows what to change (#498).
    const { saw } = posted;
    const what = !posted.unsure
      ? `yokoten can't find the file after ${posted.missing} to check it: the file doesn't exist yet when the guard runs`
      : `yokoten can't tell what the file after ${posted.missing} will hold: the guard runs before the command, and ${saw ? `${saw.what} in this command` : 'this command'} may change the file or where it is`;
    const fix = `${saw ? `${saw.fix ?? `leave out ${saw.what}`}, or ` : ''}write the file in one command, then post it in the next, and give its full path`;
    return finding('unreadable-command', what, fix, {
      why: 'the privacy check reads a body before it is posted, and an unread one could hold anything',
    });
  }
  if (!posted.pieces.length) return null;
  const allow = privacy?.allow ?? [];
  // An allowed mark is left out of the path shown too (#424). The project's and the machine's
  // allow (#447) are for the repo the command runs in: a post gets them only when it is the
  // line's one command (after at most a cd within the same repo) and names no other target.
  const withKinds = loadMarkKinds(env);
  const kinds = mapMarkKinds(withKinds);
  const all = withKinds.map((mark) => mark.value);
  const isHere = all.length > 0 && isPostHere(gh, { env, command, cwd, from });
  const key = isHere && cwd !== null ? repoKey(cwd, env) : null;
  const named = isHere && skipsOwnName(env, privacy) ? sameNameMarks(all, key) : [];
  const own = isHere ? [...ownMarks(all, [...allow, ...machineAllowed(env, cwd, key ?? undefined).allow]), ...named] : [];
  const marks = all.filter((mark) => !own.includes(mark));
  for (const piece of posted.pieces) {
    const hit = scanText(piece.text, { file: piece.source, marks, allow, ownAllow: [], kinds, env, inlineIgnores: false }).find(isFailingFinding);
    if (!hit) continue;
    const more = { why: postWhy(hit.why) };
    if (piece.isFile) return finding(hit.id as RuleId, hit.what, postFix(hit), { ...more, file: shownPath(piece.source, env, marks), line: hit.line });
    const line = piece.text.includes('\n') ? `, line ${hit.line},` : '';
    const what = hit.id === 'private-mark' ? `${piece.source}${line} ${hit.what}` : `${piece.source}${line} holds ${hit.what}`;
    return finding(hit.id as RuleId, what, postFix(hit), more);
  }
  return null;
}
