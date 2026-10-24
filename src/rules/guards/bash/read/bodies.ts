import { KEYWORDS, HEADS, redirectLength, programName, findPrograms } from './words.ts';
import { spend, runnerAt, xargsCommand, xargsInput } from './run.ts';
import { commandWords, read, type Heredoc, type Group } from './read.ts';

export function groupBodies(group: Group, into: string[]): void {
  const stack = [group];
  for (let next = stack.pop(); next !== undefined; next = stack.pop()) {
    spend(1 + next.bodies.length);
    for (const body of next.bodies) into.push(body);
    for (const inner of next.inner) stack.push(inner);
    next.bodies = [];
    next.inner = [];
  }
}

// The end of a $'...' string: the next ' without a \ before it.
export function closeAnsi(text: string, i: number): number {
  for (; i < text.length; i++) {
    spend(1);
    if (text[i] === '\\') i++;
    else if (text[i] === "'") return i;
  }
  return -1;
}

// What readDouble returns when a substitution inside never closed: that read went on to the
// end of the text, so the caller must not read the rest again.
export const RAN_OUT = Symbol('ran out');

/** The index after a backslash and a newline. The shell removes that pair before it parses. */
export function skipContinuation(text: string, index: number): number {
  const start = index;
  while (text[index] === '\\' && text[index + 1] === '\n') index += 2;
  spend(index - start);
  return index;
}


// Reads "..." from after the opening quote. $(...) and `...` inside it run, so they are
// read as commands. Returns the word's text and the index after the closing quote, or null
// when it never closes (RAN_OUT when a substitution in it never closes). With `toEnd` there is no closing quote: it reads a heredoc body.
export function readDouble(text: string, index: number, depth: number, out: string[][], toEnd = false, substitutions: string[] = []): { value: string; end: number } | typeof RAN_OUT | null {
  let value = '';
  while (index < text.length) {
    spend(1);
    const character = text[index];
    if (character === '"' && !toEnd) return { value, end: index + 1 };
    if (character === '\\') {
      // In "...", \ escapes only $ ` " \ and a line end. Before anything else it stays.
      const n = text[index + 1] ?? '';
      if (n && '$`"\\'.includes(n)) value += n;
      else if (n !== '\n') value += character + n;
      index += 2;
    } else if (character === '$' || character === '`') {
      // A joined line hides the opener: `"$\⏎(sh)"` is `"$(sh)"` before parsing.
      const opened = character === '`' ? index : skipContinuation(text, index + 1);
      if (character === '`' || text[opened] === '(') {
        const from = character === '`' ? index + 1 : opened + 1;
        const end = read(text, from, character === '`' ? '`' : ')', depth + 1, out);
        if (end === -1) return RAN_OUT;
        substitutions.push(text.slice(from, end - 1));
        value += character === '`' ? text.slice(index, end) : '$(' + text.slice(from, end);
        index = end;
      } else {
        value += character;
        index++;
      }
    } else {
      value += character;
      index++;
    }
  }
  return toEnd ? { value, end: index } : null;
}

