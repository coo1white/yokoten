import '../../../repo/home.ts';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { assertLinear } from '../../../../scripts/linear.ts';
import { email, makeTempDir, post, postDir, postEnv, postMarks, token, WIDE } from '../../../repo/helpers.ts';
import { DEFAULTS, type Env } from '../../../../src/rules/config.ts';
import { checkCommand } from '../../../../src/rules/guards.ts';
import { formatFinding } from '../../../../src/rules/message.ts';
import { isBotProgram, lonePost } from '../../../../src/rules/privacy/post/check-post.ts';

// ---- A body file the same command writes (#439) ----
//
// Only `cat > path <<'EOF' && gh … path`, as the whole command, is followed.

const plainRefusal = (command: string) => {
  const f = post(command);
  assert.equal(f?.id, 'unreadable-command', command);
  assert.match(f?.what ?? '', /the guard runs/, command);
  assert.match(f?.fix ?? '', /write the file in one command, then post it in the next/, command);
};

// Every other shape is refused: these came from review, and each one gets a body past a
// more general reading of the command.
const reviewCases: [string, string][] = [
  ["backslash-newline unquoted", "cat > f.md <<EOF\nQuiet\\\nVale\nEOF\ngh issue comment 3 -F f.md"],
  ["baseline clean", "cat > f.md <<'EOF'\nclean\nEOF\ngh issue comment 3 -F f.md"],
  ["baseline mark", "cat > f.md <<'EOF'\nQuietVale\nEOF\ngh issue comment 3 -F f.md"],
  ["brace expansion tee", "cat > f.md <<'EOF'\nclean\nEOF\necho QuietVale | tee {f,g}.md\ngh issue comment 3 -F f.md"],
  ["glob ? redirect", "cat > f.md <<'EOF'\nclean\nEOF\necho QuietVale > ?.md\ngh issue comment 3 -F f.md"],
  ["glob [] cp", "cat > f.md <<'EOF'\nclean\nEOF\ncp src.txt [f].md\ngh issue comment 3 -F f.md"],
  ["function cat", "cat() { printf QuietVale; }\ncat > f.md <<'EOF'\nclean\nEOF\ngh issue comment 3 -F f.md"],
  ["function cat2", "function cat { printf QuietVale; }\ncat > f.md <<'EOF'\nclean\nEOF\ngh issue comment 3 -F f.md"],
  ["noclobber", "set -C\ncat > f.md <<'EOF'\nclean\nEOF\ngh issue comment 3 -F f.md"],
  ["readonly existing (plain)", "cat > ro.md <<'EOF'\nclean\nEOF\ngh issue comment 3 -F ro.md"],
  ["CRLF delim", "cat > f.md <<'EOF'\nclean\nEOF\r\nQuietVale\nEOF\ngh issue comment 3 -F f.md"],
  ["trailing space delim", "cat > f.md <<'EOF'\nclean\nEOF \nQuietVale\nEOF\ngh issue comment 3 -F f.md"],
  ["<<- tabs", "cat > f.md <<-'EOF'\n\tQuietVale\n\tEOF\ngh issue comment 3 -F f.md"],
  ["two heredocs same file", "cat > f.md <<'EOF'\nQuietVale\nEOF\ncat > f.md <<'EOF'\nclean\nEOF\ngh issue comment 3 -F f.md"],
  ["two heredocs one cmd", "cat > f.md <<'A' <<'B'\nQuietVale\nA\nclean\nB\ngh issue comment 3 -F f.md"],
  ["var reassign", "S=/x/f.md\nS=f.md\ncat > $S <<'EOF'\nclean\nEOF\nS=g.md\ngh issue comment 3 -F $S"],
  ["S=a S=b", "S=a.md S=f.md\ncat > $S <<'EOF'\nclean\nEOF\ngh issue comment 3 -F f.md"],
  ["S=a S=b gh", "S=a.md S=f.md\ncat > $S <<'EOF'\nQuietVale\nEOF\ngh issue comment 3 -F $S"],
  ["subshell export", "S=f.md\n(S=g.md; export S)\ncat > g.md <<'EOF'\nQuietVale\nEOF\ncat > $S <<'EOF'\nclean\nEOF\ngh issue comment 3 -F $S"],
  ["eval assign", "S=f.md\neval S=g.md\ncat > f.md <<'EOF'\nclean\nEOF\ngh issue comment 3 -F $S"],
  ["eval gh", "cat > f.md <<'EOF'\nQuietVale\nEOF\neval gh issue comment 3 -F f.md"],
  ["command gh", "cat > f.md <<'EOF'\nQuietVale\nEOF\ncommand gh issue comment 3 -F f.md"],
  ["env gh", "cat > f.md <<'EOF'\nQuietVale\nEOF\nenv gh issue comment 3 -F f.md"],
  ["xargs gh", "cat > f.md <<'EOF'\nQuietVale\nEOF\necho f.md | xargs gh issue comment 3 -F"],
  ["-Ff", "cat > f.md <<'EOF'\nQuietVale\nEOF\ngh issue comment 3 -Ff.md"],
  ["--body-file=", "cat > f.md <<'EOF'\nQuietVale\nEOF\ngh issue comment 3 --body-file=f.md"],
  ["process subst", "gh issue comment 3 -F <(echo QuietVale)"],
  ["${S:-x}", "cat > f.md <<'EOF'\nclean\nEOF\ngh issue comment 3 -F ${S:-g.md}"],
  ["IFS", "IFS=.\nS=f.md\ncat > f.md <<'EOF'\nclean\nEOF\ngh issue comment 3 -F $S"],
  ["tilde", "cat > ~/f.md <<'EOF'\nQuietVale\nEOF\ngh issue comment 3 -F $HOME/f.md"],
  ["cd between", "cat > f.md <<'EOF'\nclean\nEOF\ncd sub\ngh issue comment 3 -F f.md"],
  ["unquoted with $(..)", "cat > f.md <<EOF\n$(echo Quiet)Vale\nEOF\ngh issue comment 3 -F f.md"],
  ["unquoted backslash-dollar", "cat > f.md <<EOF\nQuiet\\Vale\nEOF\ngh issue comment 3 -F f.md"],
  ["case-fold", "cat > F.md <<'EOF'\nclean\nEOF\ngh issue comment 3 -F f.md"],
  ["symlink other name", "cat > target.md <<'EOF'\nQuietVale\nEOF\ngh issue comment 3 -F link.md"],
  ["writer in if", "if true; then cat > f.md <<'EOF'\nQuietVale\nEOF\nfi\ngh issue comment 3 -F f.md"],
  ["source", "cat > f.md <<'EOF'\nclean\nEOF\nsource x.sh\ngh issue comment 3 -F f.md"],
  ["mv dir", "cat > f.md <<'EOF'\nclean\nEOF\ncp -r ev/. .\ngh issue comment 3 -F f.md"],
  ["exec redirect", "cat > f.md <<'EOF'\nclean\nEOF\nexec 3>f.md\ngh issue comment 3 -F f.md"],
  ["fd write without naming", "exec 3>f.md\ncat > f.md <<'EOF'\nclean\nEOF\necho QuietVale >&3\ngh issue comment 3 -F f.md"],
  ["alias", "shopt -s expand_aliases\nalias cat='printf QuietVale'\ncat > f.md <<'EOF'\nclean\nEOF\ngh issue comment 3 -F f.md"],
  ["trap", "trap 'echo QuietVale > f.md' DEBUG\ncat > f.md <<'EOF'\nclean\nEOF\ngh issue comment 3 -F f.md"],
  ["background earlier", "sleep 1 && echo QuietVale > f\\.md &\ncat > f.md <<'EOF'\nclean\nEOF\ngh issue comment 3 -F f.md"],
  ["bg loop", "(sleep 0.1; cp ev/f.md .) &\ncat > f.md <<'EOF'\nclean\nEOF\ngh issue comment 3 -F f.md"],
  ["sh -c var", "S=f.md bash -c 'echo QuietVale > $S'\ncat > f.md <<'EOF'\nclean\nEOF\ngh issue comment 3 -F f.md"],
  ["space split gh", "S='x -F f.md'\ncat > \"$S\" <<'EOF'\nclean\nEOF\ngh issue comment 3 -F $S"],
  ["ambiguous redirect", "S='a b.md'\ncat > $S <<'EOF'\nclean\nEOF\ngh issue comment 3 -F \"$S\""],
  ["source sets var", "S=g.md\ncat > g.md <<'EOF'\nclean\nEOF\n. ./x.sh\ngh issue comment 3 -F $S"],
  ["delim \"EOF\"", "cat > f.md <<\"EOF\"\n$(printf Quiet)Vale\nEOF\ngh issue comment 3 -F f.md"],
  ["delim \\EOF", "cat > f.md <<\\EOF\n$(printf Quiet)Vale\nEOF\ngh issue comment 3 -F f.md"],
  ["delim E'O'F", "cat > f.md <<E'O'F\n$(printf Quiet)Vale\nEOF\ngh issue comment 3 -F f.md"],
  ["delim space 'EOF'", "cat > f.md << 'EOF'\n$(printf Quiet)Vale\nEOF\ngh issue comment 3 -F f.md"],
  ["delim $X", "cat > f.md <<$X\n$(printf Quiet)Vale\n$X\ngh issue comment 3 -F f.md"],
  ["two docs two cmds one line", "cat > f.md <<'A'; cat > g.md <<'B'\nclean\nA\nQuietVale\nB\ngh issue comment 3 -F f.md"],
  ["two docs two cmds swap", "cat > g.md <<'A'; cat > f.md <<'B'\nclean\nA\nQuietVale\nB\ngh issue comment 3 -F f.md"],
  ["bg gh then write", "cat > f.md <<'EOF'\nclean\nEOF\ngh issue comment 3 -F f.md &\nprintf QuietVale > f.md; wait"],
  ["bg writer race", "(sleep 0.05; cp ev/f.md .) &\ncat > f.md <<'EOF'\nclean\nEOF\ngh issue comment 3 -F f.md; wait"],
  ["heredoc in && with gh before body", "cat > f.md <<'EOF' && gh issue comment 3 -F f.md\nQuietVale\nEOF"],
  ["line continuation in cmd", "cat > f.\\\nmd <<'EOF'\nclean\nEOF\ngh issue comment 3 -F f.md"],
  ["unicode delim", "cat > f.md <<'EOF'\nclean\nEOF \nQuietVale\nEOF\ngh issue comment 3 -F f.md"],
  ["semicolon after delim", "cat > f.md <<'EOF'\nclean\nEOF;\nQuietVale\nEOF\ngh issue comment 3 -F f.md"],
  ["nested $( heredoc", "X=$(cat <<'EOF'\nclean\nEOF\n)\ncat > f.md <<'EOF'\nclean\nEOF\ngh issue comment 3 -F f.md"],
  ["comment hides heredoc", "cat > f.md <<'EOF' # <<'X'\nclean\nEOF\ngh issue comment 3 -F f.md"],
  ["heredoc op in comment", "cat > f.md # <<'EOF'\nQuietVale\nEOF\ngh issue comment 3 -F f.md"],
  ["writer w/ var target null HOME", "cat > $HOME/f.md <<'EOF'\nclean\nEOF\ngh issue comment 3 -F f.md"],
  [">| target", "set -C\ncat >| f.md <<'EOF'\nclean\nEOF\ngh issue comment 3 -F f.md"],
  ["cat 1>", "cat 1> f.md <<'EOF'\nclean\nEOF\ngh issue comment 3 -F f.md"],
  ["redirect before cat", "> f.md cat <<'EOF'\nclean\nEOF\ngh issue comment 3 -F f.md"],
  ["assign prefix cat", "LC_ALL=C cat > f.md <<'EOF'\nclean\nEOF\ngh issue comment 3 -F f.md"],
  ["quoted cat", "'cat' > f.md <<'EOF'\nclean\nEOF\ngh issue comment 3 -F f.md"],
  ["/bin/cat", "/bin/cat > f.md <<'EOF'\nclean\nEOF\ngh issue comment 3 -F f.md"],
  ["./cat", "./cat > f.md <<'EOF'\nclean\nEOF\ngh issue comment 3 -F f.md"],
  ["PATH cat", "PATH=./bin\ncat > f.md <<'EOF'\nclean\nEOF\ngh issue comment 3 -F f.md"],
  ["hash -p", "hash -p ./bin/cat cat\ncat > f.md <<'EOF'\nclean\nEOF\ngh issue comment 3 -F f.md"],
  ["enable -n", "enable -f x cat\ncat > f.md <<'EOF'\nclean\nEOF\ngh issue comment 3 -F f.md"],
  ["ulimit", "ulimit -f 0\ncat > f.md <<'EOF'\nclean\nEOF\ngh issue comment 3 -F f.md"],
  ["mkdir f.md first?", "cat > f.md <<'EOF'\nclean\nEOF\ngh issue comment 3 -F f.md"],
  ["readonly var", "S=g.md\nreadonly S\nS=f.md\ncat > f.md <<'EOF'\nclean\nEOF\ngh issue comment 3 -F $S"],
  ["declare -i", "declare -i S\nS=f.md\ncat > f.md <<'EOF'\nclean\nEOF\ngh issue comment 3 -F $S"],
  ["declare -u", "declare -l S\nS=F.md\ncat > f.md <<'EOF'\nclean\nEOF\ngh issue comment 3 -F f.md"],
  ["declare -u gh", "declare -u S\nS=f.md\ncat > F.MD <<'EOF'\nclean\nEOF\ngh issue comment 3 -F $S"],
  ["export -n etc", "S=f.md; set -u; cat > f.md <<'EOF'\nclean\nEOF\ngh issue comment 3 -F $S"],
  ["brace in gh word", "cat > '{x,f.md}' <<'EOF'\nclean\nEOF\ngh issue comment 3 -F{x,f.md}"],
  ["PATH prepend", "PATH=$PWD/bin:$PATH\ncat > f.md <<'EOF'\nclean\nEOF\ngh issue comment 3 -F f.md"],
  ["readonly var disk", "S=g.md.old\nreadonly S\nS=f.md\ncat > f.md <<'EOF'\nclean\nEOF\ngh issue comment 3 -F $S"],
  ["IFS split", "S=f.md\nIFS=.\ncat > f.md <<'EOF'\nclean\nEOF\ngh issue comment 3 -F $S"],
  ['background gh', "cat > f.md <<'EOF' && gh issue comment 3 -F f.md &\nQuietVale\nEOF"],
  ['variable in the path', "S=f.md; cat > $S <<'EOF' && gh issue comment 3 -F $S\nclean\nEOF"],
  ['quoted path', "cat > 'f.md' <<'EOF' && gh issue comment 3 -F f.md\nclean\nEOF"],
  ['unquoted delimiter', "cat > f.md <<EOF && gh issue comment 3 -F f.md\nclean\nEOF"],
  ['other path to the same file', "cat > f.md <<'EOF' && gh issue comment 3 -F ./f.md\nclean\nEOF"],
  ['substitution in the gh line', "cat > f.md <<'EOF' && gh issue comment 3 --title \"$(date)\" -F f.md\nclean\nEOF"],
  ['a third command', "cat > f.md <<'EOF' && gh issue comment 3 -F f.md && echo done\nclean\nEOF"],
  ['text after the delimiter', "cat > f.md <<'EOF' && gh issue comment 3 -F f.md\nclean\nEOF\necho QuietVale > f.md"],
  ['gh redirect into the file', "gh issue comment 3 -F kept.md > kept.md"],
  ['env prefix', "cat > f.md <<'EOF' && env gh issue comment 3 -F f.md\nclean\nEOF"],
];

