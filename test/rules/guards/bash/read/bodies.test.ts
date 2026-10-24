import '../../../../repo/home.ts';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkCommand } from '../../../../../src/rules/guards/index.ts';
import { blocked, allowed, force, refusedAs, isBlockedByList, py, shouldBlock } from '../../../../../test/repo/helpers.ts';

test('bash: a shell that reads a heredoc, a pipe or a here-string runs it (#105)', () => {
  for (const c of [
    'bash <<-EOF\n\tnpm publish\n\tEOF',
    "sh <<'EOF'\nnpm publish\nEOF",
    'env FOO=1 bash -s <<EOF\nnpm publish\nEOF',
    'cat <<EOF | bash\nnpm publish\nEOF',
    "ssh host <<'EOF'\nnpm publish\nEOF",
    'echo "npm publish" | bash',
    "printf 'npm publish\\n' | sh",
    'bash <<< "npm publish"',
    'ssh host "git push --tags"',
  ]) blocked(c);
  allowed('cat <<< "npm publish"');
  // After the end line, the text is commands again.
  blocked('cat <<-EOF\n\tdata\n\tEOF\nnpm publish');
  allowed('cat <<-EOF\n\tnpm publish\n\tEOF\nls');
});

// #196: three false refusals in one night, each from a heredoc body a non-shell reads.

test('bash: a heredoc read by a program that is not a shell is data (#196)', () => {
  const caseOne = "cat > body.md <<'EOF'\n## What happened\nThe owner runs npm publish after the tag.\nEOF";
  allowed(caseOne);
  allowed("node - <<'EOF'\nconst a = 'git commit -m \"x\"';\nconst b = 'nice -n 10';\nEOF");
  allowed(`cat > issue.md <<'EOF'\nA PR body written with:\n\n${caseOne}\n\nwas refused.\nEOF`);
  for (const command of [
    'cat > f <<EOF\ngit push --force\nEOF',
    "tee notes.md <<'EOF'\nnpm publish\nEOF",
    "gh issue create --title 'check: add x' --body-file - <<'EOF'\ngh release create v1\nEOF",
    "nice -n 10 node - <<'EOF'\ngit push --tags\nEOF",
    // A word that names a shell or a runner is not the program: a file called sh or script.
    'cat > sh <<EOF\nnpm publish\nEOF',
    'cat > script <<EOF\nnpm publish\nEOF',
    'node x.ts --shell bash <<EOF\nnpm publish\nEOF',
    // Only the command that holds the << and what it pipes into read the body.
    'cat <<EOF > run.sh; bash -n run.sh\nnpm publish\nEOF',
    'cat <<EOF && bash -c true\nnpm publish\nEOF',
    // Several heredocs, quoted and not, with <<-: each body goes to its own command.
    "cat <<'A' > a.md; tee b.md <<-B\nnpm publish\nA\n\tgit push --force\n\tB",
    'cat <<A <<"B"\nnpm publish\nA\ngit push --tags\nB',
  ]) allowed(command);
  // The same text read by the block list: python is stopped by its own name, not its body.
  assert.equal(checkCommand("python3 - <<'EOF'\nprint(1)\nEOF", { cwd: process.cwd(), env: {}, config: { commands: { block: { python3: 'TypeScript only' } } } })?.id, 'blocked-command');
});

test('bash: a heredoc read by a shell is commands, and so are the lines after it (#196)', () => {
  for (const command of [
    "bash <<'EOF'\ngit push --force\nEOF",
    'sh -s <<EOF\nnpm publish\nEOF',
    'nice -n 10 bash <<EOF\nnpm publish\nEOF',
    'sudo -u x zsh <<EOF\nnpm publish\nEOF',
    'sudo -s <<EOF\nnpm publish\nEOF',
    '/bin/dash <<-EOF\n\tnpm publish\n\tEOF',
    'ksh <<EOF\nnpm publish\nEOF',
    'cat <<EOF | tee log | bash\nnpm publish\nEOF',
    'cat <<EOF |\nnpm publish\nEOF\nbash',
    'cat <<EOF\ndata\nEOF\ngit push --force',
    "node - <<'EOF'\nconsole.log(1);\nEOF\nnpm publish",
    // The second heredoc is a shell's, though the first is data.
    "cat <<'A'; bash <<'B'\nhello\nA\nnpm publish\nB",
    'cat > f <<A <<B; ls\nx\nA\ny\nB\ngit push --force',
  ]) blocked(command);
});

