// `yokoten mcp`: start the project's MCP server over stdio and judge its tool list against
// the traps that real agent clients hit (#370). The pure rules, the stdio client and the
// command live together here because they are one small group and every layer folder is
// already at the seven-entry cap. The findings use the usual what / why / fix shape, and a
// warning about Windows does not fail the check: one machine may never run Windows.

import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Env } from '../../rules/config.ts';
import { type Finding, finding, isFailingFinding } from '../../rules/message.ts';
import { bullets, type Invocation, parse, print, printJson, requireRoot, usage } from '../shared.ts';

/** One tool as `tools/list` sends it. Only the fields the rules read are named; the rest stays as it came. */
export interface McpTool {
  name?: unknown;
  description?: unknown;
  inputSchema?: unknown;
  outputSchema?: unknown;
  annotations?: unknown;
  [field: string]: unknown;
}

/** One stdio server as a config file names it: the command to start, its arguments, and its own environment. */
export interface McpServerEntry {
  command?: unknown;
  args?: unknown;
  env?: unknown;
  url?: unknown;
  type?: unknown;
}

/** What a tool list costs a client: how many tools, the bytes of the whole definition, and the longest description. */
export interface ToolMetrics {
  count: number;
  bytes: number;
  longestDescription: number;
  withOutputSchema: number;
}

export const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

const PROPERTY_NAME = /^[A-Za-z0-9_.-]{1,64}$/;
/** The four hints ChatGPT apps and several clients read. Each one is set by hand, never left out. */
export const HINTS = ['readOnlyHint', 'destructiveHint', 'idempotentHint', 'openWorldHint'] as const;

/** How many tools a client with a small window keeps: Cursor uses only about the first 40. */
export const TOOL_LIMIT = 40;

/** Every problem in one schema, at any depth. A `$ref` or a type list is rejected by Gemini; a root branch is rejected by Claude. */
function schemaProblems(schema: unknown, at: string, isRoot: boolean): { what: string; fix: string }[] {
  const problems: { what: string; fix: string }[] = [];
  const seen = new WeakSet<object>();
  const walk = (node: unknown, path: string, root: boolean): void => {
    if (!isRecord(node) || seen.has(node)) return;
    seen.add(node);
    if (root) {
      const branch = ['anyOf', 'oneOf', 'allOf'].find((key) => Array.isArray(node[key]));
      if (branch) problems.push({ what: `${at} has a root ${branch}`, fix: `put the branches under one property of a root object, or use a flat schema` });
    }
    if ('$ref' in node || '$defs' in node) {
      problems.push({ what: `${at} uses ${'$ref' in node ? '$ref' : '$defs'} at ${path || 'the root'}`, fix: 'inline the shared schema, or send a flat copy without $ref or $defs' });
    }
    if (Array.isArray(node.type)) {
      problems.push({ what: `${at} gives a list of types at ${path || 'the root'}`, fix: 'use one type, and a separate nullable field or a second tool' });
    }
    if (node.type === 'array' && !('items' in node)) {
      problems.push({ what: `${at} has an array at ${path || 'the root'} with no items`, fix: 'add items to every array, even when it is empty' });
    }
    if (isRecord(node.properties)) {
      const properties = Object.keys(node.properties);
      const required = Array.isArray(node.required) ? node.required.filter((key): key is string => typeof key === 'string') : [];
      const missing = properties.filter((name) => !required.includes(name));
      if (missing.length) {
        problems.push({ what: `${at} leaves ${missing.length} propert${missing.length === 1 ? 'y' : 'ies'} out of required at ${path || 'the root'} (${missing.join(', ')})`, fix: 'add every property to required, or mark the optional ones nullable and required' });
      }
      for (const [name, value] of Object.entries(node.properties)) {
        const place = `${path || 'the root'}.properties.${name}`;
        if (!PROPERTY_NAME.test(name)) {
          problems.push({ what: `${at} has the property name "${name}" at ${place}`, fix: 'rename it to letters, digits, _ . or - (64 or fewer), or Claude Code drops the whole tool' });
        }
        walk(value, place, false);
      }
    }
    if (isRecord(node.items)) walk(node.items, `${path || 'the root'}.items`, false);
    else if (Array.isArray(node.items)) for (const item of node.items) walk(item, `${path || 'the root'}.items`, false);
    if (isRecord(node.additionalProperties)) walk(node.additionalProperties, `${path || 'the root'}.additionalProperties`, false);
    for (const key of ['anyOf', 'oneOf', 'allOf']) {
      if (!Array.isArray(node[key])) continue;
      node[key].forEach((branch, index) => walk(branch, `${path || 'the root'}.${key}[${index}]`, false));
    }
  };
  walk(schema, '', isRoot);
  return problems;
}

