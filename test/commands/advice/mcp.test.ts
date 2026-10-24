// Tests for src/commands/advice/mcp.ts: one positive control per MCP trap, the stdio
// client, and the command's text and JSON forms (#370).

import '../../repo/home.ts';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  HINTS,
  lintCallResult,
  lintServerEntry,
  lintStdout,
  lintTools,
  needsWindowsShell,
  readMcpConfig,
  readServerTools,
  toolMetrics,
} from '../../../src/commands/advice/mcp.ts';
import { MCP_SAMPLE_SERVER, makeSandbox, makeTempDir } from '../../repo/helpers.ts';

const hints = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const schema = { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] };
const tool = (inputSchema: unknown = schema, name = 'read') => ({ name, description: 'Read one value', inputSchema, annotations: hints });
const ids = (tools: unknown[]) => lintTools(tools).map((finding) => finding.id);
const says = (tools: unknown[], text: RegExp) => lintTools(tools).some((finding) => text.test(`${finding.what} ${finding.fix}`));

test('mcp: a clean tool list passes, and its size and longest description are reported', () => {
  const tools = [tool(), { ...tool(), name: 'status', description: 'Short' }];
  assert.deepEqual(lintTools(tools), []);
  const metrics = toolMetrics(tools);
  assert.equal(metrics.count, 2);
  assert.ok(metrics.bytes > 100);
  assert.equal(metrics.longestDescription, 'Read one value'.length);
  assert.equal(metrics.withOutputSchema, 0);
});

test('mcp-schema: Claude rejects a root anyOf, oneOf or allOf', () => {
  for (const branch of ['anyOf', 'oneOf', 'allOf']) {
    assert.ok(says([tool({ [branch]: [{ type: 'string' }, { type: 'number' }] })], /root anyOf|root oneOf|root allOf/), branch);
  }
  assert.ok(!says([tool({ type: 'object', properties: { value: { anyOf: [{ type: 'string' }] } } })], /root anyOf/), 'a nested branch is allowed');
});

test('mcp-schema: Gemini rejects $ref, $defs, a list of types, and an array without items', () => {
  assert.ok(says([tool({ type: 'object', properties: { value: { $ref: '#/$defs/v' } } })], /\$ref/));
  assert.ok(says([tool({ type: 'object', $defs: { value: { type: 'string' } } })], /\$defs/));
  assert.ok(says([tool({ type: 'object', properties: { value: { type: ['string', 'null'] } } })], /list of types/));
  assert.ok(says([tool({ type: 'object', properties: { values: { type: 'array' } } })], /no items/));
  assert.deepEqual(ids([tool({ type: 'object', properties: { values: { type: 'array', items: { type: 'string' } } }, required: ['values'] })]), []);
});

test('mcp-schema: OpenAI strict needs every property in required', () => {
  assert.ok(says([tool({ type: 'object', properties: { a: { type: 'string' }, b: { type: 'number' } }, required: ['a'] })], /leaves 1 property out of required at the root \(b\)/));
  assert.deepEqual(lintTools([tool({ type: 'object', properties: { a: { type: 'string' } }, required: ['a'] })]), []);
});

test('mcp-name: a bad property name and a tool name over 64 are reported', () => {
  assert.ok(says([tool({ type: 'object', properties: { 'session id': { type: 'string' } } })], /session id/));
  assert.ok(ids([tool(schema, 'n'.repeat(65))]).includes('mcp-name'));
  assert.ok(ids([tool(schema, '')]).includes('mcp-name'));
});

test('mcp-annotations: all four hints are set on every tool', () => {
  const without = { name: 'write', description: 'Write', inputSchema: schema };
  const problems = lintTools([without]);
  assert.equal(problems.filter((finding) => finding.id === 'mcp-annotations').length, 1);
  assert.match(problems[0].what, new RegExp(HINTS.join(', ')));
  assert.deepEqual(lintTools([{ ...without, annotations: hints }]), []);
});

test('mcp-count: 40 tools is over the small client window', () => {
  const many = Array.from({ length: 40 }, (_, i) => tool(schema, `tool_${i}`));
  assert.ok(ids(many).includes('mcp-count'));
  assert.ok(!ids(many.slice(0, 39)).includes('mcp-count'));
});

