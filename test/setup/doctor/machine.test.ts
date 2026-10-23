// Tests for src/setup/doctor/machine.ts.

import '../../repo/home.ts';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { makeSandbox } from '../../repo/helpers.ts';
import { DEFAULTS } from '../../../src/rules/config.ts';
import { machineStateFile } from '../../../src/setup/install.ts';
import { agentTempDirCheck, nodeSecurityCheck, diskSpaceChecks, doctor, findDriveMount, isLowOnSpace, isWsl, leftoverControl, leftoverTempCheck, type MachineProbe, machineControl, parseLxss, quoteForShell, REAL_MACHINE, readHostDisk, saveHostCache, selfTest } from '../../../src/setup/doctor/index.ts';
import { fakeMachine, GB, makeTempDir, MOUNTS, NOW, WSL } from '../../repo/helpers.ts';

// Machine notes (record 0012): a fake machine, so no test reads the real disk or runs reg.exe.
const LXSS = [
  'HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Lxss',
  '    DefaultDistribution    REG_SZ    {0000}',
  '',
  'HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Lxss\\{0000}',
  '    State    REG_DWORD    0x1',
  '    DistributionName    REG_SZ    <distro>',
  '    Version    REG_DWORD    0x2',
  '    BasePath    REG_SZ    \\\\?\\D:\\WSL\\<distro>',
  '',
  'HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Lxss\\{1111}',
  '    DistributionName    REG_SZ    <other>',
  '    Version    REG_DWORD    0x1',
  '    BasePath    REG_SZ    C:\\WSL\\<other>',
  '',
  'HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Lxss\\{2222}',
  '    DistributionName    REG_SZ    <shared>',
  '    BasePath    REG_SZ    \\\\fileserver\\share\\<shared>',
  '',
].join('\r\n');
/** The names of the checks, and whether each is ok. */
const marksOf = (checks: { name: string; ok: boolean }[]) => checks.map((c) => [c.name, c.ok]);
test('machine: a disk is low below 20 GB when that is also under 10%; YOKOTEN_MIN_FREE_GB is the one limit when set', () => {
  assert.ok(isLowOnSpace({ free: 0, size: 250 * GB }, {}), 'nothing free on a 250 GB drive');
  assert.ok(isLowOnSpace({ free: 10 * GB, size: 250 * GB }, {}));
  assert.ok(!isLowOnSpace({ free: 150 * GB, size: 2048 * GB }, {}), '150 GB on a 2 TB drive is room enough');
  assert.ok(!isLowOnSpace({ free: 15 * GB, size: 64 * GB }, {}), 'a small disk with a quarter free');
  assert.ok(isLowOnSpace({ free: 40 * GB, size: 2048 * GB }, { YOKOTEN_MIN_FREE_GB: '50' }));
  assert.ok(!isLowOnSpace({ free: 0, size: 250 * GB }, { YOKOTEN_MIN_FREE_GB: '0' }), '0 turns it off');
  assert.ok(isLowOnSpace({ free: 0, size: 250 * GB }, { YOKOTEN_MIN_FREE_GB: 'lots' }), 'a value that is not a number keeps the default');
});

test('machine: the registry and the mounts give the Windows drive of a distro', () => {
  assert.deepEqual(parseLxss(LXSS), [
    { name: '<distro>', basePath: '\\\\?\\D:\\WSL\\<distro>', version: 2 },
    { name: '<other>', basePath: 'C:\\WSL\\<other>', version: 1 },
    { name: '<shared>', basePath: '\\\\fileserver\\share\\<shared>', version: 2 },
  ]);
  assert.equal(findDriveMount('d', MOUNTS), '/mnt/d');
  assert.equal(findDriveMount('E', MOUNTS), null, 'never a guess: /mnt/e would be the Linux disk');
  assert.equal(findDriveMount('C', 'C:\\134 /mnt/my\\040drive 9p rw 0 0\n'), '/mnt/my drive');
});

test('machine: WSL is found by WSL_DISTRO_NAME or by the interop file alone', () => {
  assert.ok(isWsl({ WSL_DISTRO_NAME: '<distro>' }, fakeMachine(GB)));
  assert.ok(isWsl({}, fakeMachine(GB, { files: new Map([['/proc/sys/fs/binfmt_misc/WSLInterop', 'enabled\n']]) })));
  assert.ok(!isWsl({}, fakeMachine(GB)));
});