/** The description a client shows for a tool, in characters. A missing one is zero. */
const descriptionLength = (tool: McpTool): number => (typeof tool.description === 'string' ? tool.description.length : 0);

/** How much of a client's context one tool list takes, and how long its longest description is. */
export function toolMetrics(tools: unknown[]): ToolMetrics {
  const list = tools.filter(isRecord) as McpTool[];
  return {
    count: tools.length,
    bytes: Buffer.byteLength(JSON.stringify(tools)),
    longestDescription: list.reduce((longest, tool) => Math.max(longest, descriptionLength(tool)), 0),
    withOutputSchema: list.filter((tool) => isRecord(tool.outputSchema)).length,
  };
}

/** Every problem in one tool: its name, its schema, its hints, and its result shape when one was read. */
export function lintTool(tool: unknown, index: number): Finding[] {
  if (!isRecord(tool)) return [finding('mcp-schema', `tool ${index + 1} is not an object`, 'send each tool as a JSON object with name, description and inputSchema')];
  const name = typeof tool.name === 'string' ? tool.name : '';
  const label = name || `tool ${index + 1}`;
  const problems: Finding[] = [];
  if (!name) problems.push(finding('mcp-name', `tool ${index + 1} has no name`, 'give every tool a name of 64 characters or fewer'));
  else if (name.length > 64) problems.push(finding('mcp-name', `tool "${name}" has a name of ${name.length} characters`, 'shorten the name to 64 characters or fewer, as OpenAI requires'));
  if (!isRecord(tool.inputSchema)) {
    problems.push(finding('mcp-schema', `tool "${label}" has no inputSchema object`, 'send an inputSchema object for every tool, even when it takes no arguments'));
  } else {
    for (const problem of schemaProblems(tool.inputSchema, `tool "${label}" inputSchema`, true)) problems.push(finding('mcp-schema', problem.what, problem.fix));
  }
  if (isRecord(tool.outputSchema)) {
    for (const problem of schemaProblems(tool.outputSchema, `tool "${label}" outputSchema`, true)) problems.push(finding('mcp-schema', problem.what, problem.fix));
  }
  const annotations = isRecord(tool.annotations) ? tool.annotations : null;
  const missing = HINTS.filter((hint) => typeof annotations?.[hint] !== 'boolean');
  if (missing.length) {
    problems.push(finding('mcp-annotations', `tool "${label}" does not set ${missing.join(', ')}`, `set ${HINTS.join(', ')} on every tool, each as true or false`));
  }
  return problems;
}

/** Every problem in a `tools/list` answer: each tool, and the count that a small client window keeps. */
export function lintTools(tools: unknown[]): Finding[] {
  const problems = tools.flatMap((tool, index) => lintTool(tool, index));
  if (tools.length >= TOOL_LIMIT) {
    problems.push(finding('mcp-count', `${tools.length} tools are listed, and Cursor uses only about the first ${TOOL_LIMIT}`, `merge tools, or keep ${TOOL_LIMIT - 1} or fewer in tools/list and offer the rest behind one tool`));
  }
  return problems;
}

