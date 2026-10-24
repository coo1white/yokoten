import '../../../repo/home.ts';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { email, post, postDir, token } from '../../../repo/helpers.ts';

writeFileSync(join(postDir, 'body.md'), 'Summary\n\nTested in QuietVale.\n');

test('the other text options and their forms are read', () => {
  for (const command of [
    `gh pr create --title "feat: thank ${email}" --body ok`,
    `gh pr comment 3 -b "${email}"`,
    `gh pr comment 3 -b"${email}"`,
    `gh issue edit 3 --body="${email}"`,
    `gh pr review 3 --comment --body "${email}"`,
    `gh -R o/r issue comment 3 --body "${email}"`,
    `nice gh issue create -t "check: add x" -b "${email}"`,
  ]) {
    assert.equal(post(command)?.id, 'email', command);
  }
});

test('a joined short-option cluster in gh api is refused, so a hidden field is not posted (#650)', () => {
  assert.equal(post('gh api -if body=x repos/o/r/issues/1/comments')?.id, 'run-remove');
  assert.equal(post(`gh api -iF body="${email}" repos/o/r/issues`)?.id, 'run-remove');
  assert.equal(post(`gh api -iXPOST repos/o/r/issues -f body="${email}"`)?.id, 'run-remove');
});

test('gh after a launcher value is still the program, and a jq value is not a method (#650)', () => {
  assert.equal(post(`env -u gh gh issue create --title t --body "${email}"`)?.id, 'email');
  assert.equal(post(`sudo -u gh gh issue comment 3 -b "${email}"`)?.id, 'email');
  assert.equal(post(`xargs -a gh gh issue comment 3 --body "${email}"`)?.id, 'email');
  assert.equal(post(`gh api -X POST -q -XGET repos/o/r/issues -f body="${email}"`)?.id, 'email');
  assert.equal(post(`gh api -X GET -q -XPOST repos/o/r/issues -f body="${email}"`), null);
});

test('gh api fields and input files are read', () => {
  assert.equal(post(`gh api repos/o/r/issues/1/comments -f body="token ${token}"`)?.id, 'secret');
  assert.equal(post(`gh api repos/o/r/issues -F title="check: add x" -F body="${email}"`)?.id, 'email');
  assert.equal(post(`gh api repos/o/r/issues --raw-field=body=${email}`)?.id, 'email');
  writeFileSync(join(postDir, 'payload.json'), JSON.stringify({ body: email }));
  assert.equal(post('gh api repos/o/r/issues --input payload.json')?.id, 'email');
  assert.equal(post('gh api repos/o/r/issues -F body=@body.md')?.id, 'private-mark');
  assert.equal(post('gh api repos/o/r/issues -f body="all clean"'), null);
});

test('yokoten bot -- gh is read the same way', () => {
  assert.equal(post(`yokoten bot -- gh pr create --title "feat: add t" --body "${email}"`)?.id, 'email');
  assert.equal(post(`node bin/yokoten.ts bot -- gh issue comment 3 --body "${email}"`)?.id, 'email');
  assert.equal(post('yokoten bot -- gh pr create --title "feat: add t" --body "clean"'), null);
});

test('an inline heredoc body is read, with its line', () => {
  const f = post(`gh pr create --title "feat: add t" --body "$(cat <<'EOF'\nSummary\n\nmail ${email}\nEOF\n)"`);
  assert.equal(f?.id, 'email');
  assert.match(f?.what ?? '', /line 4/);
  // A body from stdin: the heredoc fed to it is read.
  assert.equal(post(`gh pr create --title "feat: add t" --body-file - <<'EOF'\nmail ${email}\nEOF`)?.id, 'email');
  assert.equal(post(`gh pr create --title "feat: add t" --body-file - <<'EOF'\nall clean\nEOF`), null);
});

test('API reads pass; API writes and GraphQL mutations are read (#391 review)', () => {
  assert.equal(post(`gh api graphql -f query='query { search(query: "${email}") { issueCount } }'`), null);
  assert.equal(post(`gh api graphql -f query='mutation { addComment(input: {body: "${email}"}) { clientMutationId } }'`)?.id, 'email');
  assert.equal(post(`gh api search/issues -f q="${email}"`), null);
  assert.equal(post(`gh api -X GET repos/o/r/issues -f creator="${email}"`), null);
  assert.equal(post(`gh api -X POST repos/o/r/labels -f description="${email}"`)?.id, 'email');
  assert.equal(post(`gh api --method=PATCH repos/o/r/issues/1 -f body="${email}"`)?.id, 'email');
  assert.equal(post(`gh api repos/o/r/issues/1/comments -F body=@- <<'EOF'\nmail ${email}\nEOF`)?.id, 'email');
});