// More inputs from review (#439). Only these write no file and run nothing: the file on disk
// is still the one gh posts.
const writesNothing = new Set(["control: nothing","control: echo","echo -e"]);
const reviewCases2: [string, string][] = [
  ["control: nothing", "gh issue comment 3 -F f.md"],
  ["control: echo", "echo hi && gh issue comment 3 -F f.md"],
  ["control: cp", "cp ev/f.md f.md; gh issue comment 3 -F f.md"],
  ["cmdsubst in echo", "echo $(cp ev/f.md f.md) && gh issue comment 3 -F f.md"],
  ["cmdsubst in dq", "echo \"$(cp ev/f.md f.md)\" && gh issue comment 3 -F f.md"],
  ["backtick", "echo `cp ev/f.md f.md` && gh issue comment 3 -F f.md"],
  ["test -e $()", "test -e $(cp ev/f.md f.md) ; gh issue comment 3 -F f.md"],
  ["export X=$()", "export X=$(cp ev/f.md f.md) && gh issue comment 3 -F f.md"],
  ["assign X=$()", "X=$(cp ev/f.md f.md) gh issue comment 3 -F f.md"],
  ["procsubst echo", "echo <(cp ev/f.md f.md) >/dev/null; sleep 0.2; gh issue comment 3 -F f.md"],
  ["procsubst >()", "echo QuietVale > >(cat > f.md); sleep 0.2; gh issue comment 3 -F f.md"],
  ["procsubst arg", "printf QuietVale >(cat > f.md) ; sleep 0.2; gh issue comment 3 -F f.md"],
  ["echo >| f", "echo QuietVale >| f.md; gh issue comment 3 -F f.md"],
  ["echo >& f", "echo QuietVale >&f.md; gh issue comment 3 -F f.md"],
  [":> f", ":> f.md; gh issue comment 3 -F f.md"],
  ["true > f", "true > f.md; gh issue comment 3 -F f.md"],
  ["printf -v", "printf -v X %s y; gh issue comment 3 -F f.md"],
  ["printf -v subscript", "printf -v 'a[$(cp ev/f.md f.md)]' %s 1; gh issue comment 3 -F f.md"],
  ["test -v subscript", "test -v 'a[$(cp ev/f.md f.md)]'; gh issue comment 3 -F f.md"],
  ["[ -v subscript", "[ -v 'a[$(cp ev/f.md f.md)]' ]; gh issue comment 3 -F f.md"],
  ["arith recursive", "X='a[$(cp ev/f.md f.md)]'; echo $((X)); gh issue comment 3 -F f.md"],
  ["arith recursive2", "X='a[$(cp ev/f.md f.md)]' && echo $((X+1)) && gh issue comment 3 -F f.md"],
  ["arith $[]", "X='a[$(cp ev/f.md f.md)]'; echo $[X]; gh issue comment 3 -F f.md"],
  ["test -eq", "X='a[$(cp ev/f.md f.md)]'; test \"$X\" -eq 0; gh issue comment 3 -F f.md"],
  ["[[ -v", "[[ -v 'a[$(cp ev/f.md f.md)]' ]]; gh issue comment 3 -F f.md"],
  ["PS4 xtrace", "export PS4='$(cp ev/f.md f.md)'; set -x; gh issue comment 3 -F f.md"],
  ["PS4 plain", "PS4='$(cp ev/f.md f.md) ' && set -x && gh issue comment 3 -F f.md"],
  ["HOME tilde", "HOME=ev; gh issue comment 3 -F ~/f.md"],
  ["set -o noclobber", "set -o noclobber; gh issue comment 3 -F f.md"],
  ["cd subdir", "cd sub && gh issue comment 3 -F f.md"],
  ["gh pr view --web", "gh pr view --web 3; gh issue comment 3 -F f.md"],
  ["gh run view --log >f", "gh run view 1 --log > f.md; gh issue comment 3 -F f.md"],
  ["git log --output", "git log --output=f.md; gh issue comment 3 -F f.md"],
  ["git log -L", "git log -L1,1:f.md; gh issue comment 3 -F f.md"],
  ["git log -c", "git log -c; gh issue comment 3 -F f.md"],
  ["git log --cc", "git log --cc; gh issue comment 3 -F f.md"],
  ["git log -S", "git log -Sx; gh issue comment 3 -F f.md"],
  ["git status", "git status; gh issue comment 3 -F f.md"],
  ["git config --get --file", "git config --get --file f.md x; gh issue comment 3 -F f.md"],
  ["gh api GET", "gh api repos/a/b --jq . ; gh issue comment 3 -F f.md"],
  ["gh api --cache", "gh api repos/a/b --cache 1h; gh issue comment 3 -F f.md"],
  ["gh api -t", "gh api repos/a/b -t x; gh issue comment 3 -F f.md"],
  ["gh api method lowercase", "gh api repos/a/b/issues/3/comments --method=post; gh issue comment 3 -F f.md"],
  ["gh api -XPOST", "gh api -XPOST repos/a/b/issues/3/comments; gh issue comment 3 -F f.md"],
  ["yokoten bot -- echo >", "yokoten bot -- echo QuietVale > f.md; gh issue comment 3 -F f.md"],
  ["yokoten bot -- cp", "yokoten bot -- cp ev/f.md f.md; gh issue comment 3 -F f.md"],
  ["echo -e", "echo -e 'x' ; gh issue comment 3 -F f.md"],
  ["set -- $()", "set -- $(cp ev/f.md f.md); gh issue comment 3 -F f.md"],
  ["cd $()", "cd $(cp ev/f.md f.md; echo .) && gh issue comment 3 -F f.md"],
  ["bash -c", "bash -c 'cp ev/f.md f.md'; gh issue comment 3 -F f.md"],
  ["export -f? func", "f() { cp ev/f.md f.md; }; f; gh issue comment 3 -F f.md"],
  ["pushd", "pushd sub >/dev/null && gh issue comment 3 -F f.md"],
  ["export BASH_FUNC", "export 'BASH_FUNC_gh%%=() { cp ev/f.md f.md; command gh \"$@\"; }'; gh issue comment 3 -F f.md"],
  ["assign BASH_FUNC env", "env 'BASH_FUNC_x%%=() { :; }' true; gh issue comment 3 -F f.md"],
  ["heredoc to echo", "echo <<'EOF' && gh issue comment 3 -F f.md\n$(cp ev/f.md f.md)\nEOF"],
  ["unquoted heredoc to :", ": <<EOF\n$(cp ev/f.md f.md)\nEOF\ngh issue comment 3 -F f.md"],
  ["heredoc shape clean + extra", "cat > g.md <<'EOF' && gh issue comment 3 -F f.md\nclean\nEOF"],
  ["substring offset", "X='a[$(cp ev/f.md f.md)]'; echo ${HOME:X}; gh issue comment 3 -F f.md"],
  ["subscript var", "X='a[$(cp ev/f.md f.md)]'; echo ${a[X]}; gh issue comment 3 -F f.md"],
  ["export subscript", "export 'a[$(cp ev/f.md f.md)]=1'; gh issue comment 3 -F f.md"],
  ["assign subscript", "a[X]=1 && X='b[$(cp ev/f.md f.md)]' && a[X]=2; gh issue comment 3 -F f.md"],
  ["HOME cd", "HOME=ev; cd; gh issue comment 3 -F f.md"],
  ["GH_BROWSER repo view", "export GH_BROWSER='sh -c \"cp ev/f.md f.md\" x'; gh repo view a/b --web; gh issue comment 3 -F f.md"],
  ["BROWSER", "BROWSER='sh -c \"cp ev/f.md f.md\" x' gh repo view a/b --web; gh issue comment 3 -F f.md"],
  ["test -v subscript", "test -v 'a[$(cp ev/f.md f.md)]'; gh issue comment 3 -F f.md"],
  ["printf -v subscript", "printf -v 'a[$(cp ev/f.md f.md)]' %s 1; gh issue comment 3 -F f.md"],
  ["arith $[]", "X='a[$(cp ev/f.md f.md)]'; echo $[X]; gh issue comment 3 -F f.md"],
  ["PS4 xtrace", "export PS4='$(cp ev/f.md f.md)'; set -x; gh issue comment 3 -F f.md"],
  ["HOME tilde", "HOME=ev; gh issue comment 3 -F ~/f.md"],
];

