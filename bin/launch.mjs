#!/usr/bin/env node
// The Claude Code plugin hook (#706). One short command runs this file, which resolves
// yokoten. A cache path is used only when it is a real file inside the plugin cache.
// runLaunch does the work. The script at the bottom calls it, then exits.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const heapFlag = '--max-old-space-size=256';
const toolLine = 'yokoten: the guard cannot run, because no safe plugin copy was found, so the command is refused';
const sessionLine = 'yokoten: the session check cannot run, because no safe plugin copy was found';
const idPrefix = 'yokoten@';

const hasControl = (text) => {
  for (let index = 0; index < text.length; index += 1) if (text.charCodeAt(index) < 32) return true;
  return false;
};
const isSegment = (text) => typeof text === 'string' && text.length > 0 && text !== '.' && !text.includes('..') && !text.includes('/') && !text.includes('\\') && !text.includes("'") && !text.includes('"') && !text.includes('`') && !hasControl(text);
const isRecord = (value) => !!value && typeof value === 'object' && !Array.isArray(value);
const isInside = (realPath, cacheReal) => realPath.startsWith(cacheReal.endsWith(path.sep) ? cacheReal : `${cacheReal}${path.sep}`);

function endsWithSuffix(folder, marketplace, version) {
  const suffix = `${path.sep}${marketplace}${path.sep}yokoten${path.sep}${version}`;
  return (folder.endsWith(path.sep) ? folder.slice(0, -1) : folder).endsWith(suffix);
}

function isSafeFolder(folder, marketplace, version) {
  if (typeof folder !== 'string' || !path.isAbsolute(folder)) return false;
  if (!isSegment(marketplace) || !isSegment(version)) return false;
  if (folder.includes('\\') || folder.includes("'") || folder.includes('"') || folder.includes('`') || hasControl(folder)) return false;
  const parts = folder.split(path.sep);
  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index];
    if (part === '' && (index === 0 || index === parts.length - 1)) continue;
    if (!isSegment(part)) return false;
  }
  return endsWithSuffix(folder, marketplace, version);
}

function safeBinary(folder, marketplace, version, cacheReal) {
  try {
    if (!isSafeFolder(folder, marketplace, version)) return null;
    const realFolder = fs.realpathSync(folder);
    if (!isInside(realFolder, cacheReal) || !endsWithSuffix(realFolder, marketplace, version)) return null;
    const binary = path.join(folder, 'bin', 'yokoten.mjs');
    const info = fs.lstatSync(binary);
    if (!info.isFile() && !info.isSymbolicLink()) return null;
    const realBinary = fs.realpathSync(binary);
    if (!isInside(realBinary, cacheReal) || !fs.statSync(realBinary).isFile()) return null;
    return realBinary;
  } catch {
    return null;
  }
}

function readCacheReal(pluginsDir) {
  try {
    const real = fs.realpathSync(path.join(pluginsDir, 'cache'));
    return fs.statSync(real).isDirectory() ? real : null;
  } catch {
    return null;
  }
}

function readUserPlugin(home) {
  try {
    if (typeof home !== 'string' || !path.isAbsolute(home)) return null;
    const pluginsDir = path.join(home, '.claude', 'plugins');
    const parsed = JSON.parse(fs.readFileSync(path.join(pluginsDir, 'installed_plugins.json'), 'utf8'));
    if (!isRecord(parsed) || !isRecord(parsed.plugins)) return null;
    for (const id of Object.keys(parsed.plugins)) {
      if (!id.startsWith(idPrefix)) continue;
      const entries = parsed.plugins[id];
      if (!Array.isArray(entries)) continue;
      const entry = entries.find((item) => isRecord(item) && item.scope === 'user');
      if (entry) return { marketplace: id.slice(idPrefix.length), entry, pluginsDir };
    }
    return null;
  } catch {
    return null;
  }
}

function fallbackBinary(fallback) {
  try {
    return typeof fallback === 'string' && fallback.length > 0 && fs.statSync(fallback).isFile() ? fallback : null;
  } catch {
    return null;
  }
}

function resolveBinary(home, fallback) {
  const picked = readUserPlugin(home);
  if (!picked || !isSegment(picked.marketplace)) return fallbackBinary(fallback);
  const cacheReal = readCacheReal(picked.pluginsDir);
  const version = picked.entry.version;
  if (!cacheReal || typeof version !== 'string') return fallbackBinary(fallback);
  if (typeof picked.entry.installPath === 'string') {
    const chosen = safeBinary(picked.entry.installPath, picked.marketplace, version, cacheReal);
    if (chosen) return chosen;
  }
  if (!isSegment(version)) return fallbackBinary(fallback);
  const built = path.join(picked.pluginsDir, 'cache', picked.marketplace, 'yokoten', version);
  return safeBinary(built, picked.marketplace, version, cacheReal) || fallbackBinary(fallback);
}

// A tool call fails closed (#260): exit 0 and 2 pass, and any other status becomes 2.
// The child's own error text is dropped, so a trace never shows a path.
export function runLaunch({ mode, fallback, args, env, input, cwd }) {
  const isTool = mode !== 'session';
  const binary = resolveBinary(env && env.HOME, fallback);
  if (!binary) {
    const line = `${isTool ? toolLine : sessionLine}\n`;
    return isTool ? { status: 2, stdout: '', stderr: line } : { status: 0, stdout: line, stderr: '' };
  }
  const nodeArgs = isTool ? [heapFlag, binary, ...args] : [binary, ...args];
  const child = spawnSync(process.execPath, nodeArgs, { cwd, env, input, stdio: ['pipe', 'pipe', 'pipe'] });
  const signalNumber = child.signal ? os.constants.signals[child.signal] : undefined;
  const code = child.signal ? 128 + (typeof signalNumber === 'number' ? signalNumber : 1) : typeof child.status === 'number' ? child.status : 1;
  const stdout = child.stdout ? child.stdout.toString('utf8') : '';
  const stderr = child.stderr && child.stderr.length > 0 ? child.stderr.toString('utf8') : '';
  if (!isTool) return { status: code, stdout, stderr };
  if (code === 0 || code === 2) return { status: code, stdout, stderr };
  return { status: 2, stdout, stderr: `yokoten's guard failed (exit ${code}), so the command is refused; run \`yokoten doctor\`\n` };
}

// The hook command starts this file. Stdin is the tool call; the child still reads it.
let isEntry = false;
try {
  const entry = process.argv[1];
  isEntry = !!entry && fs.realpathSync(entry) === fs.realpathSync(fileURLToPath(import.meta.url));
} catch {
  // A path that is not there is not this script.
}
if (isEntry) {
  let input = '';
  try { input = fs.readFileSync(0, 'utf8'); } catch { /* stdin is closed */ }
  const result = runLaunch({ mode: process.argv[2], fallback: process.argv[3], args: process.argv.slice(4), env: process.env, input });
  if (result.stdout) fs.writeSync(1, result.stdout);
  if (result.stderr) fs.writeSync(2, result.stderr);
  process.exit(result.status);
}