/** A result that declares `outputSchema` must carry both forms: a text item for Cursor, and structuredContent for clients that read it. */
export function lintCallResult(name: string, result: unknown): Finding[] {
  if (!isRecord(result) || result.isError === true) return [];
  const problems: Finding[] = [];
  if (!isRecord(result.structuredContent)) problems.push(finding('mcp-output', `tool "${name}" declares an outputSchema but its result has no structuredContent`, 'return the schema-shaped value in structuredContent'));
  const content = Array.isArray(result.content) ? result.content : [];
  const hasText = content.some((item) => isRecord(item) && item.type === 'text' && typeof item.text === 'string' && item.text.length > 0);
  if (!hasText) problems.push(finding('mcp-output', `tool "${name}" declares an outputSchema but its result has no text content`, 'also return the same value as a text content item, because Cursor drops a result that is only structuredContent'));
  return problems;
}

/** Whether a config command needs a shell on Windows: npx, npm and the other runners, or a .cmd or .bat file. */
export function needsWindowsShell(command: string): boolean {
  const base = command.replaceAll('\\', '/').split('/').at(-1) ?? command;
  return /^(?:npx|npm|pnpm|yarn|bunx|uvx)(?:\.cmd)?$/i.test(base) || /\.(?:cmd|bat)$/i.test(base);
}

/**
 * A warning for one stdio server entry that Windows cannot start without `cmd /c`.
 * It only warns: a project may be run on one machine that is not Windows.
 */
export function lintServerEntry(name: string, entry: McpServerEntry): Finding[] {
  if (typeof entry.url === 'string' || (typeof entry.type === 'string' && entry.type !== 'stdio')) return [];
  if (typeof entry.command !== 'string') return [finding('mcp-server', `server "${name}" has no command`, 'give each stdio server a command, its args, and no url')];
  if (!needsWindowsShell(entry.command)) return [];
  return [finding('mcp-windows', `server "${name}" starts with ${entry.command}, which Windows cannot start without a shell`, 'on Windows, use cmd with /c before the command, or call the .cmd file through cmd', { grade: 'likely' })];
}

/** How many stdout lines are named before one line says the rest. */
const STDOUT_LIMIT = 10;

/** The lines a client reads on stdout: JSON-RPC only. A stray line, a CRLF tail or a broken character stops some clients. */
export function lintStdout(lines: string[]): Finding[] {
  const problems: Finding[] = [];
  for (const [index, line] of lines.entries()) {
    if (line === '') continue;
    const number = index + 1;
    if (line.includes('\uFFFD')) {
      problems.push(finding('mcp-stdout', `stdout line ${number} is not UTF-8`, 'write UTF-8 only: a Windows code page such as cp1252 breaks the JSON-RPC stream'));
      continue;
    }
    const hasCarriageReturn = line.endsWith('\r');
    const text = hasCarriageReturn ? line.slice(0, -1) : line;
    let message: unknown;
    try {
      message = JSON.parse(text);
    } catch {
      problems.push(finding('mcp-stdout', `stdout line ${number} is not JSON-RPC`, 'write logs to stderr; stdout must carry one JSON-RPC message per line and nothing else'));
      continue;
    }
    const isRpc = isRecord(message) && message.jsonrpc === '2.0' && (typeof message.method === 'string' || 'id' in message || 'result' in message || 'error' in message);
    if (!isRpc) {
      problems.push(finding('mcp-stdout', `stdout line ${number} is JSON but not a JSON-RPC message`, 'write logs to stderr; stdout must carry one JSON-RPC message per line and nothing else'));
      continue;
    }
    if (hasCarriageReturn) {
      problems.push(finding('mcp-stdout', `stdout line ${number} ends with CRLF`, 'write one line feed (LF) after each message; some clients split on LF and keep the carriage return', { grade: 'likely' }));
    }
  }
  if (problems.length <= STDOUT_LIMIT) return problems;
  const rest = problems.length - STDOUT_LIMIT;
  return [...problems.slice(0, STDOUT_LIMIT), finding('mcp-stdout', `${rest} more stdout line(s) are not JSON-RPC`, 'write logs to stderr; stdout must carry one JSON-RPC message per line and nothing else')];
}


/** The config files a project may keep its MCP servers in, in the order yokoten reads them. */
export const CONFIG_FILES = ['.mcp.json', '.vscode/mcp.json', 'mcp.json'];

/** One server as a config file names it, with the file it came from. */
export interface McpServer {
  name: string;
  entry: McpServerEntry;
  file: string;
}