// Inputs from the fourth review (#439). The shell may fill in any `$` or backtick outside single
// quotes by running code (`${X@P}`, `${!X}`, an `a[…]` name read as a number), so each one
// makes the line unsure. So do `$'…'`, a CR, `--web` or `-w`, and `..` after a cd.
const reviewCases3: string[] = [
  "X='a[$(cp ev/f.md f.md)]'; echo \"${!X}\"; gh issue comment 3 -F f.md",
  "X='a[$(cp ev/f.md f.md)]'; echo ${!X}; gh issue comment 3 -F f.md",
  "X='$(cp ev/f.md f.md)'; cd \"${X@P}\"; gh issue comment 3 -F ~/f.md",
  "X='$(cp ev/f.md f.md)'; : ${X@P}; gh issue comment 3 -F f.md",
  "X='$(cp ev/f.md f.md)'; test -n \"${X@P}\"; gh issue comment 3 -F f.md",
  "X='$(cp ev/f.md f.md)'; gh pr view \"${X@P}\"; gh issue comment 3 -F f.md",
  "X='$(cp ev/f.md f.md)'; export GH_HOST=\"${X@P}\"; gh issue comment 3 -F f.md",
  "X='$(cp ev/f.md f.md)'; Y=${X@P}; gh issue comment 3 -F f.md",
  "X='$(cp ev/f.md f.md)'; Y=${X@P} gh issue comment 3 -F f.md",
  "X='$(cp ev/f.md f.md)' Y=${X@P}; gh issue comment 3 -F f.md",
  "X='$(cp ev/f.md f.md)'; gh issue comment 3 -F f.md --title \"${X@P}\"",
  "X='$(cp ev/f.md f.md)'; gh issue comment 3 -F f.md \"${X@P}\"",
  "cd lnk; gh issue comment 3 -F ../f.md",
  "gh issue comment 3 -F f.md\r",
  "B=[; X=a${B}'$(cp ev/f.md f.md)]'; echo ${!X}; gh issue comment 3 -F f.md",
  "B='['; X=\"a${B}\\$(cp ev/f.md f.md)]\"; echo \"${!X}\"; gh issue comment 3 -F f.md",
  "X='$(cp ev/f.md f.md)'; echo \"${X@P}\"; gh issue comment 3 -F f.md",
  "X='\\$(cp ev/f.md f.md)'; echo \"${X@P}\"; gh issue comment 3 -F f.md",
  "B=[; Y=-v; X=a${B}'$(cp ev/f.md f.md)]'; test \"$Y\" \"$X\"; gh issue comment 3 -F f.md",
  "B=[; X=a${B}'$(cp ev/f.md f.md)]'; printf -v\"$X\" %s 1; gh issue comment 3 -F f.md",
  "B=[; X=a${B}'$(cp ev/f.md f.md)]'; echo $((X)); gh issue comment 3 -F f.md",
  "cp ev/f.md f.md; gh issue comment 3 -F f.md",
  "X='$(cp ev/f.md f.md)'; echo ${X@P}; gh issue comment 3 -F f.md",
  "Y=-v; X='a[$(cp ev/f.md f.md)]'; test \"$Y\" \"$X\"; gh issue comment 3 -F f.md",
  "Y=-v; X='a[$(cp ev/f.md f.md)]'; [ $Y $X ]; gh issue comment 3 -F f.md",
  "X='a[$(cp ev/f.md f.md)]'; printf -v\"$X\" %s 1; gh issue comment 3 -F f.md",
  "X='a[$(cp ev/f.md f.md)]'; printf -v$X %s 1; gh issue comment 3 -F f.md",
  "gh pr view 3 --web=true; gh issue comment 3 -F f.md",
  "echo x 1<>f.md; gh issue comment 3 -F f.md",
  "echo x {fd}>f.md; gh issue comment 3 -F f.md",
  "echo x &>f.md; gh issue comment 3 -F f.md",
  "echo x &>>f.md; gh issue comment 3 -F f.md",
  "echo x >\\\nf.md; gh issue comment 3 -F f.md",
  "pushd sub; pushd ev; pushd +1; gh issue comment 3 -F f.md",
  "echo ${X=$(cp ev/f.md f.md)}; gh issue comment 3 -F f.md",
  "echo ${X/a/$(cp ev/f.md f.md)}; gh issue comment 3 -F f.md",
  "echo $'\\x24(cp ev/f.md f.md)'; gh issue comment 3 -F f.md",
  "true\r\ncp ev/f.md f.md\r\ngh issue comment 3 -F f.md",
  "set -eu -o pipefail -o noclobber; gh issue comment 3 -F f.md",
  "set -o pipefail -o errtrace; gh issue comment 3 -F f.md",
  "set -e -o pipefail -o xtrace; gh issue comment 3 -F f.md",
  "cd -- ev; gh issue comment 3 -F f.md",
  "cd ev; gh issue comment 3 -F ../f.md",
  "trap 'cp ev/f.md f.md' EXIT; gh issue comment 3 -F f.md",
  "echo $(</dev/null) && gh issue comment 3 -F f.md",
  "cat > f.md <<'EOF' && gh issue comment 3 -F f.md\nQuietVale\nEOF",
  "cat > f.md <<'EOF' && gh issue comment 3 -F f.md\nclean\nEOF\ncp ev/f.md f.md",
  "f.md=1; gh issue comment 3 -F f.md",
  "OLDPWD=ev; cd - ; gh issue comment 3 -F f.md",
  "X=ev; cd $X; gh issue comment 3 -F f.md",
  "export GH_REPO=a/b GH_HOST=$(cp ev/f.md f.md); gh issue comment 3 -F f.md",
  "X='$(cp ev/f.md f.md)'; Y=${X@P}; gh issue comment 3 -F f.md --title \"${X@P}\"",
  "gh pr view 3 -w; gh issue comment 3 -F f.md",
  "gh pr view 3 -cw; gh issue comment 3 -F f.md",
  "gh pr view 3 --web=false; gh issue comment 3 -F f.md",
  "cd sub && gh issue comment 3 -F sub/../f.md",
  "echo '$(x)' $'\\x41'; gh issue comment 3 -F f.md",
  "echo hi;\rgh issue comment 3 -F f.md"
];

