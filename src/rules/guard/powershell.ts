// The guard's reader for PowerShell (#332): the same rules, a second parser.
//
// A Windows agent often runs PowerShell: Codex's shell tool, Copilot CLI, and Claude Code's
// PowerShell tool send the command as typed. Read as a POSIX shell, `;`, `|`, `&&`, a
// `{ ... }` block and the cmdlets that remove or write files are missed. This module turns
// PowerShell text into the shape the command rules already read: one text per statement,
// with each cmdlet mapped to the program the rules know (`Remove-Item` to `rm`,
// `Set-Content` to `tee`). The rules then answer exactly as they do for a shell.
//
// It refuses rather than guesses. A quote that does not close, a write whose target is a
// variable or a subexpression, a write cmdlet that takes its input from a pipe, or a
// cmdlet this module does not know makes the call unreadable: a rule that cannot see the
// path cannot allow it.

/** PowerShell text the guard cannot read: the call is refused, never let through. */
export class UnreadablePowerShell extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnreadablePowerShell';
  }
}

/** The PowerShell runs that start a command. */
const SHELL_PROGRAMS = new Set(['pwsh', 'powershell']);

/** The cmdlets, aliases and programs that write, and the program the rules know for each. */
const WRITE_CMDLETS = new Map<string, string>([
  ['remove-item', 'rm'],
  ['ri', 'rm'], ['del', 'rm'], ['erase', 'rm'], ['rd', 'rm'], ['rmdir', 'rm'], ['rm', 'rm'],
  ['copy-item', 'cp'], ['cpi', 'cp'], ['copy', 'cp'], ['cp', 'cp'],
  ['move-item', 'mv'], ['mi', 'mv'], ['move', 'mv'], ['mv', 'mv'],
  ['rename-item', 'mv'], ['ren', 'mv'],
  ['new-item', 'mkdir'], ['mkdir', 'mkdir'], ['md', 'mkdir'],
  ['touch', 'touch'],
  ['set-content', 'tee'], ['sc', 'tee'],
  ['add-content', 'tee'], ['ac', 'tee'],
  ['clear-content', 'tee'], ['clc', 'tee'],
  ['out-file', 'tee'],
  ['export-csv', 'tee'],
  ['tee-object', 'tee'], ['tee', 'tee'],
  ['set-item', 'tee'], ['si', 'tee'],
  ['set-itemproperty', 'tee'], ['sp', 'tee'],
  ['remove-itemproperty', 'tee'], ['rp', 'tee'],
  ['rename-itemproperty', 'tee'], ['rnp', 'tee'],
]);

/** The cmdlets and aliases that only read, and the program the rules know for each. */
const READ_CMDLETS = new Map<string, string>([
  ['get-content', 'cat'], ['gc', 'cat'], ['cat', 'cat'], ['type', 'cat'],
  ['get-childitem', 'ls'], ['gci', 'ls'], ['ls', 'ls'], ['dir', 'ls'],
  ['select-string', 'grep'], ['sls', 'grep'],
  ['set-location', 'cd'], ['sl', 'cd'], ['cd', 'cd'], ['chdir', 'cd'],
  ['push-location', 'pushd'], ['pushd', 'pushd'],
  ['pop-location', 'popd'], ['popd', 'popd'],
  ['write-output', 'echo'], ['write-host', 'echo'], ['write', 'echo'], ['echo', 'echo'],
  ['import-csv', 'cat'], ['ipcsv', 'cat'],
  ['invoke-expression', 'eval'], ['iex', 'eval'],
  ['invoke-webrequest', 'curl'], ['iwr', 'curl'], ['invoke-restmethod', 'curl'], ['curl', 'curl'], ['wget', 'curl'],
]);

