import { unquotedRedirects, readWords, KEYWORDS, COMPOUNDS, REDIRECT_OPERATOR, isOperatorStart, REDIRECT } from './words.ts';
import { spend, withBudget, runnerAt, passesOn, isSource, xargsCommand, xargsInput, xargsUsesNull, printedText, runString } from './run.ts';
import { groupBodies, closeAnsi, RAN_OUT, readDouble, heredoc, bodies, readsCommands, withoutRedirects, rough } from './bodies.ts';

// ---- Reading bash ----
//
// A small reader for everyday bash, not a full parser. It turns command text into a list
// of commands, each a list of words.
//
// - Quotes: '...', "..." (with \ escapes), $'...' and $"..." are part of one word. A
//   separator inside them does not cut the command.
// - Separators: ; & && || | |& ( ) { } and line ends. A \ before a line end joins lines.
//   A group `{ ...; }` or subshell `( ... )` stays open until its } or ).
// - A case pattern (`a|b)` after `case x in` or `;;`) is dropped: it names values.
// - A word that starts with # begins a comment, to the line end.
// - $(...), `...`, <(...) and >(...) run, so their text is read as commands, even in "...".
// - A heredoc body is data, unless a shell reads it (see `bodies`).
// - A shell, eval or ssh runs a string, so the words after it are read again as commands
//   (see `runString`). So does `source /dev/stdin` or `. /dev/fd/N` with its input.
// - Each construct is read once: an unclosed $(, <(, ((, ` or " has read the rest of the
//   text as commands, and the rest is not read again. All reads of one command share one
//   work budget (see withBudget); a command over it is refused.
//
// When the text is unclear, the guard blocks rather than guesses. An unclosed quote is
// dropped and the rest is read as plain words, so `echo 'x; npm publish` still blocks.
// Functions and aliases are not followed.

const MAX_DEPTH = 8;

export function commandWords(text: string, depth = 0): string[][] {
  const out: string[][] = [];
  withBudget(text.length, () => read(text, 0, '', depth, out));
  return out;
}

export interface Heredoc {
  delim: string;
  strip: boolean;
  quoted: boolean;
  /** The index, on its line, of the command that holds the <<. */
  cmd: number;
  /** The groups open around it, outermost first. */
  groups: Group[];
  /** The group it follows, `{ read a; } <<EOF`: the body is the group's input. */
  group?: Group;
}

// A group `{ ...; }`, a subshell `( ... )`, or a compound command (`if ... fi`, a loop to
// its `done`, `case ... esac`). What its commands print goes where the group sends it, so a
// heredoc body or an echo inside may reach a shell after the group: `{ cat <<EOF; } | bash`,
// `if x; then echo y; fi | bash`. A compound command's kind is the word that closes it.
export interface Group {
  kind: '(' | '{' | 'fi' | 'done' | 'esac';
  /** The index, on the current line, of its first command, and of the one after it once closed. */
  from: number;
  to: number;
  /** What its commands print (heredoc bodies, the words an echo prints), waiting for where the group's output goes. */
  bodies: string[];
  /** The groups closed inside it that sent their output on to it: their bodies are its own. */
  inner: Group[];
  /** Whether a command in it reads its input as commands. */
  reads: boolean;
}

// `%(refname)`, `%(refname:short)`: a git format atom, which git reads as the value of
// `--format`. Only this shape is one word. A space, a `;` or a missing `)` means the `(` is a
// subshell after all, and the words after it must be read as commands (#873).
const GIT_FORMAT_ATOM = /^\*?[A-Za-z][A-Za-z0-9_.:*,=/@+-]*$/;
function isGitFormatAtom(text: string, open: number): boolean {
  const close = text.indexOf(')', open + 1);
  return close !== -1 && GIT_FORMAT_ATOM.test(text.slice(open + 1, close));
}