// Each of these runs nothing and writes no file, so the file on disk is still what gh posts.
const writesNothing3: string[] = [
  "gh issue comment 3 -F f.md",
  "cd ev\tgh issue comment 3 -F f.md",
  "git config --get alias.x; gh issue comment 3 -F f.md",
  "git rev-parse --git-path x; gh issue comment 3 -F f.md",
  "gh pr checks 3 --watch; gh issue comment 3 -F f.md",
  "cat > f.md <<'EOF' && gh issue comment 3 -F f.md\nclean\nEOF",
  "cat > f.md <<'EOF' && gh issue comment 3 -F f.md -F f.md\nclean\nEOF",
  "cat >f.md <<'EOF' && gh issue comment 3 -F f.md\nclean\nEOF\n",
  "X=1 Y=2; gh issue comment 3 -F f.md",
  "cd ~; gh issue comment 3 -F f.md",
  "GH_HOST=x gh pr view 3; gh issue comment 3 -F f.md",
  "NODE_USE_ENV_PROXY=1 yokoten bot -- gh pr view 3; gh issue comment 3 -F f.md"
];

// Round 5 (#439): the guard no longer follows bash's grammar. Beside other commands, a body
// file on disk is trusted only when the command is one line of plain words joined by ; and &&.
// Each of these got a file change past a closer reading of heredocs, or follows a cd that
// never ran in this shell.
const payload = "X='$(printf changed > f.md)'; true \"${X@P}\"";
const reviewCases5: string[] = [
  // A backslash in an unquoted delimiter: `<<true\\` ends at a line `true\`, so the payload runs.
  `: <<true\\\\\ntrue\\\n${payload}\ngh issue comment 3 -F f.md`,
  // A here-string is not a heredoc.
  `: <<<'true'\n${payload}\ngh issue comment 3 -F f.md`,
  // A backslash-newline in an unquoted body joins two lines, so the next EOF does not end it.
  `: <<EOF\nx\\\nEOF\ntrue '\nEOF\nX="\\$(printf changed > f.md)"; true "\${X@P}" \\'\ngh issue comment 3 -F f.md`,
  // \" inside a double-quoted delimiter.
  `: <<"E\\"F"\nE"F\n${payload}\ngh issue comment 3 -F f.md`,
  // A cd in a subshell, in the background or in a pipe does not move this shell.
  '(cd sub) && gh issue comment 3 -F f.md',
  'cd sub & gh issue comment 3 -F f.md',
  'cd sub | true; gh issue comment 3 -F f.md',
  // Each refused character, outside single quotes.
  'echo hi | gh issue comment 3 -F f.md',
  'echo hi & gh issue comment 3 -F f.md',
  'true 2>/dev/null; gh issue comment 3 -F f.md',
  'echo hi\ngh issue comment 3 -F f.md',
  'echo a\\ b; gh issue comment 3 -F f.md',
  'echo a#x; gh issue comment 3 -F f.md',
  'echo *.md; gh issue comment 3 -F f.md',
  'echo ?.md; gh issue comment 3 -F f.md',
  'echo [f].md; gh issue comment 3 -F f.md',
  'echo {a,b}; gh issue comment 3 -F f.md',
  'echo a~b; gh issue comment 3 -F f.md',
  'echo ~; gh issue comment 3 -F f.md',
  "echo 'open; gh issue comment 3 -F f.md",
  // The strict shape takes only a name in single quotes.
  'cat > f.md <<"EOF" && gh issue comment 3 -F f.md\nclean\nEOF',
  "cat > f.md <<'E-F' && gh issue comment 3 -F f.md\nclean\nE-F",
  "cat > f.md <<'EOF' && gh issue comment 3 -F f.md 2>/dev/null\nclean\nEOF",
];

test('an inline --body with an email address is stopped, with the same fix as the commit check', () => {
  const f = post(`gh issue create --title "check: fix a bug" --body "write to ${email}"`);
  assert.equal(f?.id, 'email');
  assert.equal(f?.what, 'the --body text holds an email address');
  const text = formatFinding(f);
  assert.match(text, /a post is public the moment it is sent/);
  assert.match(text, /noreply address/);
  assert.match(text, /privacy\.allow/);
  assert.ok(!text.includes(email), 'the address itself is never printed');
});

test('a --body-file with a private mark is stopped, by file and line; the mark is never printed', () => {
  writeFileSync(join(postDir, 'body.md'), 'Summary\n\nTested in QuietVale.\n');
  for (const command of ['gh pr create --title "feat: add t" --body-file body.md', 'gh issue comment 3 -F body.md', `gh pr create --body-file ${join(postDir, 'body.md')}`]) {
    const f = post(command);
    assert.equal(f?.id, 'private-mark', command);
    assert.equal(f?.line, 3);
    assert.ok(!formatFinding(f).toLowerCase().includes('quietvale'));
  }
});

test('release notes are read when a release is allowed', () => {
  writeFileSync(join(postDir, 'notes.md'), `thanks ${email}\n`);
  const approved = (command: string) => checkCommand(command, { env: { ...postEnv, YOKOTEN_RELEASE_APPROVAL: '1' }, config: DEFAULTS, cwd: postDir });
  assert.equal(approved(`gh release create v1 --notes "${email}"`)?.id, 'email');
  assert.equal(approved('gh release edit v1 --notes-file notes.md')?.id, 'email');
  assert.equal(approved('gh release create v1 --notes "clean notes"'), null);
});

test('a body file under ~ is refused unless HOME is a full path (#470)', () => {
  const dir = makeTempDir('yokoten-470-');
  writeFileSync(join(dir, 'b.md'), `write to ${email}\n`);
  mkdirSync(join(dir, '~'));
  writeFileSync(join(dir, '~', 'b.md'), 'clean\n');
  const postIn = (env: Env, command: string) => checkCommand(command, { env: { YOKOTEN_PRIVATE_MARKS: postMarks, ...env }, config: DEFAULTS, cwd: dir });
  for (const env of [{}, { HOME: '' }, { HOME: 'relative' }]) {
    for (const command of ['gh issue create --title "check: a" -F ~/b.md', 'gh issue create --title "check: a" --body-file ~/b.md', 'gh issue create --title "check: a" -F ~other/b.md']) {
      const f = postIn(env, command);
      assert.equal(f?.id, 'unreadable-command', `${JSON.stringify(env)} ${command}`);
      assert.match(formatFinding(f), /full path/);
    }
  }
  assert.equal(postIn({ HOME: dir }, 'gh issue create --title "check: a" -F ~/b.md')?.id, 'email');
  assert.equal(postIn({ HOME: dir }, 'gh issue create --title "check: a" -F ~other/b.md')?.id, 'unreadable-command');
});

test('a body file with .. goes up from the real folder, as the kernel does (#470)', () => {
  const dir = makeTempDir('yokoten-470-');
  const real = join(dir, 'real');
  mkdirSync(join(real, 'sub'), { recursive: true });
  writeFileSync(join(real, 'b.md'), `write to ${email}\n`);
  writeFileSync(join(dir, 'b.md'), 'clean\n');
  const link = join(dir, 'link');
  symlinkSync(join(real, 'sub'), link);
  const postIn = (env: Env, cwd: string, command: string) => checkCommand(command, { env: { YOKOTEN_PRIVATE_MARKS: postMarks, ...env }, config: DEFAULTS, cwd });
  // The working folder is a symlink.
  assert.equal(postIn({ HOME: postDir }, link, 'gh issue create --title "check: a" -F ../b.md')?.id, 'email');
  assert.equal(postIn({ HOME: postDir }, link, 'gh issue create --title "check: a" --body-file=../b.md')?.id, 'email');
  assert.equal(postIn({ HOME: postDir, YOKOTEN_RELEASE_APPROVAL: '1' }, link, 'gh release create v1 --notes-file ../b.md')?.id, 'email');
  assert.equal(postIn({ HOME: postDir }, postDir, `gh issue create --title "check: a" -F ${link}/../b.md`)?.id, 'email');
  // HOME is a symlink.
  assert.equal(postIn({ HOME: link }, postDir, 'gh issue create --title "check: a" -F ~/../b.md')?.id, 'email');
  // Control: no symlink, and `..` still finds the file.
  assert.equal(postIn({ HOME: postDir }, join(real, 'sub'), 'gh issue create --title "check: a" -F ../b.md')?.id, 'email');
});