test('mcp-output: an outputSchema needs structuredContent and a text item', () => {
  const noText = lintCallResult('status', { structuredContent: { reply: 'ok' } });
  assert.equal(noText.length, 1);
  assert.match(noText[0].what, /no text content/);
  const noStructured = lintCallResult('status', { content: [{ type: 'text', text: 'ok' }] });
  assert.equal(noStructured.length, 1);
  assert.match(noStructured[0].what, /no structuredContent/);
  assert.deepEqual(lintCallResult('status', { structuredContent: { reply: 'ok' }, content: [{ type: 'text', text: 'ok' }] }), []);
  assert.deepEqual(lintCallResult('status', { isError: true }), [], 'an error result is not judged');
});

test('mcp-windows: npx and .cmd entries warn, with cmd /c as the fix', () => {
  assert.equal(needsWindowsShell('npx'), true);
  assert.equal(needsWindowsShell('npm'), true);
  assert.equal(needsWindowsShell('C:\\tools\\server.cmd'), true);
  assert.equal(needsWindowsShell('node'), false);
  assert.equal(needsWindowsShell('cmd'), false);
  const warning = lintServerEntry('demo', { command: 'npx', args: ['-y', 'demo'] });
  assert.equal(warning.length, 1);
  assert.equal(warning[0].grade, 'likely');
  assert.match(warning[0].fix, /cmd.*\/c/);
  assert.deepEqual(lintServerEntry('demo', { command: 'node', args: ['server.ts'] }), []);
  assert.deepEqual(lintServerEntry('web', { url: 'https://example.com/mcp' }), []);
});

test('mcp-stdout: only JSON-RPC lines pass; text, JSON logs, CRLF and broken UTF-8 are reported', () => {
  const clean = ['{"jsonrpc":"2.0","id":1,"result":{}}', '{"jsonrpc":"2.0","method":"notifications/initialized"}'];
  assert.deepEqual(lintStdout(clean), []);
  assert.equal(lintStdout(['starting server'])[0].id, 'mcp-stdout');
  assert.match(lintStdout(['{"level":"info"}'])[0].what, /JSON but not a JSON-RPC/);
  assert.match(lintStdout(['{"jsonrpc":"2.0","id":1,"result":{}}\r'])[0].what, /CRLF/);
  assert.match(lintStdout(['\uFFFD'])[0].what, /not UTF-8/);
  assert.deepEqual(lintStdout(['']), [], 'a trailing empty line is not a trap');
});

/** A temp project with the sample server written into it. */
function sampleProject(): string {
  const root = makeTempDir('mcp-');
  writeFileSync(join(root, 'server.ts'), MCP_SAMPLE_SERVER);
  return root;
}

const env = () => ({ ...process.env });

test('mcp run: a clean server answers initialize and tools/list, and both result forms pass', async () => {
  const root = sampleProject();
  const read = await readServerTools({ command: process.execPath, args: [join(root, 'server.ts'), 'clean'] }, { root, env: env(), timeoutMs: 5000 });
  assert.equal(read.isReady, true, read.error?.what);
  assert.equal(read.tools.length, 2);
  assert.deepEqual(lintTools(read.tools), []);
  assert.deepEqual(read.stdout, []);
  assert.equal(read.probed, 1, 'the status tool is read-only and takes no required argument');
  assert.deepEqual(read.probes, []);
  assert.equal(read.error, undefined);
});

test('mcp run: a trap server is reported for each trap, and the client still reads its tools', async () => {
  const root = sampleProject();
  const read = await readServerTools({ command: process.execPath, args: [join(root, 'server.ts'), 'traps'] }, { root, env: env(), timeoutMs: 5000 });
  assert.equal(read.isReady, true, read.error?.what);
  assert.equal(read.tools.length, 40);
  const problems = lintTools(read.tools);
  for (const id of ['mcp-schema', 'mcp-name', 'mcp-annotations', 'mcp-count']) assert.ok(problems.some((finding) => finding.id === id), id);
  assert.equal(read.probes.length, 1, 'result_only is the only read-only tool with an outputSchema');
  assert.match(read.probes[0].what, /no text content/);
  assert.ok(read.stdout.some((finding) => /not JSON-RPC/.test(finding.what)));
  assert.ok(read.stdout.some((finding) => /not UTF-8/.test(finding.what)));
  assert.ok(read.stdout.some((finding) => /CRLF/.test(finding.what)));
});

test('mcp run: a command that is not there is one finding, not a crash', async () => {
  const root = makeTempDir('mcp-');
  const read = await readServerTools({ command: 'yokoten-no-such-command-370', args: [] }, { root, env: env(), timeoutMs: 2000 });
  assert.equal(read.isReady, false);
  assert.equal(read.tools.length, 0);
  assert.match(read.error?.what ?? '', /not found/);
});