test('machine: reading the Windows drive in WSL, and each way it fails, never a crash', () => {
  const read = (machine: MachineProbe, env: Record<string, string> = WSL) => readHostDisk(env, machine);
  const asked: string[] = [];
  const space = (path: string) => {
    asked.push(path);
    return { free: GB, size: 250 * GB };
  };
  assert.deepEqual(read(fakeMachine(0, { programs: { 'reg.exe': LXSS }, readDiskSpace: space })), { space: { free: GB, size: 250 * GB }, distro: '<distro>', version: 2 });
  assert.deepEqual(asked, ['/mnt/d'], 'the drive that holds the disk file, not the Linux disk');
  // reg.exe not on the PATH: the copy on the system drive.
  const ran: string[] = [];
  assert.ok('space' in read(fakeMachine(0, { ran, programs: { '/mnt/c/Windows/System32/reg.exe': LXSS } })));
  assert.deepEqual(ran, ['reg.exe', '/mnt/c/Windows/System32/reg.exe']);
  const timedOut = fakeMachine(0, {
    runProgram: () => {
      throw Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' });
    },
  });
  assert.deepEqual(read(timedOut), { unread: 'reg.exe failed or took too long' });
  assert.deepEqual(read(fakeMachine(0)), { unread: 'reg.exe is not on the PATH' });
  assert.deepEqual(read(fakeMachine(0), {}), { unread: 'WSL_DISTRO_NAME is not set' });
  const registry = { programs: { 'reg.exe': LXSS } };
  assert.deepEqual(read(fakeMachine(0, registry), { WSL_DISTRO_NAME: '<gone>' }), { unread: 'the registry does not list this distro' });
  assert.deepEqual(read(fakeMachine(0, registry), { WSL_DISTRO_NAME: '<shared>' }), { unread: 'its disk file is not on a drive letter' }, 'a UNC path');
  assert.deepEqual(read(fakeMachine(0, { ...registry, readText: () => 'none / ext4 rw 0 0\n' })), { unread: 'drive D: is not mounted in Linux' });
  const broken = () => {
    throw new Error('statfs failed');
  };
  assert.deepEqual(read(fakeMachine(0, { ...registry, readDiskSpace: broken })), { unread: "can't read drive D:" }, 'the mounted drive');
});

