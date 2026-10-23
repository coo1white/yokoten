#!/usr/bin/env node
// The Claude Code plugin hook (#706). One short command runs this file, which resolves
// yokoten. A cache path is used only when it is a real file inside the plugin cache.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const mode = process.argv[2];
const fallback = process.argv[3];
const args = process.argv.slice(4);
const heapFlag = '--max-old-space-size=256';
const toolLine = 'yokoten: the guard cannot run, because no safe plugin copy was found, so the command is refused';
const sessionLine = 'yokoten: the session check cannot run, because no safe plugin copy was found';
const idPrefix = 'yokoten@';
const isTool = mode !== 'session';

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

function readUserPlugin() {
  try {
    const root = process.env.HOME;
    if (typeof root !== 'string' || !path.isAbsolute(root)) return null;
    const pluginsDir = path.join(root, '.claude', 'plugins');
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

function fallbackBinary() {
  try {
    return typeof fallback === 'string' && fallback.length > 0 && fs.statSync(fallback).isFile() ? fallback : null;
  } catch {
    return null;
  }
}

function resolveBinary() {
  const picked = readUserPlugin();
  if (!picked || !isSegment(picked.marketplace)) return fallbackBinary();
  const cacheReal = readCacheReal(picked.pluginsDir);
  const version = picked.entry.version;
  if (!cacheReal || typeof version !== 'string') return fallbackBinary();
  if (typeof picked.entry.installPath === 'string') {
    const chosen = safeBinary(picked.entry.installPath, picked.marketplace, version, cacheReal);
    if (chosen) return chosen;
  }
  if (!isSegment(version)) return fallbackBinary();
  const built = path.join(picked.pluginsDir, 'cache', picked.marketplace, 'yokoten', version);
  return safeBinary(built, picked.marketplace, version, cacheReal) || fallbackBinary();
}

function giveUp() {
  fs.writeSync(isTool ? 2 : 1, `${isTool ? toolLine : sessionLine}\n`);
  process.exit(isTool ? 2 : 0);
}

// A tool call fails closed (#260): exit 0 and 2 pass, and any other status becomes 2.
// The child's own error text is dropped, so a trace never shows a path.
function runBinary(binary) {
  const nodeArgs = isTool ? [heapFlag, binary, ...args] : [binary, ...args];
  const child = spawnSync(process.execPath, nodeArgs, { stdio: isTool ? ['inherit', 'inherit', 'pipe'] : 'inherit' });
  const signalNumber = child.signal ? os.constants.signals[child.signal] : undefined;
  const code = child.signal ? 128 + (typeof signalNumber === 'number' ? signalNumber : 1) : typeof child.status === 'number' ? child.status : 1;
  if (!isTool) process.exit(code);
  if (code === 0 || code === 2) {
    if (child.stderr && child.stderr.length > 0) fs.writeSync(2, child.stderr);
    process.exit(code);
  }
  fs.writeSync(2, `yokoten's guard failed (exit ${code}), so the command is refused; run \`yokoten doctor\`\n`);
  process.exit(2);
}

const binary = resolveBinary();
if (!binary) giveUp();
runBinary(binary);