/** Verbs that change something the rules may care about, so an unknown noun is unreadable. */
const UNSAFE_VERBS = new Set(['set', 'add', 'clear', 'remove', 'rename', 'copy', 'move', 'new', 'save', 'update', 'install', 'uninstall', 'register', 'unregister', 'enable', 'disable', 'restore', 'backup', 'publish', 'push', 'sync', 'mount', 'dismount', 'stop', 'start', 'restart', 'suspend', 'resume', 'invoke', 'import', 'export', 'optimize', 'repair', 'reset', 'grant', 'revoke', 'block', 'unblock', 'protect', 'unprotect', 'lock', 'unlock', 'connect', 'disconnect', 'send', 'submit', 'approve', 'deny', 'confirm', 'undo']);

/** Programs that run their own language, which this reader does not parse. */
const OTHER_SHELLS = new Set(['cmd', 'mshta', 'wscript', 'cscript', 'command']);

/** Cmdlets this module reads on its own, so they are never "unknown". */
const KNOWN_CMDLETS = new Set(['import-csv', 'invoke-item', 'ii', 'start-process', 'saps', 'start-job', 'invoke-command', 'invoke-command', 'add-type', 'new-object', 'test-path', 'get-item', 'get-itemproperty', 'get-location', 'pwd', 'get-process', 'get-service', 'get-date', 'start-sleep', 'sleep', 'write-error', 'write-warning', 'write-verbose', 'out-null', 'out-string', 'out-host', 'convertto-json', 'convertfrom-json', 'select-object', 'where-object', 'foreach-object', 'sort-object', 'measure-object', 'format-table', 'format-list', 'get-command', 'get-help', 'help', 'man', 'get-member', 'get-variable', 'get-history', 'read-host', 'clear-host', 'cls', 'clear', 'join-path', 'split-path', 'resolve-path', 'get-acl', 'get-module']);

/** The programs whose PowerShell parameters this reader turns into their own flags. */
const MAPS_FLAGS = new Set(['rm', 'cp', 'mv', 'tee']);

/** The programs this reader writes, whose targets it checks. */
const WRITE_TARGETS = new Set([...MAPS_FLAGS, 'mkdir', 'touch']);

/** The module's one flag with a value this reader keeps: a path the rules can check. */
const PATH_PARAMS = new Set(['-path', '-literalpath', '-destination', '-target', '-source', '-name', '-newname', '-filepath', '-outfile', '-file', '-pattern']);

/** A flag with a value that is not a path: dropped, with its value. */
const DROP_VALUE_PARAMS = new Set(['-value', '-encoding', '-itemtype', '-erroraction', '-errorvariable', '-credential', '-stream', '-filter', '-include', '-exclude', '-depth', '-width', '-inputobject', '-delimiter', '-argumentlist', '-totalcount', '-first', '-last', '-skip']);

/** A flag with no value: dropped. */
const DROP_FLAGS = new Set(['-confirm', '-whatif', '-verbose', '-debug', '-nonewline', '-noclobber', '-passthru', '-asbytestream', '-wait', '-recurse', '-r', '-force', '-append', '-hidden', '-noninteractive', '-noprofile']);

/** Flags the mapped programs take, with the meaning PowerShell gives them. */
const MAP_FLAGS = new Map<string, string>([
  ['-recurse', '-r'], ['-r', '-r'],
  ['-force', '-f'],
  ['-append', '-a'],
]);

type Token =
  | { kind: 'word'; text: string }
  | { kind: 'pipe' }
  | { kind: 'end' }
  | { kind: 'subexpression' };

/** The program name a word names: its last part, lowercased, without `.exe` or a module. */
export function powerShellProgram(word: string): string {
  const name = word.slice(Math.max(word.lastIndexOf('/'), word.lastIndexOf('\\')) + 1);
  return name.toLowerCase().replace(/\.exe$/, '');
}