test('a secret is named by kind, never printed', () => {
  const f = post(`gh pr comment 1 --body "use ${token}"`);
  assert.equal(f?.id, 'secret');
  assert.ok(!formatFinding(f).includes(token));
});

test('a heredoc whose end word the guard does not read exactly: the rest of the text is scanned (#466)', () => {
  const head = 'gh issue create --title t -F - ';
  for (const command of [
    // bash ends the body at `E:F`; the guard reads no plain name, so it scans to the end.
    `${head}<<'E:F'\nfrom QuietVale\nE:F`,
    // bash ends the body at `EOF`, not at a line `E`: the lines after `E` are posted too.
    `${head}<<"E"OF\nclean\nE\nfrom QuietVale\nEOF`,
    `${head}<<E'OF'\nclean\nE\nfrom QuietVale\nEOF`,
    `${head}<<'E'OF\nclean\nE\nfrom QuietVale\nEOF`,
    // bash ends the body only at a line that is the word exactly: `EOF ` and `EOF\r` don't.
    `${head}<<'EOF'\nclean\nEOF \nfrom QuietVale\nEOF`,
    `${head}<<'EOF'\nclean\nEOF\r\nfrom QuietVale\nEOF`,
  ]) {
    assert.equal(post(command)?.id, 'private-mark', command);
  }
  // Plain end words, bare or quoted, with a space or a dash before them.
  for (const word of ["'EOF'", '"EOF"', 'EOF', "-'EOF'", " 'EOF'", '- EOF']) {
    assert.equal(post(`${head}<<${word}\nfrom QuietVale\nEOF`)?.id, 'private-mark', word);
    assert.equal(post(`${head}<<${word}\nall clean\nEOF`), null, word);
  }
  // A line continuation inside the end word: the whole command is refused (#439).
  assert.equal(post(`${head}<<E\\\nF\nclean\nE\nfrom QuietVale\nEF`)?.id, 'unreadable-command');
  // A here-string is not a heredoc.
  assert.equal(post(`${head}<<< 'all clean'\necho done`), null);
});

test('a relative body file follows cd; one the guard cannot place stops the command (#391 review)', () => {
  mkdirSync(join(postDir, 'sub'), { recursive: true });
  writeFileSync(join(postDir, 'sub', 'note.md'), 'Seen in QuietVale.\n');
  // `cd sub` may land anywhere through CDPATH (#559), so the folder is unknown and the
  // body file can't be placed: unreadable, as below, not read from a guessed folder.
  const placed = post('cd sub && gh issue comment 3 --body-file note.md');
  assert.equal(placed?.id, 'unreadable-command');
  assert.match(placed?.fix ?? '', /full path/);
  assert.equal(post(`cd ${join(postDir, 'sub')} && gh issue comment 3 --body-file note.md`)?.id, 'private-mark');
  for (const command of ['cd "$X" && gh issue comment 3 --body-file note.md', 'gh pr create --body-file missing.md', 'cd sub && gh pr create --body-file body.md']) {
    const f = post(command);
    assert.equal(f?.id, 'unreadable-command', command);
    assert.match(f?.fix ?? '', /full path/);
  }
});

test('privacy comes before the title, and a file path in a finding hides home and marks (#391 review)', () => {
  const titled = checkCommand(`gh issue create --title "Mail ${email}" --body ok`, { env: postEnv, config: DEFAULTS, cwd: postDir, titles: true });
  assert.equal(titled?.id, 'email');
  mkdirSync(join(postDir, 'quietvale'), { recursive: true });
  writeFileSync(join(postDir, 'quietvale', 'notes.md'), `ask ${email}\n`);
  const f = post(`gh pr create --body-file ${join(postDir, 'quietvale', 'notes.md')}`);
  assert.equal(f?.id, 'email');
  assert.equal(f?.file, 'notes.md', 'the folder holds a mark, so only the name is shown');
  writeFileSync(join(postDir, 'plain.md'), `ask ${email}\n`);
  assert.equal(post(`gh pr create --body-file ${join(postDir, 'plain.md')}`)?.file, '~/plain.md');
});

test('only regular files up to 1 MB are read; others pass unread (#391 review)', () => {
  mkdirSync(join(postDir, 'folder'), { recursive: true });
  assert.equal(post('gh pr create --body-file folder'), null);
  writeFileSync(join(postDir, 'big.md'), `${email}\n${'x'.repeat(1024 * 1024)}`);
  assert.equal(post('gh pr create --body-file big.md'), null);
});

test('cat > file <<EOF && gh --body-file file: the heredoc is checked (#439)', () => {
  rmSync(join(postDir, 'fresh.md'), { force: true });
  for (const command of [
    `cat > fresh.md <<'EOF' && gh issue create --title "check: add t" --body-file fresh.md\nAll clean.\nEOF`,
    `cat >fresh.md <<'EOF' && gh pr comment 3 -F fresh.md\nAll clean, $(not run).\nEOF\n`,
    `cat > fresh.md <<'EOF' && gh issue comment 3 --body-file=fresh.md\nAll clean.\nEOF`,
    `cat > fresh.md <<'EOF' && gh issue comment 3 -Ffresh.md\nAll clean.\nEOF`,
    `cat > ~/fresh.md <<'EOF' && gh issue comment 3 -F ~/fresh.md --repo o/r\nAll clean.\nEOF`,
  ]) {
    assert.equal(post(command), null, command);
  }
});

test('a heredoc body with a private value is stopped, by file and line (#439)', () => {
  rmSync(join(postDir, 'fresh.md'), { force: true });
  const marked = post(`cat > fresh.md <<'EOF' && gh issue create --title "check: add t" --body-file fresh.md\nSummary\nTested in QuietVale.\nEOF`);
  assert.equal(marked?.id, 'private-mark');
  assert.equal(marked?.line, 2);
  assert.ok(!formatFinding(marked).toLowerCase().includes('quietvale'));
  assert.equal(post(`cat > fresh.md <<'EOF' && gh pr comment 3 -F fresh.md\nmail ${email}\nEOF`)?.id, 'email');
});

test('the file on disk is checked too, in case cat cannot replace it (#439)', () => {
  writeFileSync(join(postDir, 'old.md'), 'Seen in QuietVale.\n');
  assert.equal(post(`cat > old.md <<'EOF' && gh issue comment 3 -F old.md\nAll clean.\nEOF`)?.id, 'private-mark');
  writeFileSync(join(postDir, 'old.md'), 'clean\n');
  assert.equal(post(`cat > old.md <<'EOF' && gh issue comment 3 -F old.md\nAll clean.\nEOF`), null);
  // A read-only file (chmod 444): cat can't replace it, so what is there now is checked.
  writeFileSync(join(postDir, 'ro.md'), 'Seen in QuietVale.\n');
  chmodSync(join(postDir, 'ro.md'), 0o444);
  assert.equal(post(`cat > ro.md <<'EOF' && gh issue comment 3 -F ro.md\nAll clean.\nEOF`)?.id, 'private-mark');
  chmodSync(join(postDir, 'ro.md'), 0o644);
  // A folder there: cat fails, and the guard can't tell.
  mkdirSync(join(postDir, 'adir.md'), { recursive: true });
  plainRefusal(`cat > adir.md <<'EOF' && gh issue comment 3 -F adir.md\nclean\nEOF`);
});

test('a file on disk with nothing else in the command is read as before (#439)', () => {
  writeFileSync(join(postDir, 'kept.md'), `mail ${email}\n`);
  assert.equal(post('gh issue comment 3 -F kept.md')?.id, 'email');
  assert.equal(post(`cd ${postDir} && gh issue comment 3 -F kept.md`)?.id, 'email');
  // A redirect is not plain, so beside a cd the guard can't tell (#439 round 5).
  plainRefusal(`cd ${postDir} && gh issue comment 3 -F kept.md 2>/dev/null`);
  writeFileSync(join(postDir, 'kept.md'), 'clean\n');
  assert.equal(post('gh issue comment 3 -F kept.md'), null);
});