test('bash: a shell after a keyword or a launcher reads the heredoc (#196)', () => {
  for (const command of [
    "if true; then bash <<'EOF'\ngit push --force origin main\nEOF\nfi",
    "for r in a; do bash <<'EOF'\ngit push --force origin main\nEOF\ndone",
    'while false; do sh <<EOF\ngit push --force origin main\nEOF\ndone',
    "! bash <<'EOF'\nnpm publish\nEOF",
    "stdbuf -oL bash <<'EOF'\ngit push --force origin main\nEOF",
    "setsid bash <<'EOF'\ngit push --force origin main\nEOF",
    "busybox sh <<'EOF'\ngit push --force origin main\nEOF",
    "chrt -f 10 bash <<'EOF'\nnpm publish\nEOF",
    "cat <<'EOF' | stdbuf -oL bash\ngit push --force origin main\nEOF",
    // A program the guard does not know may hand its input to a shell: refused, not guessed.
    "some-launcher --flag bash <<'EOF'\nnpm publish\nEOF",
  ]) blocked(command);
  // A program known to read data keeps its body as data, with a shell word after it.
  allowed("if true; then cat > sh <<'EOF'\nnpm publish\nEOF\nfi");
  allowed("stdbuf -oL tee bash <<'EOF'\nnpm publish\nEOF");
});

test('bash: a redirect before the program, and the heredoc it holds (#226)', () => {
  blocked("2>&1 bash <<'EOF'\ngit push --force\nEOF");
  blocked(">out bash <<'EOF'\nnpm publish\nEOF");
  // The program is cat, and the shell names are files.
  allowed(">out cat <<'EOF'\ngit push --force\nEOF");
  allowed("> sh cat <<'EOF'\nnpm publish\nEOF");
  allowed("cat > f <<'EOF'\ngit push --force\nEOF");
});

test('bash: a heredoc in a group or subshell that pipes into a shell is commands (#226)', () => {
  for (const command of [
    "{ cat <<'EOF'; } | bash\ngit push --force\nEOF",
    "( cat <<'EOF' ) | sh\ngit push --force\nEOF",
    "{ cat <<'EOF'; echo; } | bash\nnpm publish\nEOF",
    "{ cat <<'EOF'; }|bash\nnpm publish\nEOF",
    "{ cat <<'EOF'; } | tee log | bash\nnpm publish\nEOF",
    "{ cat <<'EOF'; } |\nbash\nnpm publish\nEOF",
    "{\ncat <<'EOF'\ngit push --force\nEOF\n} | bash",
    "(\ncat <<'EOF'\ngit push --force\nEOF\n) | sh",
    "{ { cat <<'EOF'; }\nnpm publish\nEOF\n} | bash",
    "{\ncat <<'EOF'\nnpm publish\nEOF\n} | tee x | bash",
    // A group that never closes: bash stops, the guard does not guess.
    "{\ncat <<'EOF'\nnpm publish\nEOF\n",
    "echo 'npm publish' | (bash)",
  ]) blocked(command);
  for (const command of [
    "{ cat <<'EOF'; } > file\ngit push --force\nEOF",
    "( cat <<'EOF' ) > file\ngit push --force\nEOF",
    "{\ncat <<'EOF'\ngit push --force\nEOF\n} > file",
    "{ cat <<'EOF'; } | grep x\nnpm publish\nEOF",
    "{\ncat <<'EOF'\nnpm publish\nEOF\n} | tee x\nbash -n x",
    'f() { echo hi; }',
    'echo $((1<<2))',
    '(( i = 1 << 2 ))',
  ]) allowed(command);
  assert.ok(isBlockedByList(`( (${py} x) )`), 'a subshell in a subshell');
});

test('bash: a heredoc on exec alone or a bare redirect feeds the shell, so it is commands (#226)', () => {
  for (const command of [
    `exec <<'EOF'; bash\n${force}\nEOF`,
    `exec 0<<'EOF'; sh\n${force}\nEOF`,
    `exec 3<<'EOF'; bash <&3\n${force}\nEOF`,
    `<<'EOF'\n${force}\nEOF`,
    `X=1 <<'EOF'\n${force}\nEOF`,
  ]) blocked(command);
  for (const command of [
    `exec cat <<'EOF'\n${force}\nEOF`,
    `cat 3<<'EOF'\n${force}\nEOF`,
    `while read line; do echo "$line"; done <<'EOF'\n${force}\nEOF`,
  ]) allowed(command);
});

test('bash: env -S reads its own escapes before it splits the string (#226)', () => {
  const spaced = (escape: string) => ['env ', "-S'git", `${escape}push`, `${escape}--for` + 'ce', `${escape}origin`, `${escape}main'`].join('');
  for (const escape of ['\\_', '\\t', '\\n', '\\v', '\\f', '\\r']) blocked(spaced(escape));
  blocked(['env ', "--split-string='git", '\\_push', "\\_--for" + "ce'"].join(''));
  allowed(['env ', "-S'git", '\\_status', '\\cgit push --for' + "ce'"].join(''));
  allowed(['env ', "-S'git", "\\_status'"].join(''));
  shouldBlock([['env ', `-S'${py}`, "\\_x'"].join('')]);
});