/** Whether `text` is PowerShell, so the guard reads it with the second parser too. */
export function isPowerShell(text: string): boolean {
  const first = powerShellProgram(text.trim().split(/[\s;|&(){}]+/)[0] ?? '');
  if (SHELL_PROGRAMS.has(first)) return true;
  // A variable PowerShell sets, or a cmdlet it spells with a verb and a noun.
  if (/\$env:|\$PS(?:Item|Version|Home|Module)\b/i.test(text)) return true;
  if (/\b(?:Remove-Item|Get-ChildItem|New-Item|Set-Content|Add-Content|Copy-Item|Move-Item|Rename-Item|Invoke-Expression|Invoke-WebRequest|Start-Process|Out-File|Test-Path|Get-Content|Select-String|iex|iwr)\b/i.test(text)) return true;
  // A backtick at a line end, or a parameter that carries its value after a colon.
  if (/`\r?\n/.test(text) || /\s-[A-Za-z][A-Za-z0-9]*:\S/.test(text)) return true;
  return /\s-(?:Recurse|ErrorAction|LiteralPath|ItemType|NoProfile|ExecutionPolicy|EncodedCommand)\b/i.test(text);
}

/**
 * Every command `text` runs, as PowerShell reads it: one text per pipeline, with the
 * cmdlets written as the programs the rules know. Throws `UnreadablePowerShell` when a
 * statement cannot be read.
 */
export function readPowerShell(text: string, depth = 0): string[] {
  if (depth > 6) throw new UnreadablePowerShell('the command nests too deeply');
  const commands: string[] = [];
  let segments: string[][] = [];
  let segment: string[] = [];
  const endSegment = () => {
    if (segment.length) segments.push(segment);
    segment = [];
  };
  const endStatement = (opensSubexpression = false) => {
    endSegment();
    if (segments.length) commands.push(...readStatement(segments, depth, opensSubexpression));
    segments = [];
  };
  for (const token of tokenize(text)) {
    if (token.kind === 'word') {
      segment.push(token.text);
      continue;
    }
    if (token.kind === 'pipe') {
      endSegment();
      continue;
    }
    endStatement(token.kind === 'subexpression');
  }
  endStatement();
  return commands;
}

/** The text as tokens: words, the pipe, the end of a statement, and an opening `(`. */
function tokenize(text: string): Token[] {
  const tokens: Token[] = [];
  let word = '';
  let inWord = false;
  let at = 0;
  const endWord = () => {
    if (!inWord) return;
    tokens.push({ kind: 'word', text: word });
    word = '';
    inWord = false;
  };
  const endStatement = (token: Token) => {
    endWord();
    tokens.push(token);
  };
  while (at < text.length) {
    const character = text[at];
    if (character === '`') {
      const next = text[at + 1];
      if (next === undefined) throw new UnreadablePowerShell('a backtick ends the command');
      // A backtick at a line end joins the next line to this command, as in a shell.
      if (next === '\n') {
        at += 2;
        continue;
      }
      if (next === '\r' && text[at + 2] === '\n') {
        at += 3;
        continue;
      }
      word += next;
      inWord = true;
      at += 2;
      continue;
    }
    if (character === "'" || character === '"') {
      inWord = true;
      at++;
      for (;;) {
        if (at >= text.length) throw new UnreadablePowerShell(character === "'" ? "a single quote is not closed" : 'a double quote is not closed');
        const inner = text[at];
        if (character === '"' && inner === '`') {
          const next = text[at + 1];
          if (next === undefined) throw new UnreadablePowerShell('a backtick ends the command');
          if (next === '\n') {
            at += 2;
            continue;
          }
          word += next === 'n' ? '\n' : next === 't' ? '\t' : next;
          at += 2;
          continue;
        }
        if (inner === character) {
          // A doubled quote is that quote, in both forms (#332).
          if (text[at + 1] === character) {
            word += character;
            at += 2;
            continue;
          }
          at++;
          break;
        }
        word += inner;
        at++;
      }
      continue;
    }
    if (character === '#' && !inWord) {
      while (at < text.length && text[at] !== '\n') at++;
      continue;
    }
    if (/\s/.test(character)) {
      endWord();
      if (character === '\n') tokens.push({ kind: 'end' });
      at++;
      continue;
    }
    if (character === ';') {
      endStatement({ kind: 'end' });
      at++;
      continue;
    }
    if (character === '|') {
      endWord();
      if (text[at + 1] === '|') {
        tokens.push({ kind: 'end' });
        at += 2;
      } else {
        tokens.push({ kind: 'pipe' });
        at++;
      }
      continue;
    }
    if (character === '&') {
      endStatement({ kind: 'end' });
      at += text[at + 1] === '&' ? 2 : 1;
      continue;
    }
    // A redirect is a word the shell rules read as one: `> file`, `>> file`.
    if (character === '>') {
      endWord();
      const redirect = text[at + 1] === '>' ? '>>' : '>';
      tokens.push({ kind: 'word', text: redirect });
      at += redirect.length;
      continue;
    }
    if (character === '{' || character === '}' || character === ')') {
      endStatement({ kind: 'end' });
      at++;
      continue;
    }
    if (character === '(') {
      endStatement({ kind: 'subexpression' });
      at++;
      continue;
    }
    word += character;
    inWord = true;
    at++;
  }
  endWord();
  return tokens;
}