/** What `readMcpConfig` found: the stdio and HTTP entries, and any config file it could not read. */
export interface McpConfig {
  servers: McpServer[];
  problems: Finding[];
}

/** The `mcpServers` or `servers` map of one config file. VS Code uses `servers`; Claude Code uses `mcpServers`. */
function serverMap(text: string): Record<string, unknown> | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isRecord(parsed)) return null;
  const map = parsed.mcpServers ?? parsed.servers;
  return isRecord(map) ? map : null;
}

/** Read the MCP servers a project config keeps. A file that is not JSON is one finding, never a crash. */
export function readMcpConfig(root: string): McpConfig {
  const servers: McpServer[] = [];
  const problems: Finding[] = [];
  for (const file of CONFIG_FILES) {
    const path = join(root, file);
    if (!existsSync(path)) continue;
    let text: string;
    try {
      text = readFileSync(path, 'utf8');
    } catch {
      problems.push(finding('mcp-server', `${file} cannot be read`, 'check its permissions, or remove it if you no longer use it'));
      continue;
    }
    const map = serverMap(text);
    if (!map) {
      problems.push(finding('mcp-server', `${file} is not JSON with an mcpServers or servers object`, 'fix the JSON, or name each server under "mcpServers"'));
      continue;
    }
    for (const [name, entry] of Object.entries(map)) {
      if (isRecord(entry)) servers.push({ name, entry: entry as McpServerEntry, file });
    }
  }
  return { servers, problems };
}

/** What one server answered. `isReady` is false when initialize or tools/list never came. */
export interface ServerRead {
  tools: unknown[];
  stdout: Finding[];
  probes: Finding[];
  error?: Finding;
  isReady: boolean;
  probed: number;
}

/** A JSON-RPC request, as the client writes it. */
interface Request {
  jsonrpc: '2.0';
  id: number;
  method: string;
  params: Record<string, unknown>;
}

const encode = (request: Request) => `${JSON.stringify(request)}\n`;

/** The environment a server gets: the caller's, plus its own `env` entries. Only string values are passed. */
function serverEnvironment(env: Env, own: unknown): Env {
  const merged: Env = { ...env };
  if (!isRecord(own)) return merged;
  for (const [name, value] of Object.entries(own)) if (typeof value === 'string') merged[name] = value;
  return merged;
}

/** A tool's arguments when no argument is required: `{}`, so a read-only probe changes nothing. */
function canProbe(tool: McpTool): boolean {
  if (!isRecord(tool.outputSchema)) return false;
  const annotations = isRecord(tool.annotations) ? tool.annotations : {};
  if (annotations.readOnlyHint !== true) return false;
  const schema = isRecord(tool.inputSchema) ? tool.inputSchema : {};
  return !Array.isArray(schema.required) || schema.required.length === 0;
}

/**
 * Start one stdio server and read its tools. It stops the child before it returns, and
 * every answer is kept: a server that never starts, one that never answers, and one that
 * writes a log line are all findings, never a crash.
 */