test('bash: a heredoc right after a group or subshell is the group\'s input (#226)', () => {
  for (const command of [
    `{ read -r a; } <<'EOF'\n${force}\nEOF`,
    `( read -r a ) <<'EOF'\n${force}\nEOF`,
    `{\n  read -r a\n  read -r b\n} <<'EOF'\n${force}\nEOF`,
    `{ cat; } <<'EOF' > out\n${force}\nEOF`,
  ]) allowed(command);
  for (const command of [
    `{ bash; } <<'EOF'\n${force}\nEOF`,
    `( read -r a; sh ) <<'EOF'\n${force}\nEOF`,
    `{\n  bash\n} <<'EOF'\n${force}\nEOF`,
    `{ cat; } <<'EOF' | bash\n${force}\nEOF`,
  ]) blocked(command);
});

test('bash: source -- /dev/stdin, //dev/stdin and /proc/<pid>/fd/0 run their input (#226)', () => {
  for (const command of [
    `source -- /dev/stdin <<'EOF'\n${force}\nEOF`,
    `. //dev/stdin <<'EOF'\n${force}\nEOF`,
    `. /dev//fd/0 <<'EOF'\n${force}\nEOF`,
    `. /proc/$$/fd/0 <<'EOF'\n${force}\nEOF`,
    `echo '${force}' | source /proc/123/fd/0`,
  ]) blocked(command);
  allowed(`source -- ./env.sh <<'EOF'\n${force}\nEOF`);
  allowed(`. /proc/self/status <<'EOF'\n${force}\nEOF`);
});

test('bash: a heredoc ends where bash ends it: at EOF for <<$\'EOF\', and not at EOF\\r (#283)', () => {
  refusedAs(`cat <<$'EOF'\nx\nEOF\n${force}\n$EOF`, 'force-push');
  refusedAs(`cat <<$"EOF"\nx\nEOF\n${force}\n$EOF`, 'force-push');
  refusedAs(`cat <<'EOF'\nEOF\r\ncat <<'X'\nEOF\n${force}\nX`, 'force-push');
  // `<<EOF\r` (a CRLF line): the word is EOF\r, the body ends at EOF\r, and the next line runs.
  refusedAs(`cat <<'EOF'\r\nx\r\nEOF\r\n${force}\r\n`, 'force-push');
  refusedAs(`cat <<EOF\r\nx\r\nEOF\r\n${force}\r\n`, 'force-push');
  // Look-alikes: the push is in the body, which cat prints.
  allowed(`cat <<$'EOF'\n${force}\nEOF`);
  allowed(`cat <<'EOF'\n${force}\r\nEOF`);
  allowed(`cat <<'EOF'\r\n${force}\r\nEOF\r\n`);
  // Only the word itself ends a body: a space before it does not, nor spaces after <<-.
  allowed(`cat << 'A'\nx\n A\n${force}\nA`);
  allowed(`cat <<-A\nx\n  A\n${force}\nA`);
});

test('bash: what a substitution prints, handed to a shell, is commands (#283)', () => {
  for (const command of [
    `bash <(echo '${force}')`,
    `source <(echo '${force}')`,
    `. <(printf '%s\\n' '${force}')`,
    `bash <(cat <<'EOF'\n${force}\nEOF\n)`,
    `bash -c "$(cat <<'EOF'\n${force}\nEOF\n)"`,
    `eval "$(cat <<'EOF'\n${force}\nEOF\n)"`,
    `eval "$(echo '${force}')"`,
    `eval \`echo '${force}'\``,
    `sh -c "$(printf '%s' '${force}')"`,
  ]) refusedAs(command, 'force-push');
  for (const command of [
    'bash <(echo ls)',
    `cat <(echo '${force}')`,
    `diff <(echo '${force}') <(echo x)`,
    `bash <(cat <<'EOF'\nls\nEOF\n)`,
    `git commit -m "$(cat <<'EOF'\nfix: say why ${force} is refused\nEOF\n)"`,
    `echo "$(echo '${force}')"`,
  ]) allowed(command);
});