test('machine: full doctor keeps the Windows drive reading, and a session repeats it without running a program', () => {
  const files = new Map<string, string>();
  const full = diskSpaceChecks('/repo', WSL, fakeMachine(0, { files, programs: { 'reg.exe': LXSS } }), false);
  assert.deepEqual(marksOf(full), [['disk-space', false], ['host-disk', false]]);
  const host = full[1].finding;
  assert.equal(host.what, 'the Windows drive that holds this Linux disk has 0.0 GB free of 250 GB');
  assert.match(host.fix, /Back up your work to another drive first\. Then free space on the Windows drive, or shrink or move the disk file: https:\/\/learn\.microsoft\.com\/windows\/wsl\/disk-space$/);
  assert.doesNotMatch(host.fix, /sparse|allow-unsafe/, 'never the flag WSL marks unsafe');
  assert.deepEqual(JSON.parse(files.get(machineStateFile(WSL)) ?? '{}').hostDisk, { free: 0, size: 250 * GB, readAt: NOW.toISOString(), distro: '<distro>', version: 2 });
  // A session: no program runs, and the kept reading is repeated with its time.
  const ran: string[] = [];
  const session = (machine: MachineProbe) => diskSpaceChecks('/repo', WSL, machine, true);
  const later = session(fakeMachine(100 * GB, { ran, files, now: () => new Date('2026-10-26T08:30:00Z') }));
  assert.deepEqual(ran, []);
  assert.deepEqual(marksOf(later), [['disk-space', true], ['host-disk', false]]);
  assert.match(later[1].finding.what, /\(read 2026-10-20 08:30 UTC\) has 0\.0 GB free/);
  assert.match(later[1].finding.fix, /Then run `yokoten doctor` to read the drive again$/);
  // Older than 7 days, broken, from a time to come, or not there: nothing is repeated.
  assert.deepEqual(marksOf(session(fakeMachine(100 * GB, { files, now: () => new Date('2026-10-28T08:30:00Z') }))), [['disk-space', true]], 'a week old');
  const saved = (text: string) => new Map([[machineStateFile(WSL), text]]);
  const hostDisk = { free: 0, size: 250 * GB, distro: '<distro>', version: 2 };
  for (const text of ['{ broken', JSON.stringify({ hostDisk: { ...hostDisk, readAt: 'yesterday' } }), JSON.stringify({ hostDisk: { ...hostDisk, readAt: '2026-11-20T00:00:00Z' } })]) {
    assert.deepEqual(marksOf(session(fakeMachine(100 * GB, { files: saved(text) }))), [['disk-space', true]], text);
  }
  assert.deepEqual(marksOf(session(fakeMachine(100 * GB))), [['disk-space', true]], 'no reading yet');
  // A reg.exe that fails is "can't read", a note and never ok.
  const unread = diskSpaceChecks('/repo', WSL, fakeMachine(100 * GB), false);
  assert.deepEqual(marksOf(unread), [['disk-space', true], ['host-disk', false]]);
  assert.match(unread[1].finding.what, /^can't read the Windows drive that holds this Linux disk: reg\.exe is not on the PATH$/);
});

test('machine: no host-disk line outside WSL, on WSL 1, or without WSL_DISTRO_NAME', () => {
  const machine = fakeMachine(0, { programs: { 'reg.exe': LXSS }, files: new Map([['/proc/sys/fs/binfmt_misc/WSLInterop', 'enabled\n']]) });
  assert.deepEqual(marksOf(diskSpaceChecks('/repo', { HOME: '/home/<user>' }, fakeMachine(0), false)), [['disk-space', false]], 'not WSL');
  assert.deepEqual(marksOf(diskSpaceChecks('/repo', { HOME: '/home/<user>' }, machine, false)), [['disk-space', false]], 'WSL under sudo: no distro name, no nagging note');
  // WSL 1 has no disk file: the repo's disk is the Windows drive, so one note, not two.
  assert.deepEqual(marksOf(diskSpaceChecks('/repo', { ...WSL, WSL_DISTRO_NAME: '<other>' }, machine, false)), [['disk-space', false]]);
  const files = new Map([[machineStateFile(WSL), JSON.stringify({ hostDisk: { free: 0, size: 250 * GB, readAt: NOW.toISOString(), distro: '<other>', version: 1 } })]]);
  assert.deepEqual(marksOf(diskSpaceChecks('/repo', WSL, fakeMachine(100 * GB, { files }), true)), [['disk-space', true]], 'a kept WSL 1 reading');
});

test("machine: the repo's disk that can't be read is a note, never a crash", () => {
  const broken = fakeMachine(0, {
    readDiskSpace: () => {
      throw new Error('statfs failed');
    },
  });
  const checks = diskSpaceChecks('/repo', {}, broken, false);
  assert.deepEqual(marksOf(checks), [['disk-space', false]]);
  assert.match(checks[0].finding.what, /^can't read the free space of the disk that holds this repo$/);
});

test('machine: a home that is read-only keeps no reading, and doctor goes on', () => {
  const machine = fakeMachine(0, {
    programs: { 'reg.exe': LXSS },
    writeText: () => {
      throw Object.assign(new Error('read-only'), { code: 'EROFS' });
    },
  });
  assert.doesNotThrow(() => saveHostCache(WSL, machine, { free: 0, size: 1, readAt: NOW.toISOString(), distro: '<distro>', version: 2 }));
  assert.deepEqual(marksOf(diskSpaceChecks('/repo', WSL, machine, false)), [['disk-space', false], ['host-disk', false]]);
});

test('machine: the real machine writes its reading under the home it is given, and a read-only one is left', { skip: (process.platform === 'win32' || process.getuid?.() === 0) && 'no read-only folder for root or on Windows' }, () => {
  const home = makeTempDir('yokoten-machine-');
  try {
    const env = { HOME: home };
    const cache = { free: 1, size: 2, readAt: NOW.toISOString(), distro: '<distro>', version: 2 };
    chmodSync(home, 0o500);
    saveHostCache(env, REAL_MACHINE, cache);
    assert.equal(REAL_MACHINE.readText(machineStateFile(env)), null);
    chmodSync(home, 0o700);
    saveHostCache(env, REAL_MACHINE, cache);
    assert.deepEqual(JSON.parse(REAL_MACHINE.readText(machineStateFile(env)) ?? '{}').hostDisk, cache);
  } finally {
    chmodSync(home, 0o700);
    rmSync(home, { recursive: true, force: true });
  }
});

test("machine: Claude Code's temp folder owned by another user is a note with the command to run, never run", () => {
  const ownedBy = (owner: number | null, dir = join('/tmp', 'claude-1000')) => fakeMachine(GB, { readOwner: (path) => (path === dir ? owner : null) });
  const note = agentTempDirCheck({}, ownedBy(0));
  assert.equal(note?.ok, false);
  assert.equal(note?.finding.what, "/tmp/claude-1000 belongs to uid 0, not to you (uid 1000), so Claude Code won't start");
  assert.match(note?.finding.fix ?? '', /^run `sudo rm -rf '\/tmp\/claude-1000'` yourself/);
  assert.equal(agentTempDirCheck({}, ownedBy(1000))?.ok, true);
  assert.equal(agentTempDirCheck({}, ownedBy(null)), null, 'no folder yet');
  assert.equal(agentTempDirCheck({}, { ...ownedBy(0), uid: null }), null, 'Windows has no uid');
  // CLAUDE_CODE_TMPDIR, then TMPDIR, moves the folder.
  const asked: string[] = [];
  const machine = fakeMachine(GB, { readOwner: (path) => (asked.push(path), null) });
  agentTempDirCheck({ CLAUDE_CODE_TMPDIR: '/scratch', TMPDIR: '/other' }, machine);
  agentTempDirCheck({ TMPDIR: '/other' }, machine);
  assert.deepEqual(asked, [join('/scratch', 'claude-1000'), join('/other', 'claude-1000')]);
});

test('machine: the printed command quotes the temp folder, so a space or $(...) in TMPDIR deletes nothing else', () => {
  const fixFor = (tmp: string) => agentTempDirCheck({ TMPDIR: tmp }, fakeMachine(GB, { readOwner: () => 0 }))?.finding.fix ?? '';
  assert.match(fixFor('/my temp'), /^run `sudo rm -rf '\/my temp\/claude-1000'` yourself/);
  assert.match(fixFor('/t/$(id)'), /^run `sudo rm -rf '\/t\/\$\(id\)\/claude-1000'` yourself/);
  assert.match(fixFor("/it's"), /^run `sudo rm -rf '\/it'\\''s\/claude-1000'` yourself/);
  assert.equal(quoteForShell("a'b"), "'a'\\''b'");
  // A newline can't be pasted safely: the folder is named, and no command is printed.
  const newline = agentTempDirCheck({ TMPDIR: '/t\nrm' }, fakeMachine(GB, { readOwner: () => 0 }))?.finding;
  assert.equal(newline?.fix, 'remove the folder "/t\\nrm/claude-1000" yourself, with sudo; Claude Code makes a new one when it starts');
  assert.doesNotMatch(newline?.what ?? '', /\n/);
});

test('machine: the notes show in full doctor and never change the exit code; a session hears a low disk', () => {
  const sandbox = makeSandbox();
  const env = { HOME: sandbox.home, YOKOTEN_TEMP_DIRS: '' };
  const machine = fakeMachine(0, { readOwner: () => 0 });
  const full = doctor(sandbox.repo, { env, config: DEFAULTS, machine });
  const quiet = doctor(sandbox.repo, { env, config: DEFAULTS, machine: fakeMachine(100 * GB) });
  assert.equal(full.ok, quiet.ok, 'a note never fails doctor');
  assert.ok(full.lines.includes('  note    disk-space: the disk that holds this repo has 0.0 GB free of 250 GB; free some space: delete caches and build outputs you do not need, or move data to another disk'), full.lines.join('\n'));
  assert.ok(full.lines.some((line) => line.startsWith('  note    agent-temp-dir: ')));
  assert.deepEqual(full.report.notes?.filter((n) => ['disk-space', 'agent-temp-dir'].includes(n.id)).length, 2);
  assert.ok(quiet.lines.includes('  ok      disk-space: 100 GB free of 250 GB'));
  const session = doctor(sandbox.repo, { env, config: DEFAULTS, machine, session: true });
  assert.ok(session.lines.some((line) => line.startsWith('yokoten: the disk that holds this repo has 0.0 GB free')));
  // The agent-temp-dir note's own text, so a temp path that happens to hold claude-1000 does not matter.
  const agentTemp = full.report.notes?.find((n) => n.id === 'agent-temp-dir');
  assert.ok(agentTemp, 'full doctor has the agent-temp-dir note');
  assert.ok(!session.lines.some((line) => line.includes(agentTemp.what)), 'the temp folder is full doctor only');
  assert.ok(!doctor(sandbox.repo, { env, config: DEFAULTS, machine: fakeMachine(100 * GB), session: true }).lines.some((line) => line.includes('disk')), 'room enough: nothing');
});

test('self-test: the machine control passes the real checks and fails broken ones (record 0012)', () => {
  assert.deepEqual(machineControl(), []);
  assert.ok(!selfTest().some((name) => name.includes('disk space') || name.includes('temp dir') || name.includes('host drive')));
  assert.deepEqual(machineControl(() => [], () => null), ['disk space check', 'host drive check', 'agent temp dir check']);
  // A host-drive reading that never finds the drive: the Windows drive is missed.
  const noHost: typeof diskSpaceChecks = (root, env, probe, session) => diskSpaceChecks(root, env, { ...probe, runProgram: () => '' }, session);
  assert.deepEqual(machineControl(noHost), ['host drive check']);
  // A Node check that passes everything, or nothing, is caught (#572).
  const passAll: typeof nodeSecurityCheck = (probe) => nodeSecurityCheck({ ...probe, nodeVersion: '24.22.1' });
  const failAll: typeof nodeSecurityCheck = (probe) => nodeSecurityCheck({ ...probe, nodeVersion: '20.19.0' });
  assert.deepEqual(machineControl(diskSpaceChecks, agentTempDirCheck, passAll), ['node security check']);
  assert.deepEqual(machineControl(diskSpaceChecks, agentTempDirCheck, failAll), ['node security check']);
});

// #572: a Node without the security fixes of 2026-10-21 is a note that says why and what to install.
test('machine: a Node release older than its line fix, or a line with no more fixes, is a note', () => {
  const check = (nodeVersion: string) => nodeSecurityCheck({ nodeVersion });
  const advisory = 'https://nodejs.org/en/blog/vulnerability/october-2026-security-releases';
  assert.deepEqual(check('24.21.0').finding.what, 'Node 24.21.0 has known security holes that Node fixed in October 2026');
  assert.equal(check('24.21.0').finding.fix, `upgrade Node to 24.22.1 or later; the advisory: ${advisory}`);
  assert.equal(check('v22.18.0').finding.what, 'Node 22.18.0 has known security holes that Node fixed in October 2026');
  assert.match(check('22.18.0').finding.fix, /^upgrade Node to 22\.23\.4 or later; /);
  assert.equal(check('22.23.3').ok, false, 'one release short of the fix');
  assert.equal(check('26.12.0').ok, false);
  for (const fixed of ['24.22.1', '22.23.4', '26.12.1', '22.24.0', '24.30.2', '28.1.0']) {
    assert.equal(check(fixed).ok, true, fixed);
    assert.equal(check(fixed).detail, `Node ${fixed}`);
  }
  for (const [version, line] of [['23.11.1', 23], ['20.19.5', 20], ['25.9.0', 25], ['18.20.8', 18]] as const) {
    const note = check(version);
    assert.equal(note.ok, false, version);
    assert.equal(note.finding.what, `Node ${version} is not supported, because Node ${line} gets no more security fixes`);
    assert.equal(note.finding.fix, `install Node 26.12.1 or later (or 22.23.4 or 24.22.1); the advisory: ${advisory}`);
  }
});

test('machine: full doctor shows the Node note and never fails on it; a session does not', () => {
  const sandbox = makeSandbox();
  const env = { HOME: sandbox.home, YOKOTEN_TEMP_DIRS: '' };
  const old = doctor(sandbox.repo, { env, config: DEFAULTS, machine: fakeMachine(100 * GB, { nodeVersion: '24.21.0' }) });
  const fixed = doctor(sandbox.repo, { env, config: DEFAULTS, machine: fakeMachine(100 * GB) });
  assert.equal(old.ok, fixed.ok, 'a note never fails doctor');
  assert.ok(old.lines.some((line) => line.startsWith('  note    node-security: Node 24.21.0 has known security holes')), old.lines.join('\n'));
  assert.ok(old.report.notes?.some((n) => n.id === 'node-security'));
  assert.ok(fixed.lines.includes('  ok      node-security: Node 24.22.1'), fixed.lines.join('\n'));
  const session = doctor(sandbox.repo, { env, config: DEFAULTS, machine: fakeMachine(100 * GB, { nodeVersion: '24.21.0' }), session: true });
  assert.ok(!session.lines.some((line) => line.includes('security holes')), 'full doctor only');
});

// #400: old yokoten-* folders in the temp folder. A note with the command; doctor never deletes.
const DAY = 24 * 60 * 60 * 1000;
function makeTempFolder(folders: Record<string, number>): string {
  const temp = makeTempDir('yokoten-tmp-');
  for (const [name, ageMs] of Object.entries(folders)) {
    mkdirSync(join(temp, name));
    writeFileSync(join(temp, name, 'data'), 'x'.repeat(2048));
    const when = new Date(NOW.getTime() - ageMs);
    utimesSync(join(temp, name), when, when);
  }
  return temp;
}

test('machine: yokoten-* folders older than a day are a note with their count and the command to remove them (#400)', () => {
  const temp = makeTempFolder({ 'yokoten-a1': 2 * DAY, 'yokoten-adopt-b2': 3 * DAY, 'yokoten-new': DAY / 2, 'other-old': 5 * DAY });
  writeFileSync(join(temp, 'yokoten-file'), 'not a folder');
  const note = leftoverTempCheck({ YOKOTEN_TEMP_DIRS: temp }, fakeMachine(GB));
  assert.equal(note?.ok, false);
  assert.equal(note?.name, 'leftover-temp-folders');
  assert.equal(note?.finding.what, `2 yokoten-* folders older than a day in ${temp}`);
  assert.equal(note?.finding.fix, `run \`find '${temp}' -maxdepth 1 -name 'yokoten-*' -mmin +1440 -exec rm -rf {} +\` yourself; it removes only the ones older than a day`);
  assert.equal(readFileSync(join(temp, 'yokoten-a1', 'data'), 'utf8').length, 2048, 'doctor deletes nothing');
  // Clean: only new folders, or none, or no temp folder to read: no note.
  assert.equal(leftoverTempCheck({ YOKOTEN_TEMP_DIRS: makeTempFolder({ 'yokoten-new': DAY / 2 }) }, fakeMachine(GB)), null);
  assert.equal(leftoverTempCheck({ YOKOTEN_TEMP_DIRS: join(temp, 'missing') }, fakeMachine(GB)), null, 'fails open');
  assert.equal(leftoverTempCheck({ YOKOTEN_TEMP_DIRS: '' }, fakeMachine(GB)), null, 'empty turns it off');
});

test('machine: the leftover note shows in full doctor only, and never changes the exit code (#400)', () => {
  const sandbox = makeSandbox();
  const temp = makeTempFolder({ 'yokoten-a1': 2 * DAY });
  const env = { HOME: sandbox.home, YOKOTEN_TEMP_DIRS: temp };
  const full = doctor(sandbox.repo, { env, config: DEFAULTS, machine: fakeMachine(100 * GB) });
  const clean = doctor(sandbox.repo, { env: { ...env, YOKOTEN_TEMP_DIRS: '' }, config: DEFAULTS, machine: fakeMachine(100 * GB) });
  assert.equal(full.ok, clean.ok, 'a note never fails doctor');
  assert.ok(full.lines.some((line) => line === `  note    leftover-temp-folders: 1 yokoten-* folder older than a day in ${temp}; run \`find '${temp}' -maxdepth 1 -name 'yokoten-*' -mmin +1440 -exec rm -rf {} +\` yourself; it removes only the ones older than a day`), full.lines.join('\n'));
  assert.ok(!clean.lines.some((line) => line.includes('leftover-temp-folders')), 'a clean temp folder: no note');
  const session = doctor(sandbox.repo, { env, config: DEFAULTS, machine: fakeMachine(100 * GB), session: true });
  assert.ok(!session.lines.some((line) => line.includes('yokoten-*')), 'full doctor only');
});

test('self-test: the leftover control passes the real check and fails a broken one (#400)', () => {
  assert.deepEqual(leftoverControl(), []);
  assert.deepEqual(leftoverControl(() => null), ['leftover temp folder check']);
  // A check that counts the new folder too is caught.
  assert.deepEqual(leftoverControl((env, probe, read) => leftoverTempCheck(env, { ...probe, now: () => new Date(Date.now() + 365 * DAY) }, read)), ['leftover temp folder check']);
});
test('saveHostCache: keeps the other keys of machine.json, such as the Windows user names (#404)', () => {
  const files = new Map([[machineStateFile(WSL), JSON.stringify({ windowsUsers: { names: ['JaneD'], readAt: NOW.toISOString(), scanMs: 1 } })]]);
  saveHostCache(WSL, fakeMachine(GB, { files }), { free: 0, size: 1, readAt: NOW.toISOString(), distro: '<distro>', version: 2 });
  const state = JSON.parse(files.get(machineStateFile(WSL)) ?? '{}');
  assert.deepEqual(state.windowsUsers.names, ['JaneD']);
  assert.equal(state.hostDisk.size, 1);
});

