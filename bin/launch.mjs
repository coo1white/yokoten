#!/usr/bin/env node
// The Claude Code plugin hook (#706). A cache path is a real file inside the plugin cache, or it is refused.
// The account home comes from the password file. HOME is never the plugin root.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const heapFlag = '--max-old-space-size=256';
const toolLine = 'yokoten: the guard cannot run, because no safe plugin copy was found, so the command is refused';
const sessionLine = 'yokoten: the session check cannot run, because no safe plugin copy was found';
const idPrefix = 'yokoten@';

const hasControl = (text) => { for (let index = 0; index < text.length; index += 1) if (text.charCodeAt(index) < 32) return true; return false; };
const isReserved = (text) => /^(con|prn|aux|nul|conin\$|conout\$|com[1-9]|lpt[1-9])(\..*)?$/i.test(text);
const isSegment = (text) => typeof text === 'string' && text.length > 0 && text !== '.' && !text.includes('..') && !text.includes('/') && !text.includes('\\') && !text.includes("'") && !text.includes('"') && !text.includes('`') && !text.includes(':') && !text.endsWith(' ') && !text.endsWith('.') && !isReserved(text) && !hasControl(text);
const isRecord = (value) => !!value && typeof value === 'object' && !Array.isArray(value);
const isInside = (realPath, rootReal) => realPath.startsWith(rootReal.endsWith(path.sep) ? rootReal : `${rootReal}${path.sep}`);
const endsWithSuffix = (folder, marketplace, version) => folder.replace(/[\\/]+$/, '').split(/[\\/]/).slice(-3).join('/') === `${marketplace}/yokoten/${version}`;

// A drive letter is the only colon a cache path may hold. Any other colon is refused.
function pathParts(folder) {
  const windows = /^[A-Za-z]:[\\/]/.test(folder);
  if (!windows && folder.includes('\\')) return null;
  const parts = folder.split(windows ? /[\\/]/ : path.sep);
  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index];
    if ((part === '' && (index === 0 || index === parts.length - 1)) || (windows && index === 0 && /^[A-Za-z]:$/.test(part))) continue;
    if (!isSegment(part)) return null;
  }
  return parts;
}

export function isSafeFolder(folder, marketplace, version) {
  if (typeof folder !== 'string' || !isSegment(marketplace) || !isSegment(version)) return false;
  if (folder.includes("'") || folder.includes('"') || folder.includes('`') || hasControl(folder)) return false;
  if (!/^[A-Za-z]:[\\/]/.test(folder) && !path.isAbsolute(folder)) return false;
  return !!pathParts(folder) && endsWithSuffix(folder, marketplace, version);
}

function fileInside(file, rootReal) {
  const info = fs.lstatSync(file);
  if (!info.isFile() && !info.isSymbolicLink()) return null;
  const realFile = fs.realpathSync(file);
  return isInside(realFile, rootReal) && fs.statSync(realFile).isFile() ? realFile : null;
}

function safeBinary(folder, marketplace, version, cacheReal) {
  try {
    if (!isSafeFolder(folder, marketplace, version)) return null;
    const realFolder = fs.realpathSync(folder);
    if (!isInside(realFolder, cacheReal) || !endsWithSuffix(realFolder, marketplace, version)) return null;
    return fileInside(path.join(folder, 'bin', 'yokoten.mjs'), cacheReal);
  } catch {
    return null;
  }
}

function readCacheReal(pluginsDir) {
  try {
    const real = fs.realpathSync(path.join(pluginsDir, 'cache'));
    return fs.statSync(real).isDirectory() ? real : null;
  } catch { return null; }
}

function readUserPlugin(home) {
  try {
    if (typeof home !== 'string' || !path.isAbsolute(home)) return null;
    const pluginsDir = path.join(home, '.claude', 'plugins');
    const parsed = JSON.parse(fs.readFileSync(path.join(pluginsDir, 'installed_plugins.json'), 'utf8'));
    if (!isRecord(parsed) || !isRecord(parsed.plugins)) return null;
    for (const id of Object.keys(parsed.plugins)) {
      const entries = parsed.plugins[id];
      const entry = id.startsWith(idPrefix) && Array.isArray(entries) ? entries.find((item) => isRecord(item) && item.scope === 'user') : undefined;
      if (entry) return { marketplace: id.slice(idPrefix.length), entry, pluginsDir };
    }
    return null;
  } catch {
    return null;
  }
}

function fallbackBinary(fallback) {
  try {
    if (typeof fallback !== 'string' || !path.isAbsolute(fallback)) return null;
    const parts = pathParts(fallback);
    if (!parts || parts.at(-1) !== 'yokoten.mjs' || parts.at(-2) !== 'bin') return null;
    return fileInside(fallback, fs.realpathSync(path.dirname(path.dirname(fallback))));
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

function readAccountHome(accountHome) {
  try {
    const home = typeof accountHome === 'string' && path.isAbsolute(accountHome) ? accountHome : os.userInfo().homedir;
    return typeof home === 'string' && path.isAbsolute(home) ? home : null;
  } catch { return null; }
}

// A tool call fails closed (#260, #706). A spawn error, or no exit status, is not a pass. Exit 0 and 2 pass.
export function runLaunch({ mode, fallback, args, env, input, cwd, accountHome, spawn }) {
  const isTool = mode !== 'session';
  const binary = resolveBinary(readAccountHome(accountHome), fallback);
  if (!binary) {
    const line = `${isTool ? toolLine : sessionLine}\n`;
    return isTool ? { status: 2, stdout: '', stderr: line } : { status: 0, stdout: line, stderr: '' };
  }
  const nodeArgs = isTool ? [heapFlag, binary, ...args] : [binary, ...args];
  const child = (spawn ?? spawnSync)(process.execPath, nodeArgs, { cwd, env, input, stdio: ['pipe', 'pipe', 'pipe'] });
  const signalNumber = child.signal ? os.constants.signals[child.signal] : undefined;
  const real = !child.error && (!!child.signal || typeof child.status === 'number');
  const code = !real ? 1 : child.signal ? 128 + (typeof signalNumber === 'number' ? signalNumber : 1) : child.status;
  const stdout = real && child.stdout ? child.stdout.toString('utf8') : '';
  const stderr = real && child.stderr && child.stderr.length > 0 ? child.stderr.toString('utf8') : '';
  if (!isTool) return { status: code, stdout, stderr };
  if (code === 0 || code === 2) return { status: code, stdout, stderr };
  return { status: 2, stdout, stderr: `yokoten's guard failed (exit ${code}), so the command is refused; run \`yokoten doctor\`\n` };
}

let isEntry = false;
try {
  const entry = process.argv[1];
  isEntry = !!entry && fs.realpathSync(entry) === fs.realpathSync(fileURLToPath(import.meta.url));
} catch { /* A path that is not there is not this script. */ }
if (isEntry) {
  let input = '';
  try { input = fs.readFileSync(0, 'utf8'); } catch { /* stdin is closed */ }
  const result = runLaunch({ mode: process.argv[2], fallback: process.argv[3], args: process.argv.slice(4), env: process.env, input });
  if (result.stdout) fs.writeSync(1, result.stdout);
  if (result.stderr) fs.writeSync(2, result.stderr);
  process.exit(result.status);
}