// Reads commands from `start` until `closer` (`)` or a backtick) or the end, and adds them
// to `out`. Returns the index after the closer, or -1 if a closer was wanted and not found.
export function read(text: string, start: number, closer: string, depth: number, out: string[][]): number {
  // Too deep to follow: fall back to the rough cut, which finds more than is there.
  // Return -1 when a closer was wanted. text.length would look like the closer was found
  // at the end, and the caller would read the same tail again (#754).
  if (depth > MAX_DEPTH) {
    spend(text.length - start);
    for (const words of rough(text.slice(start))) out.push(words);
    return closer ? -1 : text.length;
  }
  const nested = (s: string) => out.push(...commandWords(s, depth + 1));
  let words: string[] = [];
  let substitutions: string[] = []; // the text inside each $(...) and <(...) of this command
  let word = '';
  let inWord = false;
  let isQuoted = false; // the word has a quote or a \ in it, so it is no keyword: `'case'`, `\case`
  let quotedAt = 0; // with isQuoted, how much of the word came before its first quote
  // Marks the word as quoted from here on, before the quoted text is added.
  const quote = () => {
    if (!isQuoted) quotedAt = word.length;
    isQuoted = true;
  };
  let caseAt = -1; // where `case` stands in words, when it starts the command
  let isLeading = true; // every word so far is a keyword, so the next one leads the command
  let line: string[][] = []; // the commands so far on this line, for heredocs
  let pipes: boolean[] = []; // for each of them, whether it pipes into the next
  let pending: Heredoc[] = [];
  let piped: string[] | null = null; // the command before a |
  let pipedSubstitutions: string[] = []; // the text inside each $(...) and <(...) of that command
  const groups: Group[] = []; // the groups open now, outermost first
  // A group that just closed, until we see where it sends its output. closeGroup sets it, so
  // the type is written out: TypeScript would take it for null.
  let closed = null as Group | null;
  let carried: string[] = []; // heredoc bodies a closed group pipes on, waiting for the command that reads them
  let cases = 0; // how many `case ... in` are open
  let isPattern = false; // reading a case pattern, up to its )
  let alternative = 0; // words in the pattern since the last |: more than one is no pattern

  const endWord = () => {
    const ended = inWord ? word : null;
    const isKeyword = !isQuoted;
    const isFirst = isLeading;
    if (ended !== null) {
      words.push(ended);
      readWords.add(words);
      // A redirect whose operator is unquoted, whatever its file: `>"AGENTS.md"` (#402).
      if (REDIRECT.test(ended) && (!isQuoted || (REDIRECT_OPERATOR.exec(ended)?.[0].length ?? Infinity) <= quotedAt)) {
        const marks = unquotedRedirects.get(words) ?? new Set<number>();
        marks.add(words.length - 1);
        unquotedRedirects.set(words, marks);
      }
      isLeading = isLeading && isKeyword && KEYWORDS.has(ended);
    }
    word = '';
    inWord = false;
    isQuoted = false;
    if (ended === null) return;
    if (isPattern && ++alternative > 1) isPattern = false; // `a b)` is no pattern: read it as a command
    if (!isKeyword) return;
    // A compound command is a group, open from its first word to the word that closes it.
    if (isFirst && Object.hasOwn(COMPOUNDS, ended)) {
      groups.push({ kind: COMPOUNDS[ended], from: line.length, to: 0, bodies: [], inner: [], reads: false });
    } else if (isFirst && groups.length > 0 && groups[groups.length - 1].kind === ended) {
      closeGroup(line.length + 1); // the command the closing word leads is the group's too
    }
    if (ended === 'esac' && isFirst && cases > 0) {
      cases--;
      isPattern = false;
    } else if (ended === 'case' && isFirst) {
      caseAt = words.length - 1;
    } else if (ended === 'in' && !isPattern) {
      // `case $x in`: what comes next is a pattern, not a command.
      if (caseAt !== -1 && words.length - 1 === caseAt + 2) {
        endCommand();
        cases++;
        isPattern = true;
        alternative = 0;
      }
    }
  };
  // Closes the innermost group, whose commands end before `to`. A group that reads commands
  // makes its parent one that does.
  const closeGroup = (to: number) => {
    closed = groups.pop() ?? null;
    if (closed === null) return;
    closed.to = to;
    const parent = groups.at(-1);
    if (parent && closed.reads) parent.reads = true;
  };
  // Where a group that just closed sends the bodies inside it, and whether this command
  // reads bodies a group piped on. A body that reaches no reader stays data.
  const settle = (pipe: boolean) => {
    if (carried.length > 0 && words.length > 0) {
      const reads = readsCommands(words);
      if (reads) for (const body of carried) nested(body);
      // `{ echo push --force; } | xargs git`: xargs hands the bodies to its program as words.
      const handed = reads ? null : xargsCommand(words);
      if (handed !== null) nested(`${handed} ${xargsInput(words, carried.join(' '))}`);
      if (reads || handed !== null || !pipe) carried = [];
    }
    if (closed) {
      if (pipe) {
        spend(closed.to - closed.from);
        groupBodies(closed, carried);
        // For the bodies read at this line's end: the group's commands pipe on, too.
        for (let i = closed.from; i < closed.to; i++) pipes[i] = true;
      } else groups.at(-1)?.inner.push(closed); // its bodies are its parent's now
      closed = null;
    }
  };
  // The end of the text or of a substitution. Bodies that still wait for a reader, after a
  // pipe to nothing or in a group that never closed, are read as commands, not guessed.
  const finish = () => {
    endCommand();
    for (const group of groups) groupBodies(group, carried);
    for (const body of carried) nested(body);
  };
  const endCommand = (pipe = false) => {
    endWord();
    spend(words.length);
    line.push(words);
    pipes.push(pipe);
    settle(pipe);
    if (words.length === 0) return;
    out.push(words);
    if (groups.length > 0) {
      // The innermost group reads; it tells its parent when it closes (see closeGroup).
      if (readsCommands(words)) groups[groups.length - 1].reads = true;
      // What the command prints, as `echo` would, waits in the group for where it goes.
      const printed = printedText(words);
      if (printed) groups[groups.length - 1].bodies.push(printed);
    }
    const at = runnerAt(words);
    if (at !== -1) {
      // `bash -c 'x'`, `eval "x"`, `ssh host 'x'`: read the string it runs as commands.
      nested(runString(words, at));
      // `echo 'npm publish' | bash`: the words before the pipe are the shell's input.
      if (piped) nested(printedText(piped));
    }
    // `bash <(x)`, `source <(x)`, `eval "$(x)"`: what x prints is commands, as in `x | bash`.
    // All of them in one group: in a group piped to a shell, every line is read as commands.
    if (substitutions.length > 0 && (at !== -1 || isSource(words))) nested(`{ ${substitutions.join('\n')}\n} | bash`);
    // `echo push | xargs git`: xargs hands what comes in to its program as words.
    // `xargs -0` also splits on a null, which printf writes as `\0` (#573).
    const handed = piped ? xargsCommand(words) : null;
    if (piped && handed !== null) nested(`${handed} ${xargsInput(words, printedText(piped))}`);
    // `cat <(x) | bash`, `echo "$(x)" | xargs git`: the command before the pipe may print
    // what x prints. In a group piped on, each line x prints reaches the reader.
    if (pipedSubstitutions.length > 0 && (at !== -1 || handed !== null)) {
      const xargs = xargsUsesNull(words) ? `xargs -0 ${handed}` : `xargs ${handed}`;
      nested(`{ ${pipedSubstitutions.join('\n')}\n} | ${at !== -1 ? 'bash' : xargs}`);
    }
    if (pipe && piped !== null && passesOn(words)) {
      // `echo x | tee f | bash`: tee hands on what echo printed. Its own `$(x)` and `<(x)`
      // substitutions are read too: over-reading is fine. pipedSubstitutions is this reader's own array.
      for (const substitution of substitutions) pipedSubstitutions.push(substitution);
    } else {
      piped = pipe ? words : null;
      pipedSubstitutions = pipe ? substitutions : [];
    }
    substitutions = [];
    words = [];
    caseAt = -1;
    isLeading = true;
  };

  let index = start;
  while (index < text.length) {
    spend(1);
    const character = text[index];
    const next = text[index + 1];
    // A separator inside what looked like a pattern means it was none: the words so far, and
    // every command before, are read as commands. Only words since the last cut are dropped.
    const isCut = character === ';' || character === '&' || (character === '|' && next === '|') || ((character === '\n' || character === '(') && (inWord || words.length > 0));
    if (isPattern && isCut) isPattern = false;
    if (isPattern && (character === ')' || character === '|' || character === '(')) endWord();
    if (isPattern && (character === ')' || character === '|' || character === '(')) {
      // A case pattern, `a|b)` or `(a)`, names values, not programs. The commands come after the ).
      if (character === ')') {
        words = [];
        caseAt = -1;
        isLeading = true;
        isPattern = false;
      }
      alternative = 0;
      index++;
      continue;
    }
    if (closer && character === closer && !(character === ')' && groups.at(-1)?.kind === '(')) {
      finish();
      return index + 1;
    }
    if (character === ' ' || character === '\t' || character === '\r') {
      endWord();
      index++;
    } else if (character === '\n') {
      endCommand();
      index = pending.length ? bodies(text, index + 1, pending, { line, pipes, groups }, depth, out) : index + 1;
      pending = [];
      line = [];
      pipes = [];
      spend(groups.length);
      for (const group of groups) group.from = 0;
    } else if (character === '#' && !inWord) {
      while (index < text.length && text[index] !== '\n') index++;
    } else if (character === '\\') {
      if (next !== '\n') {
        quote();
        word += next ?? character;
        inWord = true;
      }
      index += 2;
    } else if (character === "'" || (character === '$' && next === "'")) {
      // '...' is as written. $'...' takes \ escapes, so \' does not close it.
      const ansi = character === '$';
      const open = ansi ? index + 1 : index;
      const end = ansi ? closeAnsi(text, open + 1) : text.indexOf("'", open + 1);
      spend((end === -1 ? text.length : end) - open);
      if (end === -1) index = open + 1; // unclosed: drop the quote and read on
      else {
        const body = text.slice(open + 1, end);
        quote();
        word += ansi ? body.replace(/\\(.)/gs, '$1') : body;
        inWord = true;
        index = end + 1;
      }
    } else if (character === '"' || (character === '$' && next === '"')) {
      const open = character === '$' ? index + 1 : index;
      const quoted = readDouble(text, open + 1, depth, out, false, substitutions);
      if (quoted === RAN_OUT) index = text.length; // a substitution in it never closed and read the rest
      else if (!quoted) index = open + 1; // unclosed: drop the quote and read on
      else {
        quote();
        word += quoted.value;
        inWord = true;
        index = quoted.end;
      }
    } else if ((character === '$' || character === '<' || character === '>') && next === '(') {
      // $(...), $((...)), <(...) and >(...): the inside runs on its own.
      const end = read(text, index + 2, ')', depth + 1, out);
      if (end === -1) {
        // Unclosed: the read inside already read the rest as commands. Never read it again.
        endCommand();
        index = text.length;
      } else {
        if (character !== '>' && text[index + 2] !== '(') substitutions.push(text.slice(index + 2, end - 1));
        word += text.slice(index, end);
        inWord = true;
        index = end;
      }
    } else if (character === '`') {
      const end = read(text, index + 1, '`', depth + 1, out);
      if (end !== -1) {
        substitutions.push(text.slice(index + 1, end - 1));
        word += text.slice(index, end); // kept in the word, as $(...) is, so a check sees the unknown part
      }
      inWord = true;
      index = end === -1 ? text.length : end; // unclosed: the read inside read the rest
    } else if (character === '(' && next === '(') {
      // (( maths )): read the inside on its own, so a << there is a shift, not a heredoc.
      endWord();
      const end = read(text, index + 1, ')', depth + 1, out);
      if (end === -1) endCommand();
      index = end === -1 ? text.length : end; // unclosed: the read inside read the rest
    } else if (character === '(' && word.endsWith('%') && isGitFormatAtom(text, index)) {
      // A git format such as `%(refname)` is one word, as the quote note above says: git
      // reads it as the value of `--format`, and a shell refuses the unquoted form. Reading
      // it whole keeps the tag name in the same command, so the release check sees it (#873).
      // Only an atom is read whole. Anything else, such as `%(git push --tags)` or an
      // unclosed `%(`, falls to the group arm below and still reads as the command it is.
      const stop = text.indexOf(')', index + 1) + 1;
      word += text.slice(index, stop);
      inWord = true;
      index = stop;
    } else if (character === '(' || (character === '{' && !inWord && /\s/.test(next ?? ''))) {
      // A subshell or a group cuts like a separator, and is open until its ) or }.
      endCommand();
      groups.push({ kind: character, from: line.length, to: 0, bodies: [], inner: [], reads: false });
      index++;
    } else if ((character === ')' && groups.at(-1)?.kind === '(') || (character === '}' && !inWord && /[\s;|&)<>]|^$/.test(next ?? '') && groups.at(-1)?.kind === '{')) {
      endCommand();
      closeGroup(line.length);
      index++;
    } else if (character === ';' && cases > 0 && (next === ';' || next === '&')) {
      // `;;`, `;&` and `;;&` end a case item: a pattern comes next.
      endCommand();
      isPattern = true;
      alternative = 0;
      index += next === ';' && text[index + 2] === '&' ? 3 : 2;
    } else if (character === ')' || character === ';' || (character === '}' && !inWord && /[\s;]|^$/.test(next ?? ''))) {
      // A brace inside a word (${x}, a{b,c}) does not cut.
      endCommand();
      index++;
    } else if (character === '&') {
      if (next === '>' || word.endsWith('>')) {
        // &> and >& are redirects, not separators. `hi&>f` is `hi &>f`.
        if (next === '>' && inWord && !isOperatorStart(word, isQuoted)) endWord();
        word += character;
        inWord = true;
        index++;
      } else {
        endCommand();
        index += next === '&' ? 2 : 1;
      }
    } else if (character === '|' && !isQuoted && /^(\d+|\{[A-Za-z_]\w*\}|&)?>$/.test(word)) {
      // `>|` writes its file even with noclobber on: a redirect, not a pipe (#402).
      word += character;
      index++;
    } else if (character === '|') {
      endCommand(next !== '|');
      index += next === '|' || next === '&' ? 2 : 1;
    } else if (character === '<' && next === '<' && text[index + 2] === '<') {
      // A here-string is one more word. A shell that reads it is a runner, so it is read.
      endWord();
      words.push('<<<');
      index += 3;
    } else if (character === '<' && next === '<' && !word.endsWith('<')) {
      // `3<<EOF`: the number names the file descriptor, part of the redirect, not a word.
      if (inWord && !isQuoted && /^(\d+|\{[A-Za-z_]\w*\})$/.test(word)) {
        word = '';
        inWord = false;
      }
      endWord();
      spend(groups.length);
      const doc = heredoc(text, index + 2, line.length, [...groups]);
      if (doc) {
        // Right after a group closes, the heredoc is the group's input: `{ read a; } <<EOF`,
        // `while read l; do x; done <<EOF` (there the closing word leads the command).
        if (closed && withoutRedirects(words).length === (closed.kind === '(' || closed.kind === '{' ? 0 : 1)) doc.doc.group = closed;
        pending.push(doc.doc);
        index = doc.end;
      } else {
        words.push('<<'); // no word after it: bash calls that an error; read on
        index += 2;
      }
    } else if (character === '>' && inWord && !isOperatorStart(word, isQuoted)) {
      // An unquoted > inside a word starts a redirect, as in bash: `echo hi>f` is `echo hi >f` (#402).
      endWord();
      word = character;
      inWord = true;
      index++;
    } else {
      word += character;
      inWord = true;
      index++;
    }
  }
  finish();
  return closer ? -1 : text.length;
}

// Adds the bodies of `group` and of the groups closed inside it to `into`. Each closed group
// has one parent, and its bodies are taken once, so a deep nest of groups costs no more
// than its bodies.