/** One statement, cut at its pipes: a pipeline, a shell run, or a block's commands. */
function readStatement(segments: string[][], depth: number, opensSubexpression: boolean): string[] {
  const commands: string[] = [];
  let pipeline: string[] = [];
  const endPipeline = () => {
    if (pipeline.length) commands.push(pipeline.join(' | '));
    pipeline = [];
  };
  for (const [index, words] of segments.entries()) {
    const name = powerShellProgram(words[0] ?? '');
    if (SHELL_PROGRAMS.has(name)) {
      const run = readShellRun(words, depth);
      // A shell at the end of a pipe and with no command of its own runs stdin as code:
      // `iwr x | pwsh` is the pipe into a shell, to the rules (#332).
      if (index > 0 && run.length === 0) {
        pipeline.push('sh');
        continue;
      }
      endPipeline();
      commands.push(...run);
      continue;
    }
    const isInvoke = name === 'iex' || name === 'invoke-expression';
    // `Start-Process` runs another program: read it as that program's command (#332).
    if (name === 'start-process' || name === 'saps') {
      const started = readStartProcess(words, depth);
      if (started.length === 1) {
        pipeline.push(started[0]);
        continue;
      }
      endPipeline();
      commands.push(...started);
      continue;
    }
    // `iwr x | iex` runs the download as code: the pipe into a shell, to the rules.
    if (index > 0 && isInvoke && words.length === 1) {
      pipeline.push('sh');
      continue;
    }
    // `iex $x` and `iex (Get-Content x)` run text the guard cannot read.
    if (isInvoke && (opensSubexpression || words.slice(1).some((word) => /[$`]/.test(word)))) {
      throw new UnreadablePowerShell(`${words[0]} runs a command yokoten cannot read: write the command in plain text`);
    }
    const isWrite = WRITE_CMDLETS.has(name) || (!READ_CMDLETS.has(name) && looksCmdlet(name) && UNSAFE_VERBS.has(verbOf(name)));
    if (isWrite) {
      // A write that takes its input from a pipe, or its target from a subexpression, is
      // opaque: the guard cannot see which paths it changes.
      if (index > 0) throw new UnreadablePowerShell(`${words[0]} takes its input from a pipe, and yokoten cannot see it`);
      if (opensSubexpression && words.length === 1) throw new UnreadablePowerShell(`${words[0]} takes its target from a subexpression, and yokoten cannot read it`);
    }
    pipeline.push(readSegment(words));
  }
  endPipeline();
  return commands;
}

/** A `pwsh` or `powershell` call: the commands inside its `-Command`, or an encoded one. */
function readShellRun(words: string[], depth: number): string[] {
  for (let index = 1; index < words.length; index++) {
    // A parameter may carry its value after a colon, as in `-EncodedCommand:<base64>`.
    const attached = /^(-[A-Za-z][A-Za-z0-9]*):(.*)$/s.exec(words[index]);
    const flag = (attached?.[1] ?? words[index]).toLowerCase();
    // PowerShell accepts any prefix of `-EncodedCommand` that is not another parameter:
    // `-e`, `-en`, `-enc`, up to the whole name (#332).
    if (flag === '-ec' || (flag.length >= 2 && '-encodedcommand'.startsWith(flag))) {
      const value = attached?.[2] ?? words[index + 1];
      if (value === undefined) throw new UnreadablePowerShell('-EncodedCommand has no command');
      return readEncoded(value, depth);
    }
    if (flag === '-command' || flag === '-c') {
      const rest = attached !== null ? [attached[2], ...words.slice(index + 1)] : words.slice(index + 1);
      const script = rest.join(' ');
      if (script === '') throw new UnreadablePowerShell('-Command has no command');
      return readPowerShell(script, depth + 1);
    }
    // `-File` runs a script the guard cannot see: refuse it rather than let it through.
    if (flag === '-file' || flag === '-f') throw new UnreadablePowerShell(`${words[0]} runs a script file, and yokoten cannot read it: pass the commands with -Command`);
  }
  return [];
}

/** An encoded command, decoded as PowerShell wrote it: UTF-16LE, in base64. */
function readEncoded(value: string, depth: number): string[] {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value)) throw new UnreadablePowerShell('the encoded command is not base64');
  const script = Buffer.from(value, 'base64').toString('utf16le');
  if (!script.trim() || script.includes('\uFFFD')) throw new UnreadablePowerShell('the encoded command is empty or not base64');
  return readPowerShell(script, depth + 1);
}

/** `Start-Process`: the program it starts, with its own arguments, as a command. */
function readStartProcess(words: string[], depth: number): string[] {
  let target = '';
  const args: string[] = [];
  for (let index = 1; index < words.length; index++) {
    const attached = /^(-[A-Za-z][A-Za-z0-9]*):(.*)$/s.exec(words[index]);
    const flag = (attached?.[1] ?? words[index]).toLowerCase();
    const value = attached?.[2] ?? words[index + 1];
    if (flag === '-filepath' || flag === '-path' || flag === '-pspath') {
      if (value === undefined) throw new UnreadablePowerShell('Start-Process names no program');
      target = value;
      if (attached === null) index++;
      continue;
    }
    if (flag === '-argumentlist' || flag === '-args') {
      if (value === undefined) throw new UnreadablePowerShell('Start-Process names no arguments');
      args.push(...value.split(/[\s,]+/).filter((part) => part !== ''));
      if (attached === null) index++;
      continue;
    }
    if (flag.startsWith('-') && isFlag(flag)) continue;
    if (target === '') target = words[index];
    else args.push(words[index]);
  }
  if (target === '') throw new UnreadablePowerShell('Start-Process names no program');
  const inner = [target, ...args];
  for (const word of inner) {
    // A program or argument the guard cannot see through, such as `$command` or `@args`.
    if (/[$`@]/.test(word)) throw new UnreadablePowerShell(`Start-Process runs ${word}, a value yokoten cannot read`);
  }
  if (SHELL_PROGRAMS.has(powerShellProgram(target))) return readShellRun(inner, depth);
  return [inner.map(quoteWord).join(' ')];
}

/** One pipeline segment, with its cmdlet or program written as the rules know it. */
function readSegment(words: string[]): string {
  const name = powerShellProgram(words[0] ?? '');
  const mapped = WRITE_CMDLETS.get(name) ?? READ_CMDLETS.get(name);
  if (mapped !== undefined) return readMapped(mapped, words);
  if (OTHER_SHELLS.has(name)) throw new UnreadablePowerShell(`${words[0]} runs its own command language, which yokoten does not read`);
  if (looksCmdlet(name) && !KNOWN_CMDLETS.has(name)) {
    const verb = verbOf(name);
    if (UNSAFE_VERBS.has(verb)) throw new UnreadablePowerShell(`yokoten does not know what ${words[0]} changes`);
  }
  return words.map(quoteWord).join(' ');
}

/** A cmdlet whose program the rules know, with its parameters turned into that program's. */
function readMapped(program: string, words: string[]): string {
  let target = program;
  const args: string[] = [];
  for (let index = 1; index < words.length; index++) {
    const word = words[index];
    // A parameter may carry its value after a colon, as in `-Path:.git` (#332).
    const attached = /^(-[A-Za-z][A-Za-z0-9]*):(.*)$/s.exec(word);
    const flag = (attached?.[1] ?? word).toLowerCase();
    if (target === 'mkdir' && flag === '-itemtype') {
      const kind = (attached?.[2] ?? words[index + 1] ?? '').toLowerCase();
      if (kind === 'file' || kind === 'symboliclink') target = 'touch';
      if (attached === null) index++;
      continue;
    }
    if (attached !== null) {
      if (PATH_PARAMS.has(flag)) args.push(attached[2]);
      else if (DROP_VALUE_PARAMS.has(flag) || DROP_FLAGS.has(flag) || MAP_FLAGS.has(flag)) {
        const mappedFlag = MAP_FLAGS.get(flag);
        if (mappedFlag !== undefined && MAPS_FLAGS.has(target)) args.push(mappedFlag);
      } else if (WRITE_TARGETS.has(target)) throw new UnreadablePowerShell(`${words[0]} has ${word}, a parameter yokoten cannot read`);
      else args.push(word);
      continue;
    }
    if (DROP_VALUE_PARAMS.has(flag)) {
      index++;
      continue;
    }
    if (PATH_PARAMS.has(flag)) {
      const value = words[index + 1];
      if (value === undefined) throw new UnreadablePowerShell(`${words[0]} names ${word} with no path`);
      args.push(value);
      index++;
      continue;
    }
    if (flag.startsWith('-') && isFlag(flag)) {
      const mappedFlag = MAP_FLAGS.get(flag);
      if (mappedFlag !== undefined && MAPS_FLAGS.has(target)) args.push(mappedFlag);
      continue;
    }
    args.push(word);
  }
  if (WRITE_TARGETS.has(target)) {
    for (const arg of args) {
      // A target the guard cannot read: `$path`, `@paths`, or the `$` left by a `$(` subexpression.
      if (/[$`@]/.test(arg)) throw new UnreadablePowerShell(`the target of ${words[0]} is ${arg}, a value yokoten cannot read`);
    }
  }
  return [target, ...args.map(quoteWord)].join(' ');
}

/**
 * Whether a word is a PowerShell parameter. A short flag such as `-rf` is left as it is:
 * it came from a program's own syntax, not from a cmdlet's parameters.
 */
function isFlag(flag: string): boolean {
  return DROP_FLAGS.has(flag) || MAP_FLAGS.has(flag) || PATH_PARAMS.has(flag) || DROP_VALUE_PARAMS.has(flag) || /^-[A-Z][A-Za-z0-9]*$/.test(flag);
}

/** The verb of a cmdlet name: `Remove` in `Remove-Item`. */
function verbOf(name: string): string {
  const dash = name.indexOf('-');
  return dash === -1 ? '' : name.slice(0, dash);
}

/** Whether `name` has a cmdlet's shape, a verb and a noun. */
function looksCmdlet(name: string): boolean {
  return /^[a-z]+-[a-z][a-z0-9]*$/.test(name);
}

/** A word as a POSIX shell reads it: plain when it can be, single quotes when it cannot. */
function quoteWord(word: string): string {
  if (word === '') return "''";
  // A redirect stays a redirect: the rules read a quoted `>` as data.
  if (word === '>' || word === '>>') return word;
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(word) && !/^-/.test(word)) return word;
  if (/^-[A-Za-z0-9@%+=:,./-]+$/.test(word)) return word;
  return `'${word.replaceAll("'", "'\\''")}'`;
}