export function readServerTools(entry: McpServerEntry, { root, env, timeoutMs = 15000 }: { root: string; env: Env; timeoutMs?: number }): Promise<ServerRead> {
  const command = typeof entry.command === 'string' ? entry.command : '';
  const args = Array.isArray(entry.args) ? entry.args.filter((arg): arg is string => typeof arg === 'string') : [];
  if (!command) {
    return Promise.resolve({ tools: [], stdout: [], probes: [], isReady: false, probed: 0, error: finding('mcp-server', 'a server has no command', 'give each stdio server a command and its args') });
  }
  return new Promise((resolve) => {
    const lines: string[] = [];
    const probes: Finding[] = [];
    let tools: unknown[] = [];
    let isReady = false;
    let probed = 0;
    let pending = new Set<number>();
    let buffer = '';
    let isDone = false;
    let probeNames = new Map<number, string>();

    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(command, args, { cwd: root, env: serverEnvironment(env, entry.env), stdio: ['pipe', 'pipe', 'pipe'], shell: false, windowsHide: true });
    } catch {
      resolve({ tools, stdout: [], probes, isReady, probed, error: finding('mcp-server', `server cannot start: ${command}`, 'check the command and its args in the config; on Windows, npx and .cmd files need cmd /c') });
      return;
    }

    const finish = (error?: Finding) => {
      if (isDone) return;
      isDone = true;
      clearTimeout(timer);
      try {
        child.kill('SIGTERM');
      } catch {
        // The child is gone: nothing to stop.
      }
      if (typeof child.pid === 'number') {
        const kill = setTimeout(() => {
          try {
            child.kill('SIGKILL');
          } catch {
            // The child is gone: nothing to stop.
          }
        }, 500);
        kill.unref();
      }
      resolve({ tools, stdout: lintStdout(lines), probes, error: error ?? (isReady ? undefined : finding('mcp-server', `server "${command}" did not answer initialize and tools/list`, 'start it by hand, fix the error it prints on stderr, then run the check again')), isReady, probed });
    };

    const timer = setTimeout(() => finish(), timeoutMs);
    timer.unref();

    child.on('error', (error: NodeJS.ErrnoException) => {
      const message = error.code === 'ENOENT' ? `server command not found: ${command}` : `server cannot start: ${command}`;
      finish(finding('mcp-server', message, 'check the command in the config; on Windows, npx and .cmd files need cmd /c'));
    });
    child.on('close', () => {
      if (isDone) return;
      finish(isReady ? undefined : finding('mcp-server', `server "${command}" exited before tools/list`, 'run the command by hand and fix the error it prints on stderr'));
    });
    child.stdin?.on('error', () => {
      // A closed stdin is the exit above; the check already says what to do.
    });
    child.stderr?.on('data', () => {
      // Kept out of the report: stderr may hold a path or a secret, and it never breaks a client.
    });

    const send = (request: Request) => {
      if (!child.stdin?.writable) return;
      child.stdin.write(encode(request));
    };
    const notify = (method: string) => {
      if (!child.stdin?.writable) return;
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method })}\n`);
    };
    const sendInitialize = () => send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'yokoten', version: '1' } } });
    const sendToolList = () => {
      pending.add(2);
      send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
    };

    const askProbes = () => {
      const list = tools.filter(isRecord) as McpTool[];
      for (const tool of list) {
        if (!canProbe(tool) || typeof tool.name !== 'string') continue;
        const id = 3 + probeNames.size;
        probeNames.set(id, tool.name);
        pending.add(id);
        send({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: tool.name, arguments: {} } });
      }
    };

    const readMessage = (message: unknown) => {
      if (!isRecord(message)) return;
      const id = typeof message.id === 'number' ? message.id : null;
      if (id === null) return;
      if (id === 1) {
        pending.delete(id);
        if ('error' in message) {
          finish(finding('mcp-server', 'server refuses initialize', 'read the server log on stderr, and update its protocol version'));
          return;
        }
        notify('notifications/initialized');
        sendToolList();
        return;
      }
      if (id === 2) {
        pending.delete(2);
        const result = isRecord(message.result) ? message.result : {};
        tools = Array.isArray(result.tools) ? result.tools : [];
        isReady = true;
        askProbes();
        if (!pending.size) finish();
        return;
      }
      const name = probeNames.get(id);
      if (name === undefined) return;
      pending.delete(id);
      if (isRecord(message.result)) {
        probed++;
        probes.push(...lintCallResult(name, message.result));
      }
      if (!pending.size && isReady) finish();
    };

    child.stdout?.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8');
      let newline = buffer.indexOf('\n');
      while (newline !== -1) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        lines.push(line);
        const text = line.endsWith('\r') ? line.slice(0, -1) : line;
        if (text.trim() !== '') {
          try {
            readMessage(JSON.parse(text));
          } catch {
            // lintStdout names it; the client goes on, as a tolerant client does.
          }
        }
        newline = buffer.indexOf('\n');
      }
    });

    pending.add(1);
    sendInitialize();
  });
}


/** What one server's run found, as the text and JSON forms both read it. */
interface ServerReport {
  name: string;
  file: string;
  tools: number;
  metrics: ToolMetrics;
  probed: number;
  findings: Finding[];
  notes: Finding[];
  skipped?: string;
}

/** Whether a server entry starts over stdio, the only transport this check can start. */
function isStdio(entry: McpServerEntry): boolean {
  if (typeof entry.url === 'string') return false;
  return entry.type === undefined || entry.type === 'stdio';
}

/** The tools of one config entry, and every finding (what fails) and note (what only warns) it earns. */
async function checkServer(server: McpServer, { root, env }: { root: string; env: Env }): Promise<ServerReport> {
  const notes = lintServerEntry(server.name, server.entry);
  const empty = { count: 0, bytes: 0, longestDescription: 0, withOutputSchema: 0 };
  if (!isStdio(server.entry)) {
    return { name: server.name, file: server.file, tools: 0, metrics: empty, probed: 0, findings: [], notes, skipped: 'starts over HTTP, so this check cannot start it' };
  }
  const read: ServerRead = await readServerTools(server.entry, { root, env });
  const findings = [...(read.error ? [read.error] : []), ...lintTools(read.tools), ...read.probes, ...read.stdout];
  return { name: server.name, file: server.file, tools: read.tools.length, metrics: toolMetrics(read.tools), probed: read.probed, findings, notes };
}

/** One server's line in the text form. */
function serverLine(report: ServerReport): string {
  if (report.skipped) return `- server "${report.name}" (${report.file}): ${report.skipped}`;
  return `- server "${report.name}" (${report.file}): ${report.tools} tool(s), ${report.metrics.bytes} B of definitions, longest description ${report.metrics.longestDescription} characters, ${report.metrics.withOutputSchema} with outputSchema, ${report.probed} probed`;
}

export async function runMcp(invocation: Invocation): Promise<number> {
  const options = parse('mcp', invocation.args);
  if (typeof options === 'string') return usage(invocation, options);
  const json = options.flags.has('--json');
  const dir = options.positional[0] ?? invocation.cwd;
  const root = requireRoot(invocation, dir, json ? (missing) => ({ check: 'mcp', ok: false, findings: [missing], notes: [] }) : undefined);
  if (!root) return 1;

  const config = readMcpConfig(root);
  const command = options.values['--command'];
  let servers: McpServer[] = config.servers;
  if (command) {
    const [name, ...args] = command.trim().split(/\s+/);
    servers = name ? [{ name: 'command line', entry: { command: name, args }, file: '--command' }] : [];
  }
  const configFindings = config.problems;
  if (!servers.length) {
    const looked = CONFIG_FILES.join(', ');
    const what = `no MCP server found in ${looked}`;
    if (json) printJson(invocation, { check: 'mcp', ok: true, skipped: what, findings: configFindings, notes: [] });
    else print(invocation, [`yokoten mcp: ${what}. Name one with --command "node path/to/server.ts"`]);
    return configFindings.some(isFailingFinding) ? 1 : 0;
  }

  const reports: ServerReport[] = [];
  for (const server of servers) reports.push(await checkServer(server, { root, env: invocation.env }));
  const findings = [...configFindings, ...reports.flatMap((report) => report.findings)];
  const notes = reports.flatMap((report) => report.notes);
  const problems = findings.filter(isFailingFinding);
  const warnings = [...findings.filter((item) => !isFailingFinding(item)), ...notes];
  const toolCount = reports.reduce((sum, report) => sum + report.tools, 0);

  if (json) {
    printJson(invocation, {
      check: 'mcp',
      ok: !problems.length,
      servers: reports,
      findings: problems,
      notes: warnings,
    });
  } else if (!problems.length) {
    print(invocation, [`yokoten mcp: ok (${reports.length} server(s), ${toolCount} tool(s))`, ...reports.map(serverLine)]);
    if (warnings.length) print(invocation, [`yokoten mcp: note: ${warnings.length} warning(s)`, ...bullets(warnings)]);
  } else {
    print(invocation, [`yokoten mcp: ${problems.length} problem(s)`, ...reports.map(serverLine), ...bullets(problems), ...(warnings.length ? [`notes:`, ...bullets(warnings)] : [])], invocation.stderr);
  }
  return problems.length ? 1 : 0;
}