// Reads the word after << or <<-. A quoted word means the body is not expanded.
export function heredoc(text: string, index: number, cmd: number, groups: Group[]): { doc: Heredoc; end: number } | null {
  const strip = text[index] === '-';
  if (strip) index++;
  while (text[index] === ' ' || text[index] === '\t') index++;
  const start = index;
  let delim = '';
  let quoted = false;
  // A \r is part of the word, as in bash: `<<EOF\r` ends at a line `EOF\r`.
  while (index < text.length && !/[ \t\n;&|()<>]/.test(text[index])) {
    const character = text[index];
    // `<<$'EOF'` and `<<$"EOF"`: bash ends the body at EOF, without the $.
    if (character === '$' && (text[index + 1] === "'" || text[index + 1] === '"')) {
      index++;
      continue;
    }
    if (character === '"') {
      // In "...", a \ before " \ $ or ` is removed: `<<"E\"F"` ends at a line `E"F` (#439).
      let at = index + 1;
      while (at < text.length && text[at] !== '"') {
        if (text[at] === '\\' && '"\\$`'.includes(text[at + 1] ?? '')) at++;
        delim += text[at];
        at++;
      }
      spend(at - index);
      if (at >= text.length) return null;
      quoted = true;
      index = at + 1;
    } else if (character === "'") {
      const end = text.indexOf(character, index + 1);
      spend((end === -1 ? text.length : end) - index);
      if (end === -1) return null;
      delim += text.slice(index + 1, end);
      quoted = true;
      index = end + 1;
    } else if (character === '\\') {
      delim += text[index + 1] ?? '';
      quoted = true;
      index += 2;
    } else {
      delim += character;
      index++;
    }
  }
  // A \ before a line end in the word, quoted or not: bash may join the two lines
  // (`<<"E\⏎F"` ends at a line EF). The guard does not follow that, so it refuses (#439).
  if (text.slice(start, index).includes('\\\n')) throw new UnsureHeredoc('a line end in a heredoc word');
  return delim ? { doc: { delim, strip, quoted, cmd, groups }, end: index } : null;
}

class UnsureHeredoc extends Error {}

// Reads the heredoc bodies that start at `index`, in order, and returns the index after the
// last one. A body is data, unless a shell or runner reads it (#196): the program of the
// command that holds the <<, or of a command it pipes into (`cat <<EOF | bash`). The
// program is found after assignments, keywords and launchers (see readsCommands), so
// `then bash <<EOF` and `env X=1 bash -s <<EOF` count, and `cat > sh <<EOF` or
// `node - <<EOF` do not. So does a command with no program (see feedsShell). A pipe left open at the line end (`cat <<EOF |`) counts too: its
// reader is on a later line. A group that closed on the line pipes its commands on
// (`{ cat <<EOF; } | bash`). Then the body is read as commands. A body in a group still
// open waits in the group: where the group sends its output decides (see `settle` in read).
// A heredoc right after a group closes is the group's input (`{ read a; } <<EOF`): it is
// commands when a command in the group reads commands, or the group pipes into one.
// An unquoted body still runs $(...) and `...`, so those are read too. A body with no end
// line runs to the end of the text, as in bash.
export function bodies(text: string, index: number, docs: Heredoc[], { line, pipes, groups }: { line: string[][]; pipes: boolean[]; groups: Group[] }, depth: number, out: string[][]): number {
  // Once per line, from the last command back: where the pipeline from each command ends,
  // and whether a command from it to there reads commands. Each heredoc then looks it up.
  spend(line.length);
  const ends: number[] = [];
  const reads: boolean[] = [];
  for (let i = line.length - 1; i >= 0; i--) {
    const pipesOn = pipes[i] && i + 1 < line.length;
    ends[i] = pipesOn ? ends[i + 1] : i;
    reads[i] = readsCommands(line[i]) || (pipesOn && reads[i + 1]);
  }
  const handedTo = new Map<number, string | null>(); // what xargs runs, for each command that holds a heredoc
  for (const doc of docs) {
    const lines: string[] = [];
    while (index < text.length) {
      let nl = text.indexOf('\n', index);
      if (nl === -1) nl = text.length;
      spend(nl - index + 1);
      const ln = text.slice(index, nl);
      index = nl + 1;
      // As in bash, a line ends the body only when it is the word exactly: `EOF\r` does not.
      if ((doc.strip ? ln.replace(/^\t+/, '') : ln) === doc.delim) break;
      lines.push(ln);
    }
    const body = lines.join('\n');
    // `xargs git <<EOF`: the body's words are the program's words.
    if (!handedTo.has(doc.cmd)) handedTo.set(doc.cmd, xargsCommand(line[doc.cmd] ?? []));
    const handed = handedTo.get(doc.cmd) ?? null;
    if (handed !== null) out.push(...commandWords(`${handed} ${xargsInput(line[doc.cmd] ?? [], body)}`, depth + 1));
    const last = ends[doc.cmd] ?? doc.cmd;
    const isOpenPipe = last > doc.cmd && line[last].length === 0;
    const isRead = doc.group ? doc.group.reads : feedsShell(line[doc.cmd] ?? []);
    if (isOpenPipe || isRead || reads[doc.cmd] === true) {
      out.push(...commandWords(body, depth + 1));
      continue;
    }
    if (!doc.quoted) readDouble(body, 0, depth, out, true);
    doc.groups.findLast((group) => groups.includes(group))?.bodies.push(body);
  }
  return Math.min(index, text.length);
}