test('every other way to write a body file in the same command is refused (#439)', () => {
  mkdirSync(join(postDir, 'sub'), { recursive: true });
  for (const onDisk of [false, true]) {
    for (const name of ['f.md', 'g.md', 'ro.md', 'F.md', 'F.MD', 'target.md', 'link.md', 'kept.md']) {
      if (onDisk) writeFileSync(join(postDir, name), 'clean\n');
      else rmSync(join(postDir, name), { force: true });
    }
    for (const [name, command] of reviewCases) {
      const f = post(command);
      assert.ok(f !== null, `${name} (file on disk: ${onDisk})`);
    }
  }
  // An unclosed heredoc swallows the gh line: gh never runs, and nothing is posted.
  assert.equal(post("cat > f.md <<'EOF'\nclean\ngh issue comment 3 -F f.md"), null);
  // Each answer that is not about the text itself gives the plain reason.
  rmSync(join(postDir, 'f.md'), { force: true });
  plainRefusal(`cat > f.md <<'EOF'\nclean\nEOF\ngh issue comment 3 -F f.md`);
  plainRefusal('gh issue comment 3 -F "$(mktemp)"');
  plainRefusal('gh issue comment 3 -F $OUTSIDE/x.md');
  writeFileSync(join(postDir, 'f.md'), 'clean\n');
  plainRefusal(`cat > f.md <<'EOF'\nQuietVale\nEOF\ngh issue comment 3 -F f.md`);
  plainRefusal('echo QuietVale > f.md; gh issue comment 3 -F f.md');
  assert.match(post('gh issue comment 3 -F not-there.md')?.what ?? '', /doesn't exist yet when the guard runs/);
});

test('reading the heredoc shape stays linear (#439)', () => {
  rmSync(join(postDir, 'fresh.md'), { force: true });
  assertLinear(
    'a long heredoc body and a long gh line',
    (n) => `cat > fresh.md <<'EOF' && gh issue comment 3 ${'-F fresh.md '.repeat(n / 24)}--title "${'t'.repeat(n / 4)}"\n${'clean line\n'.repeat(n / 22)}EOF`,
    (command) => assert.equal(post(command), null),
  );
  assertLinear(
    'many commands before a gh with a body file',
    (n) => `${'cd . && '.repeat(n / 16)}gh issue comment 3 -F not-there.md`,
    (command) => assert.equal(post(command)?.id, 'unreadable-command'),
  );
});

test("the lead's command with a body file on disk: commands that write no file don't stop it (#439)", () => {
  const body = join(postDir, 'lead-body.md');
  const lead = `cd ${postDir} && export NODE_USE_ENV_PROXY=1 GH_REPO=o/r; node bin/yokoten.ts bot -- gh pr create --title t --body-file ${body}`;
  writeFileSync(body, 'All clean.\n');
  assert.equal(post(lead), null);
  assert.equal(post(lead.replace('node bin/yokoten.ts bot', 'yokoten bot')), null);
  // Loading a file with . or source may run anything, so the file on disk is not trusted.
  plainRefusal(`set -a; . ~/.config/yokoten/keys.env; set +a; ${lead}`);
  // A `$` the shell fills in may run code, so the older form with $(…) is refused too.
  plainRefusal(`OWNER=$(gh pr view 1 --json assignees -q '.assignees[0].login'); ${lead} --assignee "$OWNER"`);
  for (const reads of ['git rev-parse HEAD', 'git config --get user.name', 'git remote get-url origin', 'gh issue list', 'gh pr checks 3', 'echo hi', 'true', 'test -f x', 'set -e -o pipefail', 'set +u', 'OWNER=someone', 'export GH_HOST=example.com', 'GH_REPO=o/r gh pr view 1', 'cd sub', 'yokoten bot -- gh run view 1']) {
    assert.equal(post(`${reads} && gh pr comment 3 -F ${body}`), null, reads);
  }
  writeFileSync(body, 'Tested in QuietVale.\n');
  assert.equal(post(lead)?.id, 'private-mark');
  // A command that may write the file still stops it.
  writeFileSync(body, 'All clean.\n');
  for (const writes of [
    `echo QuietVale > ${body}`,
    '. ./x.sh',
    'source ~/.config/yokoten/x.sh',
    'eval x',
    'f() { :; }',
    'git diff',
    'git status',
    'git log -1',
    'gh api repos/o/r/pulls',
    'export EDITOR=x',
    'HOME=/x',
    'set -a',
    'git log -p',
    'git log --patch',
    'git log -u',
    'git log --textconv',
    'git log --ext-diff',
    'git log --output=x',
    'gh api -X POST repos/o/r/issues',
    'gh api repos/o/r/issues -f body=x',
    'gh pr checkout 3',
    'X=$(cp a b)',
    'yokoten bot -- gh pr merge 3',
    'printf x > out.md',
    'PATH=./bin; git status',
    'export GIT_EXTERNAL_DIFF=./x; git log',
    'NODE_OPTIONS=--require=./x.js node bin/yokoten.ts bot -- gh pr view 1',
  ]) {
    plainRefusal(`${writes}; gh pr comment 3 -F ${body}`);
  }
  writeFileSync(join(postDir, 'f.md'), 'clean\n');
  plainRefusal('echo QuietVale > f.md; gh issue comment 3 -F f.md');
  plainRefusal('. ./x.sh; gh issue comment 3 -F f.md');
});

test('TZ=UTC with a post is trusted: gh sends it as the Time-Zone header (#488)', () => {
  const body = join(postDir, 'tz-body.md');
  writeFileSync(body, 'All clean.\n');
  const bot = `node bin/yokoten.ts bot -- gh pr create --title t --body-file ${body}`;
  for (const command of [`TZ=UTC gh pr comment 3 -F ${body}`, `export TZ=UTC && gh pr comment 3 -F ${body}`, `export TZ=UTC; ${bot}`, `TZ=UTC ${bot} 2>&1 | tail -2`]) {
    assert.equal(post(command), null, command);
  }
  // Still checked: a mark in the file stops it, through either form.
  writeFileSync(body, 'Tested in QuietVale.\n');
  assert.equal(post(`TZ=UTC gh pr comment 3 -F ${body}`)?.id, 'private-mark');
  assert.equal(post(`export TZ=UTC && gh pr comment 3 -F ${body}`)?.id, 'private-mark');
  writeFileSync(body, 'All clean.\n');
  // Any other zone, a bare `export TZ`, or any other name is still refused.
  plainRefusal(`TZ=Asia/Tokyo gh pr comment 3 -F ${body}`);
  plainRefusal(`export TZ=Asia/Tokyo; gh pr comment 3 -F ${body}`);
  plainRefusal(`export TZ; gh pr comment 3 -F ${body}`);
  plainRefusal(`EDITOR=x gh pr comment 3 -F ${body}`);
  plainRefusal(`export EDITOR=x; gh pr comment 3 -F ${body}`);
  // The refusal names what to leave out.
  const other = post(`TZ=Asia/Tokyo gh pr comment 3 -F ${body}`);
  assert.ok(other?.what.includes('a variable other than GH_REPO, GH_HOST, NODE_USE_ENV_PROXY or TZ=UTC'), other?.what);
  const exported = post(`export EDITOR=x; gh pr comment 3 -F ${body}`);
  assert.ok(exported?.what.includes('an `export` of a name other than GH_REPO, GH_HOST, NODE_USE_ENV_PROXY or TZ=UTC'), exported?.what);
  // A project allow still applies after an inline TZ=UTC, as after NODE_USE_ENV_PROXY=1 (#498).
  const allowing = { ...DEFAULTS, privacy: { ...DEFAULTS.privacy, allow: ['QuietVale'] } };
  assert.equal(post('TZ=UTC gh issue create --title "check: fix a bug" --body "QuietVale ships"', allowing), null);
  assert.equal(post('TZ=Asia/Tokyo gh issue create --title "check: fix a bug" --body "QuietVale ships"', allowing)?.id, 'private-mark');
  rmSync(body);
});

test('a command beside gh is trusted only when it surely writes no file and runs nothing (#439)', () => {
  mkdirSync(join(postDir, 'sub'), { recursive: true });
  rmSync(join(postDir, 'sub', 'f.md'), { force: true });
  writeFileSync(join(postDir, 'f.md'), 'clean\n');
  for (const [name, command] of reviewCases2) {
    if (writesNothing.has(name)) assert.equal(post(command), null, name);
    else assert.ok(post(command) !== null, name);
  }
});

test('a `$` the shell fills in, a CR, --web or .. after a cd makes the line unsure (#439)', () => {
  for (const dir of ['sub', 'ev', 'lnk-target']) mkdirSync(join(postDir, dir), { recursive: true });
  writeFileSync(join(postDir, 'f.md'), 'clean\n');
  writeFileSync(join(postDir, 'ev', 'f.md'), 'QuietVale\n');
  rmSync(join(postDir, 'lnk'), { force: true });
  symlinkSync(join(postDir, 'ev'), join(postDir, 'lnk'));
  for (const command of reviewCases3) assert.ok(post(command) !== null, JSON.stringify(command));
  for (const command of writesNothing3) assert.equal(post(command), null, JSON.stringify(command));
  // A `$` inside single quotes is text, not a value the shell fills in.
  assert.equal(post("echo '$(cp ev/f.md f.md)' && gh issue comment 3 -F f.md"), null);
  assert.equal(post("cat > g.md <<'EOF' && gh issue comment 3 -F g.md\n$(cp ev/f.md f.md)\nEOF"), null);
});

test('scanning a line for values the shell fills in stays linear (#439)', () => {
  writeFileSync(join(postDir, 'f.md'), 'clean\n');
  assertLinear(
    'many quotes and words before gh',
    (n) => `${"echo 'a' \"b\" c d; ".repeat(n / 24)}gh issue comment 3 -F f.md`,
    (command) => assert.equal(post(command), null),
  );
  assertLinear(
    'an unclosed quote',
    (n) => `echo "${'x '.repeat(n / 2)}`,
    (command) => post(command),
  );
});

test('beside other commands, only one line of plain words is trusted (#439)', () => {
  mkdirSync(join(postDir, 'sub'), { recursive: true });
  rmSync(join(postDir, 'sub', 'f.md'), { force: true });
  writeFileSync(join(postDir, 'f.md'), 'clean\n');
  for (const command of reviewCases5) assert.ok(post(command) !== null, JSON.stringify(command));
  // gh posts ./f.md, since the cd never ran in this shell; the guard must not read sub/f.md.
  writeFileSync(join(postDir, 'f.md'), 'Seen in QuietVale.\n');
  writeFileSync(join(postDir, 'sub', 'f.md'), 'clean\n');
  for (const command of ['(cd sub) && gh issue comment 3 -F f.md', 'cd sub & gh issue comment 3 -F f.md', 'cd sub | true; gh issue comment 3 -F f.md']) {
    assert.notEqual(post(command), null, command);
  }
  writeFileSync(join(postDir, 'f.md'), 'clean\n');
  rmSync(join(postDir, 'sub', 'f.md'), { force: true });
  // Plain quotes are fine: a title with spaces, and the lead's own command.
  const body = join(postDir, 'lead-body.md');
  writeFileSync(body, 'All clean.\n');
  for (const command of [
    `cd ${postDir} && export NODE_USE_ENV_PROXY=1 GH_REPO=o/r; node bin/yokoten.ts bot -- gh pr create --title t --body-file ${body}`,
    `cd ${postDir} && gh pr create --title "fix: a plain title" --body-file ${body}`,
    `echo 'any $ text (here)'; gh pr create --title 'a, b' --body-file ${body}`,
    'cd ~ && gh issue comment 3 -F ~/f.md',
    'gh pr create --title t --body-file - < f.md',
  ]) assert.equal(post(command), null, command);
});

test('a \\ and a line end in a heredoc word is refused, quoted or not (#439)', () => {
  writeFileSync(join(postDir, 'body.md'), `write to ${email}\n`);
  // bash ends both bodies at EF, then runs gh.
  for (const command of [
    'cat <<"E\\\nF"\nbody\nEF\ngh issue create --title t -F body.md',
    'cat <<E\\\nF\nbody\nEF\ngh issue create --title t -F body.md',
    "cat <<'E\\\nF'\nbody\nEF\ngh issue create --title t -F body.md",
  ]) assert.equal(post(command)?.id, 'unreadable-command', JSON.stringify(command));
  rmSync(join(postDir, 'body.md'));
});

test('a ~ word after -F or cd is trusted only as ~ or ~/, unquoted (#439)', () => {
  const secret = `write to ${email}\n`;
  for (const dir of ['~', join('sub', '~-')]) mkdirSync(join(postDir, dir), { recursive: true });
  // bash reads the file with the secret; the guard, reading $HOME or the cd folder, would find a clean one.
  writeFileSync(join(postDir, 'body.md'), 'clean\n');
  writeFileSync(join(postDir, '~', 'body.md'), secret);
  writeFileSync(join(postDir, 'sub', '~-', 'body.md'), secret);
  const refused = (commands: string[]) => {
    for (const command of commands) assert.notEqual(post(command), null, JSON.stringify(command));
  };
  refused([
    "gh issue create --title t -F '~/body.md'",
    'gh issue create --title t -F "~/body.md"',
    "gh issue create --title t -F ~'/body.md'",
    "cd sub && gh issue create --title t -F '~-/body.md'",
    'gh issue create --title t -F ~+/body.md',
    'gh issue create --title t -F ~root/body.md',
    'gh issue create --title t -F ~1/body.md',
    "cd '~' && gh issue create --title t -F body.md",
  ]);
  // `~-` is the folder before the cd: bash reads ./body.md, not sub/~-/body.md.
  writeFileSync(join(postDir, 'body.md'), secret);
  writeFileSync(join(postDir, 'sub', '~-', 'body.md'), 'clean\n');
  refused(['cd sub; gh issue create --title t -F ~-/body.md']);
  // Control: a plain ~ and ~/ are $HOME, and the file there is read.
  assert.equal(post('cd ~ && gh issue create --title t -F ~/body.md')?.id, 'email');
  writeFileSync(join(postDir, 'body.md'), 'clean\n');
  assert.equal(post('cd ~ && gh issue create --title t -F ~/body.md'), null);
  for (const dir of ['~', 'sub', 'body.md']) rmSync(join(postDir, dir), { recursive: true, force: true });
});

test('inside "...", only $, backticks, \\ and ! make the line unsure (#439)', () => {
  const literal = [
    'gh issue create --title "Fix #12" -F body.md',
    'echo "a#b"; gh issue create --title t -F body.md',
    'echo "it\'s"; gh issue create --title t -F body.md',
    'echo hi; gh issue create --title "a (b) <c> {d} | e & f * ? [g] ~h" -F body.md',
  ];
  writeFileSync(join(postDir, 'body.md'), 'clean\n');
  for (const command of literal) assert.equal(post(command), null, JSON.stringify(command));
  // The file is read: a mark in it is found.
  writeFileSync(join(postDir, 'body.md'), 'Seen in QuietVale.\n');
  for (const command of literal) assert.equal(post(command)?.id, 'private-mark', JSON.stringify(command));
  writeFileSync(join(postDir, 'body.md'), 'clean\n');
  for (const command of [
    'echo "a$b"; gh issue create --title t -F body.md',
    'echo "a`b`"; gh issue create --title t -F body.md',
    'echo "a\\b"; gh issue create --title t -F body.md',
    'echo "a!b"; gh issue create --title t -F body.md',
    'true 2>/dev/null; gh issue create --title t -F body.md',
  ]) assert.equal(post(command)?.id, 'unreadable-command', JSON.stringify(command));
  rmSync(join(postDir, 'body.md'));
});

test('a pipe at the end into tail, head, grep, sed s/// and the like still reads the body file (#498)', () => {
  const body = join(postDir, 'piped.md');
  writeFileSync(body, 'All clean.\n');
  const bot = `node bin/yokoten.ts bot -- gh pr create --title "fix: a plain title" --body-file ${body}`;
  const passes = [
    `${bot} 2>&1 | tail -2`,
    `${bot} | tail -2`,
    `${bot} | sed "s/x/y/g"`,
    `${bot} 2>&1 | sed "s/someone/<owner>/g" | tail -2`,
    `${bot} | sed -n -e 's|a|b|gp' -e 's/c/d/'`,
    `${bot} | grep -v x | head -n 5 | cut -c1-80 | wc -l`,
    `${bot} | sort -rk2,2 | uniq -c | tr a-z A-Z`,
    `${bot} 2>&1`,
    `cd ${postDir} && ${bot} | tail -2`,
  ];
  for (const command of passes) assert.equal(post(command), null, command);
  // The file is still read: a mark in it is found through the pipe.
  writeFileSync(body, 'Seen in QuietVale.\n');
  for (const command of passes) assert.equal(post(command)?.id, 'private-mark', command);
  rmSync(body);
});

test('a pipe or a command that may change the body file is refused, by name (#498)', () => {
  const body = join(postDir, 'piped.md');
  writeFileSync(body, 'All clean.\n');
  mkdirSync(join(postDir, 'sub'), { recursive: true });
  const bot = `node bin/yokoten.ts bot -- gh pr create --title t --body-file ${body}`;
  const refused: [string, string][] = [
    [`${bot} | tee ${body}`, 'a pipe to `tee`'],
    [`${bot} | sed -i s/x/y/ ${body}`, 'a `sed` with `-i`'],
    [`${bot} | sed --in-place s/x/y/ ${body}`, 'a `sed` with `-i`'],
    [`${bot} | sed 's/x/y/w ${body}'`, 'a `sed` with `-i`'],
    [`${bot} | sed 's/x/y/e'`, 'a `sed` with `-i`'],
    [`${bot} | sed -f script.sed`, 'a `sed` with `-i`'],
    [`${bot} | sort -o ${body}`, 'a `sort` with an option'],
    [`${bot} | sort "$X"`, 'a `sort` with an option'],
    [`${bot} | uniq - ${body}`, 'a `uniq` with a second file'],
    [`${bot} | tail -2 > ${body}`, 'a pipe to `tail` that does not end the line'],
    [`${bot} | tail -2; cd /tmp`, 'a pipe to `tail` that does not end the line'],
    [`${bot} | tail -2 | grep "$(id)"`, 'a pipe to `tail` that does not end the line'],
    [`${bot} | grep "\${X}"`, 'a pipe to `grep` that does not end the line'],
    [`${bot} | xargs tail`, 'a pipe to `xargs`'],
    [`${bot} | (cat > ${body})`, 'a pipe'],
    [`${bot} |& tail -2`, 'a pipe'],
    [`${bot} || tail -2`, 'a `||`'],
    [`echo x | tail -2; ${bot}`, 'a pipe to `tail` that does not end the line'],
    [`cd sub && gh pr create --title t --body-file ../piped.md | tail -2`, 'a `cd` before a path with `..`'],
    [`cd -; ${bot}`, 'a `cd` the guard can'],
    [`mv a.md ${body}; ${bot} | tail -2`, 'a `mv`'],
    [`export A=1 B=2; ${bot}`, 'an `export` of a name other than GH_REPO'],
    [`OWNER=$(gh pr view 3 -q .x); ${bot}`, 'a command substitution `$(…)`'],
    [`[ -n x ] || exit 1; ${bot}`, 'a `[ … ]` test'],
    [`${bot} > ${body}`, 'a redirect `>`'],
    [`${bot} 2>&1 > ${body}`, 'a redirect `>`'],
    [`X=1 ${bot}`, 'a variable other than GH_REPO'],
  ];
  for (const [command, saw] of refused) {
    const f = post(command);
    assert.equal(f?.id, 'unreadable-command', command);
    assert.ok(f?.what.includes(`and ${saw}`), `${command}: ${f?.what}`);
    assert.ok(f?.fix.startsWith(`leave out ${saw}`), `${command}: ${f?.fix}`);
    assert.match(f?.fix ?? '', /write the file in one command, then post it in the next/);
  }
  rmSync(body);
});

test('a `$` anywhere in a sed after the post is refused: bash fills it in before sed reads the script (#498)', () => {
  const body = join(postDir, 'piped.md');
  writeFileSync(body, 'All clean.\n');
  const bot = `node bin/yokoten.ts bot -- gh pr create --title t --body-file ${body}`;
  for (const command of [
    `${bot} 2>&1 | sed "s/$OWNER/<owner>/g" | tail -2`,
    `${bot} | sed "s/x/$NAME/"`,
    `${bot} | sed -e "s/x/y/$FLAGS"`,
    `${bot} | sed "$S"`,
    `${bot} | sed s/x/y/ "$F"`,
    `${bot} | sed 's/x$/y/'`,
    `${bot} | sed "s/$(id)/x/"`,
    `${bot} | sed "s/\${X}/x/"`,
  ]) {
    const f = post(command);
    assert.equal(f?.id, 'unreadable-command', command);
    assert.ok(f?.what.includes('and a `$` value in a `sed` command in this command'), `${command}: ${f?.what}`);
    assert.equal(f?.fix, 'type the value into the sed script in place of the `$`, or leave out the pipe, or write the file in one command, then post it in the next, and give its full path');
  }
  // grep may take a value: it writes no file whatever the value holds.
  assert.equal(post(`${bot} | grep -v "$OWNER"`), null);
  rmSync(body);
});

test('a refusal never names a program that holds a private mark (#498)', () => {
  const body = join(postDir, 'piped.md');
  writeFileSync(body, 'All clean.\n');
  const bot = `node bin/yokoten.ts bot -- gh pr create --title t --body-file ${body}`;
  const named = [
    [`${bot} | quietvale-tool x`, 'a pipe'],
    [`${bot} | /opt/QuietVale/bin/send`, 'a pipe to `send`'],
    [`quietvale-tool x; ${bot}`, 'a command'],
    [`QuietVale x; ${bot}`, 'a command'],
  ];
  for (const [command, saw] of named) {
    const f = post(command);
    assert.equal(f?.id, 'unreadable-command', command);
    assert.ok(f?.what.includes(`and ${saw} in this command`), `${command}: ${f?.what}`);
    assert.ok(!/quietvale/i.test(formatFinding(f)), `${command}: the mark is never printed`);
  }
  // Control: a program with no mark in it is named.
  assert.ok(post(`${bot} | tee x`)?.what.includes('a pipe to `tee`'));
  assert.ok(post(`othertool x; ${bot}`)?.what.includes('a `othertool`'));
  rmSync(body);
});

test('a ~/ path to yokoten and the allowed variables before it still read the body file (#498)', () => {
  const body = join(postDir, 'c-505.md');
  writeFileSync(body, 'All clean.\n');
  const comment = `bot -- gh issue comment 505 --body-file ${body}`;
  const passes = [
    `NODE_USE_ENV_PROXY=1 GH_REPO=o/r node ~/x/yokoten/bin/yokoten.ts ${comment}`,
    `node ~/x/yokoten/bin/yokoten.ts ${comment}`,
    `node ~/yokoten.mjs ${comment} | tail -2`,
    `~/x/bin/yokoten ${comment}`,
    `NODE_USE_ENV_PROXY=1 GH_REPO=o/r node bin/yokoten.ts ${comment}`,
    `node /opt/x/bin/yokoten.ts ${comment}`,
  ];
  for (const command of passes) assert.equal(post(command), null, command);
  writeFileSync(body, 'Seen in QuietVale.\n');
  for (const command of passes) assert.equal(post(command)?.id, 'private-mark', command);
  writeFileSync(body, 'All clean.\n');
  // A ~ elsewhere, a quoted ~, a ~ that is not $HOME, or another program stays refused.
  for (const command of [
    `node ~/x/bin/other.ts ${comment}`,
    `node '~/x/bin/yokoten.ts' ${comment}`,
    `node ~root/bin/yokoten.ts ${comment}`,
    `node ~/x/bin/yokoten.ts ~/y ${comment}`,
    `echo ~/x/bin/yokoten.ts bot -- x; gh issue comment 505 --body-file ${body}`,
  ]) assert.equal(post(command)?.id, 'unreadable-command', command);
  // `~root` is another user's home: the guard can't tell which yokoten runs there, so it says so.
  const root = post(`node ~root/bin/yokoten.ts ${comment}`);
  assert.ok(root?.what.includes('and a `~` that may not be your home folder in this command'), root?.what);
  // A variable outside GH_REPO, GH_HOST and NODE_USE_ENV_PROXY reaches node and gh: refused, by name.
  const other = post(`A=1 node bin/yokoten.ts ${comment}`);
  assert.ok(other?.what.includes('a variable other than GH_REPO'), other?.what);
  rmSync(body);
});

test('a lone post trusts the same yokoten paths as the body-file path (#506)', () => {
  const allowing = { ...DEFAULTS, privacy: { ...DEFAULTS.privacy, allow: ['QuietVale'] } };
  const comment = 'bot -- gh issue create --title "check: fix a bug" --body "QuietVale ships"';
  for (const program of ['yokoten', 'node bin/yokoten.ts', 'node ./bin/yokoten.mjs', 'node ~/x/bin/yokoten.ts', '~/x/bin/yokoten', 'node ~/yokoten.mjs', 'node /opt/x/bin/yokoten.ts']) {
    assert.ok(lonePost(`${program} ${comment}`), program);
    assert.equal(post(`${program} ${comment}`, allowing), null, program);
  }
  // `~other`, `~+` and `~-` are not your home: no lone post, so no allow.
  for (const program of ['node ~other/bin/yokoten.ts', '~other/x/yokoten', 'node ~+/bin/yokoten.ts', 'node ~-/bin/yokoten.ts', 'node ~/x/bin/yokoten.js']) {
    assert.equal(lonePost(`${program} ${comment}`), null, program);
    assert.equal(post(`${program} ${comment}`, allowing)?.id, 'private-mark', program);
  }
});

test('reading a pipe at the end stays linear (#498)', () => {
  const body = join(postDir, 'piped.md');
  writeFileSync(body, 'All clean.\n');
  assertLinear(
    'many read-only pipes',
    (n) => `gh pr create --title t --body-file ${body}${' | tail -2'.repeat(n / 10)}`,
    (command) => assert.equal(post(command), null),
  );
  assertLinear(
    'blanks before 2>&1',
    (n) => `gh pr create --title t --body-file ${body}${' '.repeat(n)}2>&1${' '.repeat(n)}`,
    (command) => assert.equal(post(command), null),
  );
  rmSync(body);
});

test('lonePost: linear on long input (#447)', () => {
  const inputs: [string, (n: number) => string][] = [
    ['quotes', (n) => `gh issue create --body "${'a'.repeat(n)}`],
    ['escapes', (n) => `gh issue create ${'\\'.repeat(n)}`],
    ['heredoc lines', (n) => `gh issue create --body-file - <<'EOF'\n${'x\n'.repeat(n / 2)}`],
    ['a long cd', (n) => `cd ${'a'.repeat(n)} gh`],
    ['a long bot path', (n) => `${'a/'.repeat(n / 2)}yokoten bot -- x`],
  ];
  for (const [name, make] of inputs) assertLinear(name, make, (text) => lonePost(text));
});

test('lonePost: refuses what bash reads differently from the guard (#447)', () => {
  // ANSI-C quoting: bash reads $'\'' as one quote, so `echo PWNED` runs.
  assert.equal(lonePost(`gh issue comment 1 -b $'\\'' ; echo PWNED ; echo '`), null, "$'…'");
  assert.equal(lonePost('gh issue comment 1 -b $"x"'), null, '$"…"');
  // A redirect writes a file.
  assert.equal(lonePost('gh issue comment 1 -b hi > ~/.config/gh/hosts.yml'), null, '>');
  for (const redirect of ['>> f', '>| f', '&> f', '2> f']) assert.equal(lonePost(`gh issue comment 1 -b hi ${redirect}`), null, redirect);
  // The plain forms stay allowed: quoted text, a quoted > and a quoted heredoc.
  assert.deepEqual(lonePost('gh issue comment 1 -b "a > b; c" --title \'x | y $HOME\''), { cd: false });
  assert.deepEqual(lonePost("gh issue create --title x --body-file - <<'EOF'\na > b\nEOF"), { cd: false });
  assert.deepEqual(lonePost('gh issue comment 1 -b "hello world"'), { cd: false });
});

test('a refusal folds the marks before it names a program (#507)', () => {
  const dir = makeTempDir('yokoten-wide-marks-');
  const marks = join(dir, 'private-marks');
  writeFileSync(marks, `${WIDE('quietvale')}\n`);
  const body = join(dir, 'body.md');
  writeFileSync(body, 'All clean.\n');
  const bot = `node bin/yokoten.ts bot -- gh pr create --title t --body-file ${body}`;
  const run = (command: string) => checkCommand(command, { env: { HOME: dir, YOKOTEN_PRIVATE_MARKS: marks }, config: DEFAULTS, cwd: dir });
  assert.ok(run(`${bot} | quietvale-tool x`)?.what.includes('and a pipe in this command'));
  assert.ok(run(`quietvale-tool x; ${bot}`)?.what.includes('and a command in this command'));
  rmSync(dir, { recursive: true });
});

test('the bot program is never a variable: no `=` or `,` in its path (#506)', () => {
  for (const program of ['GH_REPO=evil/yokoten', 'LD_PRELOAD=x/yokoten', 'PATH=/tmp/x/yokoten', 'a,b/yokoten']) {
    assert.equal(isBotProgram(program), false, program);
    const command = `${program} bot -- gh issue create --title t --body "QuietVale ships"`;
    assert.equal(lonePost(command), null, program);
  }
});