test('mcp run: both config shapes are read, and a broken file is a finding', () => {
  const root = makeTempDir('mcp-');
  writeFileSync(join(root, '.mcp.json'), JSON.stringify({ mcpServers: { one: { command: 'node', args: ['one.ts'] } } }));
  writeFileSync(join(root, 'mcp.json'), JSON.stringify({ servers: { two: { command: 'node', args: ['two.ts'] } } }));
  const config = readMcpConfig(root);
  assert.deepEqual(config.servers.map((server) => server.name).sort(), ['one', 'two']);
  assert.deepEqual(config.problems, []);
  assert.equal(config.servers[0].file, '.mcp.json');
  writeFileSync(join(root, 'mcp.json'), '{not json');
  const broken = readMcpConfig(root);
  assert.equal(broken.servers.length, 1);
  assert.match(broken.problems[0].what, /not JSON/);
});

/** A sandbox with the sample server written in, and one config entry for it. */
function mcpProject(mode: string) {
  const sandbox = makeSandbox();
  sandbox.write('server.ts', MCP_SAMPLE_SERVER);
  sandbox.write('.mcp.json', JSON.stringify({ mcpServers: { sample: { command: process.execPath, args: [join(sandbox.repo, 'server.ts'), mode] } } }));
  return sandbox;
}

test('mcp command: a clean server passes, in the text and JSON forms', async () => {
  const sandbox = mcpProject('clean');
  const result = await sandbox.call(['mcp']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /yokoten mcp: ok \(1 server\(s\), 2 tool\(s\)\)/);
  assert.match(result.stdout, /2 tool\(s\), \d+ B of definitions, longest description \d+ characters/);
  const json = await sandbox.call(['mcp', '--json']);
  assert.equal(json.status, 0, json.stderr);
  const report = JSON.parse(json.stdout);
  assert.equal(report.ok, true);
  assert.equal(report.servers[0].tools, 2);
  assert.deepEqual(report.findings, []);
});

test('mcp command: each trap is reported with what, why and fix, and the command exits 1', async () => {
  const sandbox = mcpProject('traps');
  const result = sandbox.run(['mcp', '--json']);
  assert.equal(result.status, 1);
  const report = JSON.parse(result.stdout);
  const findings = report.findings.map((item: { id: string }) => item.id);
  for (const id of ['mcp-schema', 'mcp-name', 'mcp-annotations', 'mcp-count', 'mcp-output', 'mcp-stdout']) {
    assert.ok(findings.includes(id), id);
  }
  assert.ok(report.findings.every((item: { what: string; why: string; fix: string }) => item.what && item.why && item.fix), 'every finding has what, why and fix');
  assert.ok(report.findings.some((item: { what: string }) => /root anyOf/.test(item.what)));
  assert.ok(report.findings.some((item: { what: string }) => /no text content/.test(item.what)));
  const text = await sandbox.call(['mcp']);
  assert.equal(text.status, 1);
  assert.match(text.stderr, /write logs to stderr/i);
  assert.match(text.stderr, /docs: https:\/\/github\.com\/yokoten-labs\/yokoten\/blob\/main\/docs\/guide\.md#shipping-an-mcp-server-that-works-in-every-agent/);
});

test('mcp command: --command runs a server that has no config entry', async () => {
  const sandbox = makeSandbox();
  sandbox.write('server.ts', MCP_SAMPLE_SERVER);
  const command = `${process.execPath} ${join(sandbox.repo, 'server.ts')} clean`;
  const result = await sandbox.call(['mcp', '--command', command]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /server "command line"/);
});

test('mcp command: a Windows-only launch is a warning, even when the server cannot start here', async () => {
  const sandbox = makeSandbox();
  sandbox.write('.mcp.json', JSON.stringify({ servers: { win: { command: 'demo.cmd', args: [] } } }));
  const result = await sandbox.call(['mcp', '--json']);
  const report = JSON.parse(result.stdout);
  assert.ok(report.notes.some((item: { id: string }) => item.id === 'mcp-windows'));
  assert.ok(report.findings.some((item: { id: string }) => item.id === 'mcp-server'));
});

test('mcp command: a project with no MCP server is skipped, not failed', async () => {
  const sandbox = makeSandbox();
  const result = await sandbox.call(['mcp', '--json']);
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.ok, true);
  assert.match(report.skipped, /no MCP server found/);
});