// A heredoc on a command with no program feeds the shell itself: `exec <<EOF`, `exec
// 3<<EOF; bash <&3`, or a bare redirect. A keyword (`done <<EOF`) hands it to its loop.
function feedsShell(words: string[]): boolean {
  return words.every((word) => !KEYWORDS.has(word) && !HEADS.has(word)) && findPrograms(words).length === 0;
}

// Programs that read their input as data, never as commands.
const DATA_READERS = new Set([
  'cat', 'tee', 'node', 'deno', 'bun', 'gh', 'git', 'yokoten', 'grep', 'egrep', 'fgrep', 'rg', 'sed', 'awk', 'head', 'tail', 'wc', 'sort', 'uniq',
  'jq', 'yq', 'tr', 'cut', 'less', 'more', 'diff', 'patch', 'base64', 'xxd', 'od', 'column', 'fold', 'fmt', 'nl', 'paste', 'rev', 'iconv',
  'gzip', 'xz', 'zstd', 'bzip2', 'tar', 'curl', 'wget', 'mail', 'mailx', 'sendmail', 'pbcopy', 'xclip', 'wl-copy', 'clip', 'sponge',
  'read', 'mapfile', 'readarray', 'true', ':',
]);

// Whether a command reads its input as commands. The program is found after assignments,
// shell keywords and launchers (`then bash`, `stdbuf -oL bash`). When it is one of
// DATA_READERS, only a shell or runner up to it counts, so `cat > sh <<EOF` and
// `node x.ts --shell bash <<EOF` are data, and `sudo -s` still counts. When it is not, the
// guard does not know what the program does with its input, so a shell or runner anywhere
// in the command counts: `mystery-launcher bash <<EOF` is refused rather than guessed.
// The answer is kept per command: a line of heredocs and pipes asks again for the same one.
// An empty list is not kept: the reader may still fill it.
const readsCache = new WeakMap<string[], boolean>();

export function readsCommands(words: string[]): boolean {
  const known = readsCache.get(words);
  if (known !== undefined) return known;
  const program = findPrograms(words)[0];
  let reads: boolean;
  // A program from a variable (`$line`) may be anything, so its input may run.
  if (program?.startsWith('$')) reads = true;
  else if (program === undefined || !DATA_READERS.has(programName(program))) reads = runnerAt(words) !== -1;
  else {
    const at = words.indexOf(program);
    reads = runnerAt(withoutRedirects(at === -1 ? words : words.slice(0, at + 1))) !== -1;
  }
  if (words.length > 0) readsCache.set(words, reads);
  return reads;
}

// The words with each redirect and its file taken out: `> sh cat` names no shell.
export function withoutRedirects(words: string[]): string[] {
  const kept: string[] = [];
  for (let index = 0; index < words.length; ) {
    const length = redirectLength(words, index);
    if (length === 0) kept.push(words[index]);
    index += length || 1;
  }
  return kept;
}

// The old cut: quotes become spaces, then cut at ; | & ( ) and line ends. It finds more
// than is there, so it is only the fallback when nesting is too deep to follow.
export function rough(text: string): string[][] {
  return text
    .replace(/['"`]/g, ' ')
    .split(/[;|&()\r\n]+/)
    .map((s) => s.trim().split(/\s+/).filter(Boolean))
    .filter((words) => words.length > 0);
}

// gh's token can do all that the guard stops in gh: with it, curl or a script calls the host