test('checkPost: an option value that looks like an option hides no body (#659)', () => {
  const comments = 'gh api repos/o/r/issues/1/comments';
  for (const option of ['-H', '--header', '-q', '--jq', '-t', '--template', '-p', '--preview', '--hostname', '--cache']) {
    assert.equal(post(`${comments} ${option} -f -f body="${email}"`)?.id, 'email', `${option} -f`);
    assert.equal(post(`${comments} ${option} -F -F body="${email}"`)?.id, 'email', `${option} -F`);
    assert.equal(post(`${comments} ${option} --raw-field --raw-field body="${email}"`)?.id, 'email', `${option} --raw-field`);
  }
  // A fake method after a real one, or a method read from another option's value.
  assert.equal(post(`gh api -X POST repos/o/r/labels -H -X -H GET -f description="${email}"`)?.id, 'email');
  assert.equal(post(`${comments} -H -X -f body="${email}"`)?.id, 'email');
  // gh 2.103 takes `-XGET` here as the jq filter, the template or the host, and sends a POST.
  for (const fake of ['-q -XGET', '--jq -XGET', '-t -XGET', '--template --method=GET', '-p -XGET', '-H --method=GET', '--hostname -XGET', '--cache -X GET']) {
    assert.equal(post(`${comments} ${fake} -f body="${email}"`)?.id, 'email', fake);
  }
  // Fields with no sure method are a POST to any path, a label or a git blob too.
  assert.equal(post(`gh api repos/o/r/labels -H -XGET -f description="${email}"`)?.id, 'email');
  assert.equal(post(`gh api repos/o/r/git/blobs -f content="${email}"`)?.id, 'email');
  assert.equal(post(`gh api search/issues -q -XGET -f q="${email}"`), null, 'a search reads');
  // A method after a value that is no option, or after a switch, is sure: the call reads.
  for (const sure of ['-X GET', '-H "Accept: x" -X GET', '--paginate -X GET', '-i --method=GET']) {
    assert.equal(post(`gh api ${sure} repos/o/r/issues -f creator="${email}"`), null, sure);
  }
  // A mutation stays one when a fake query follows.
  assert.equal(post(`gh api graphql -f query='mutation { addComment(input: {body: "${email}"}) { clientMutationId } }' -H -f -f query=x`)?.id, 'email');
  // The other gh posts: a text option's value read as an option.
  assert.equal(post(`gh issue comment 3 --body --body "${email}"`)?.id, 'email');
  assert.equal(post(`gh pr create --title "feat: add t" --label --body --body "${email}"`)?.id, 'email');
  // Reads and clean posts still pass.
  assert.equal(post(`gh api -X GET repos/o/r/issues -H "Accept: x" -f creator="${email}"`), null);
  assert.equal(post(`${comments} -H -f -f body="all clean"`), null);
});

test('a stdin body: only the heredoc is read, not the rest of the command (#391 review)', () => {
  assert.equal(post(`cd /srv/quietvale-site && gh pr create --title "feat: add t" --body-file - <<'EOF'\nall clean\nEOF`), null);
  assert.equal(post(`gh pr comment 3 --body-file - <<'EOF'\nfrom QuietVale\nEOF`)?.id, 'private-mark');
  assert.equal(post('gh pr comment 3 --body-file -'), null, 'stdin from another program is not seen');
});

test('merge, close and review text is read (#391 review)', () => {
  for (const command of [
    `gh pr merge 3 --squash --subject "feat: thank ${email}"`,
    `gh pr merge 3 --body "${email}"`,
    `gh issue close 3 --comment "${email}"`,
    `gh pr close 3 -c "${email}"`,
    `gh pr review 3 --approve --body "${email}"`,
  ]) {
    assert.equal(post(command)?.id, 'email', command);
  }
});

test('a < file or a <<< here-string feeding stdin is read (#391 review)', () => {
  assert.equal(post('gh pr create --title "feat: add t" --body-file - < body.md')?.id, 'private-mark');
  assert.equal(post('gh pr create --title "feat: add t" --body-file - <body.md')?.id, 'private-mark');
  assert.equal(post(`gh issue comment 3 -F - <<< "mail ${email}"`)?.id, 'email');
  assert.equal(post('gh issue comment 3 --body "a < b.md"'), null, 'a quoted < is text');
});

