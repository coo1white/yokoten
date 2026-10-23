// Writes the files a release installs from (#435): the Homebrew formula for
// yokoten-labs/homebrew-tap and the Scoop manifest for yokoten-labs/scoop-bucket.
// Both carry the version and the sha256 of the npm tarball, so a release runs this
// script on the tarball it is about to publish, and nobody edits a checksum by hand.
//
//   node scripts/packaging.ts --tarball yokoten-0.1.0.tgz
//   node scripts/packaging.ts --sha256 <64 lowercase hex> [--out <dir>]
//
// The output has one folder per repo, under --out (default: packaging/out):
//   homebrew-tap/Formula/yokoten.rb
//   scoop-bucket/bucket/yokoten.json
// Copy each folder into its repo, or let the release workflow do it.

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findReleaseProblems, sha256OfFile, writeReleaseFiles } from '../src/run/packaging.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const USAGE = 'usage: node scripts/packaging.ts (--tarball <packed .tgz> | --sha256 <64 hex>) [--out <dir>]';

/** Run the command; returns the exit code. */
export function main(args: string[]): number {
  let sha256: string | undefined;
  let out = join(ROOT, 'packaging', 'out');
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === '--help' || arg === '-h') {
      console.log(USAGE);
      return 0;
    }
    if (arg !== '--tarball' && arg !== '--sha256' && arg !== '--out') {
      console.error(`packaging: unknown option ${arg}\n${USAGE}`);
      return 1;
    }
    const value = args[index + 1];
    if (value === undefined || value.startsWith('--')) {
      console.error(`packaging: ${arg} needs a value\n${USAGE}`);
      return 1;
    }
    index++;
    if (arg === '--out') out = value;
    else if (arg === '--sha256') sha256 = value;
    else {
      if (!existsSync(value)) {
        console.error(`packaging: ${value} is not there; run \`npm pack\` first`);
        return 1;
      }
      sha256 = sha256OfFile(value);
    }
  }
  if (sha256 === undefined) {
    console.error(`packaging: pass the packed tarball or its sha256\n${USAGE}`);
    return 1;
  }
  const { version } = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { version: string };
  const problems = findReleaseProblems({ version, sha256 });
  if (problems.length) {
    console.error(['packaging: nothing was written:', ...problems.map((problem) => `- ${problem}`)].join('\n'));
    return 1;
  }
  const files = writeReleaseFiles({ version, sha256 }, out);
  console.log([`packaging: yokoten ${version}, sha256 ${sha256}`, ...files.map((file) => `wrote ${join(out, file.path)}`)].join('\n'));
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) process.exitCode = main(process.argv.slice(2));
