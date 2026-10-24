// A disk's free space, and the last reading of the Windows drive under a WSL 2 disk file.
// Full `doctor` reads that drive through reg.exe and keeps the reading in machine.json; a
// session and the tool-call guard repeat the kept reading, so neither runs a program (#398,
// #401). The limit and the fix are the same in all three, or a person reads two answers.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Env } from '../../rules/config.ts';
import { homeIn } from '../../rules/privacy/index.ts';

/** Free and total bytes of one filesystem. */
export interface DiskSpace {
  free: number;
  size: number;
}

const GB = 1024 ** 3;

/**
 * Whether a disk is low on space. The default warns below 20 GB when that is also under
 * 10% of the disk. So a 250 GB drive with nothing free warns, and a 2 TB drive with
 * 150 GB free does not; a small disk is not warned at once. YOKOTEN_MIN_FREE_GB, when
 * set, is the one limit instead, in GB; 0 turns the warning off.
 */
export function isLowOnSpace(space: DiskSpace, env: Env): boolean {
  const limit = Number(env.YOKOTEN_MIN_FREE_GB);
  if (env.YOKOTEN_MIN_FREE_GB?.trim() && Number.isFinite(limit) && limit >= 0) return space.free < limit * GB;
  return space.free < 20 * GB && space.free < space.size / 10;
}

const formatGb = (bytes: number) => `${bytes < 10 * GB ? (bytes / GB).toFixed(1) : Math.round(bytes / GB)} GB`;

/** A disk's free and total space, as a person reads it: `8.0 GB free of 250 GB`. */
export const formatSpace = (space: DiskSpace) => `${formatGb(space.free)} free of ${formatGb(space.size)}`;

/** The drive a low reading is about: the one a WSL 2 disk file sits on. */
export const HOST_DRIVE = 'the Windows drive that holds this Linux disk';

/** Microsoft's guide to a WSL disk file: how to compact it, and how to move it. */
export const WSL_DISK_GUIDE = 'https://learn.microsoft.com/windows/wsl/disk-space';

/**
 * The fix for a full Windows drive. A WSL 2 disk file only grows, so the fix points to
 * Microsoft's guide, never to a command: its sparse mode is marked unsafe (record 0012).
 */
export const HOST_DISK_FIX =
  `free some space on that drive in Windows. The VM's disk file only grows. Deleting files inside the VM frees nothing on the Windows drive. Back up your work to another drive first. Then free space on the Windows drive, or shrink or move the disk file: ${WSL_DISK_GUIDE}`;

/** The last reading of the Windows drive, kept so a session can repeat it without reg.exe. */
export interface HostDiskCache {
  free: number;
  size: number;
  /** When full doctor read it, in UTC. */
  readAt: string;
  distro: string;
  version: number;
}

/** A kept reading older than this is not repeated: the drive may have changed since. */
export const MAX_READING_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/** `value` read as a kept reading, or null when it is not one. */
export function hostDiskCache(value: unknown): HostDiskCache | null {
  const cache = value as Partial<HostDiskCache> | null | undefined;
  return cache && typeof cache.free === 'number' && typeof cache.size === 'number' && typeof cache.readAt === 'string' ? (cache as HostDiskCache) : null;
}

/** Whether `cache` was read within the last 7 days, at or before `now`. */
export function isFreshReading(cache: HostDiskCache, now: Date): boolean {
  const age = now.getTime() - Date.parse(cache.readAt);
  return Number.isFinite(age) && age >= 0 && age <= MAX_READING_AGE_MS;
}

/**
 * The kept reading in `~/.config/yokoten/machine.json`, when it is fresh and from WSL 2,
 * or null. It reads one small file and starts no program. WSL 1 has no disk file, so its
 * reading names no other drive.
 */
export function readKeptHostDisk(env: Env, now: Date = new Date()): HostDiskCache | null {
  try {
    const state: unknown = JSON.parse(readFileSync(join(homeIn(env), '.config', 'yokoten', 'machine.json'), 'utf8'));
    const cache = hostDiskCache((state as Record<string, unknown> | null)?.hostDisk);
    return cache && cache.version !== 1 && isFreshReading(cache, now) ? cache : null;
  } catch {
    return null;
  }
}