test('bash: a compound command piped to a shell is read like a group (#283)', () => {
  for (const command of [
    `if true; then cat <<'E'\n${force}\nE\nfi | bash`,
    `for i in 1; do cat <<'E'\n${force}\nE\ndone | bash`,
    `while true; do echo '${force}'; break; done | sh`,
    `until false; do echo '${force}'; done | bash`,
    `case a in a) echo '${force}';; esac | bash`,
    `{ echo '${force}'; } | bash`,
    `( echo '${force}' ) | bash`,
    `if true; then { echo '${force}'; }; fi | bash`,
  ]) refusedAs(command, 'force-push');
  for (const command of [
    `if true; then cat <<'E'\n${force}\nE\nfi | cat`,
    `for i in 1; do echo '${force}'; done`,
    `{ echo '${force}'; } | tee out`,
    'if true; then echo ls; fi | bash',
    `if true; then echo x; fi\necho '${force}' | cat`,
  ]) allowed(command);
});

test('bash: a loop fed by a heredoc that runs each line reads it as commands (#283)', () => {
  refusedAs(`while read l; do eval "$l"; done <<'E'\n${force}\nE`, 'force-push');
  refusedAs(`while read -r l; do $l; done <<'E'\n${force}\nE`, 'force-push');
  refusedAs(`while read -r l; do "$l"; done <<'E'\n${force}\nE`, 'force-push');
  allowed(`while read -r l; do echo "$l"; done <<'E'\n${force}\nE`);
  allowed(`while read -r l; do printf '%s\\n' "$l"; done <<'E'\n${force}\nE`);
});

test('bash: what a command prints through a pipe reaches the shell or xargs git (#308)', () => {
  const pushForce = force.split(' ').slice(1).join(' ');
  const [, push, option] = force.split(' ');
  for (const command of [
    `cat <(echo '${force}') | bash`,
    `cat <(echo '${force} origin main') | sh`,
    `echo $(echo '${force}') | bash`,
    `echo "$(echo '${force}')" | bash`,
    `cat <(echo '${force}') | source /dev/stdin`,
    `printf '%s\\n' ${push} ${option} | xargs git`,
    `printf '%s\\n' ${push} origin ${option} | xargs git`,
    `printf '%s %s\\n' ${push} ${option} origin main | xargs -n 9 git`,
    `printf 'git %s\\n' '${pushForce}' | bash`,
    `printf '%b' 'echo x\\n${force}' | bash`,
    `printf '%d\\n' ${push} ${option} | xargs git`,
    `echo "$(echo ${pushForce})" | xargs git`,
    `{ echo ${pushForce}; } | xargs git`,
  ]) refusedAs(command, 'force-push');
  for (const command of [
    `printf '%s\\n' ${push} --tags | xargs git`,
    `printf '%s\\n' ${push} origin --tags | xargs git`,
    `printf '%s\\n' ${push} origin v1.2.0 | xargs git`,
    `cat <(echo 'git ${push} --tags') | bash`,
  ]) refusedAs(command, 'release');
  for (const command of [
    'cat <(echo ls) | grep x',
    "printf '%s\\n' a b | sort",
    "printf '%s\\n' a.ts | xargs git add",
    `cat <(echo '${force}') | cat`,
    `echo $(echo '${force}') | tee out`,
    `printf '%s\\n' '${force}' | grep x`,
    'cat <(echo ls) | bash',
  ]) allowed(command);
});

test('bash: cat and tee in the middle of a pipeline hand on what came before (#314)', () => {
  const pushForce = force.split(' ').slice(1).join(' ');
  const tags = `${force.split(' ').slice(0, 2).join(' ')} --tags`;
  for (const [command, id] of [
    [`cat <(echo '${force}') | tee f | bash`, 'force-push'],
    [`echo '${force}' | cat | bash`, 'force-push'],
    [`echo '${force}' | cat - | tee a b | cat -u | sh`, 'force-push'],
    [`echo ${pushForce} | tee f | xargs git`, 'force-push'],
    [`cat <(echo '${tags}') | tee f | bash`, 'release'],
    [`echo '${tags}' | cat | bash`, 'release'],
  ]) refusedAs(command, id);
  for (const command of [
    'echo ls | tee f | grep x',
    `echo '${force}' | tee f | grep x`,
    // cat with a file prints the file, not what comes in.
    `echo '${force}' | cat notes.txt | bash`,
    'echo ls | cat | bash',
  ]) allowed(command);
});

test('bash: env -S puts a variable\'s value in place of ${NAME}, which the guard reads as empty (#283)', () => {
  const [git, push, option] = force.split(' ');
  refusedAs(`env -S"${git} ${push} ${option.slice(0, 5)}\${X}${option.slice(5)} origin main"`, 'force-push');
  refusedAs(`env -S'${git} ${push} ${option.slice(0, 5)}\${X}${option.slice(5)}'`, 'force-push');
  allowed('env -S\'git status ${X}\'');
});

// ---- Commands that print account details (#390) ----
