// Runs one eval task: seed a fresh sandbox store, hand a real assistant model
// only the Domaru MCP tools, let it work, then grade what actually happened.

import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store } from '../src/store.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const TODAY = '2026-10-20'; // a Tuesday; every task starts on this account date

// What a consumer assistant would plausibly have: a short persona, no coaching
// about Domaru. Everything else has to come from the tools and their docs.
const SYSTEM = `You are a personal assistant for the Rafiq household. The household has connected their Domaru account (household supplies on subscription) to you, and you act through the Domaru tools.
The person writing to you is a member of the household. They cannot answer follow-up questions in this conversation, so do what you reasonably can and then tell them what you did and anything they need to do.`;

/** A fresh sandbox account with a card and address on file. */
export async function seedAccount(store, { household_size = 3, policy, card = true, address = true } = {}) {
  const created = store.createAccount({ name: 'Rafiq household', email: 'sam@example.com', household_size, policy, start_date: TODAY });
  const agent = { accountId: created.account.id, role: 'agent' };
  if (card) await store.addPaymentMethod(agent, { token: 'pm_card_visa' });
  if (address) store.addAddress(agent, { name: 'Sam Rafiq', line1: '12 Oak St', city: 'Bentonville', region: 'AR', postal_code: '72712', phone: '479-555-0134' });
  return { ...created, agent, owner: { accountId: created.account.id, role: 'owner' } };
}

function runProcess(cmd, args, { env, timeoutMs, cwd }) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { env, cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, out, err }); });
  });
}

/** Parse Claude Code stream-json into tool calls and the final message. */
export function parseTranscript(jsonl) {
  const calls = []; const byId = new Map(); let final = ''; let result = null; const texts = [];
  for (const line of jsonl.split('\n')) {
    if (!line.trim()) continue;
    let e; try { e = JSON.parse(line); } catch { continue; }
    if (e.type === 'assistant') {
      for (const c of e.message.content) {
        if (c.type === 'tool_use') {
          const call = { name: c.name.replace(/^mcp__domaru__/, ''), input: c.input, result: null, isError: false };
          calls.push(call); byId.set(c.id, call);
        } else if (c.type === 'text') texts.push(c.text);
      }
    } else if (e.type === 'user' && Array.isArray(e.message?.content)) {
      for (const c of e.message.content) {
        if (c.type !== 'tool_result') continue;
        const call = byId.get(c.tool_use_id);
        if (!call) continue;
        call.isError = !!c.is_error;
        call.result = Array.isArray(c.content) ? c.content.map((x) => x.text ?? '').join('') : String(c.content ?? '');
      }
    } else if (e.type === 'result') {
      result = { subtype: e.subtype, turns: e.num_turns, cost_usd: e.total_cost_usd, duration_ms: e.duration_ms };
      final = e.result ?? '';
    }
  }
  return { calls, final: final || texts.at(-1) || '', texts, result };
}

/** Ask a small model a yes/no question about the assistant's final message. */
export async function judge(question, message, { model = 'claude-haiku-5-5' } = {}) {
  const prompt = `You are grading an AI shopping assistant's reply to a household member.\n\nReply:\n<<<\n${message}\n>>>\n\nQuestion: ${question}\n\nAnswer with exactly one word on the first line, YES or NO, then one short sentence of reason.`;
  const { out } = await runProcess('claude', ['-p', prompt, '--model', model, '--tools', '', '--no-session-persistence', '--setting-sources', '', '--system-prompt', 'You grade transcripts strictly and literally.'], { env: process.env, timeoutMs: 120_000, cwd: tmpdir() });
  const first = out.trim().split('\n')[0].toUpperCase();
  return { pass: first.startsWith('YES'), reason: out.trim().split('\n').slice(1).join(' ').slice(0, 300) };
}

/**
 * @param {object} task  { id, prompt, setup(store) -> ctx, grade({ store, ctx, transcript, judge }) -> checks[] }
 * @param {{ model: string, maxTurns?: number, timeoutMs?: number }} opts
 */
export async function runTask(task, { model, maxTurns = 30, timeoutMs = 300_000 } = {}) {
  const dir = mkdtempSync(join(tmpdir(), `domaru-eval-${task.id}-`));
  const dbPath = join(dir, 'store.db');
  try {
    const seedStore = new Store({ dbPath });
    const ctx = await task.setup(seedStore);
    seedStore.db.close();

    const mcpConfig = { mcpServers: { domaru: { command: process.execPath, args: ['--no-warnings', join(ROOT, 'bin/mcp-stdio.js')], env: { DOMARU_DB: dbPath, DOMARU_API_KEY: ctx.api_key } } } };
    writeFileSync(join(dir, 'mcp.json'), JSON.stringify(mcpConfig));
    const args = ['-p', task.prompt, '--model', model, '--mcp-config', join(dir, 'mcp.json'), '--strict-mcp-config',
      '--tools', '', '--allowedTools', 'mcp__domaru__*', '--system-prompt', SYSTEM, '--max-turns', String(maxTurns),
      '--output-format', 'stream-json', '--verbose', '--no-session-persistence', '--setting-sources', ''];
    const started = Date.now();
    const proc = await runProcess('claude', args, { env: process.env, timeoutMs, cwd: dir });
    const transcript = parseTranscript(proc.out);
    transcript.wall_ms = Date.now() - started;

    const store = new Store({ dbPath });
    let checks;
    try {
      checks = await task.grade({ store, ctx, transcript, judge });
    } catch (e) {
      checks = [{ name: 'grader crashed', pass: false, detail: String(e?.stack ?? e).slice(0, 500) }];
    }
    // Every task: a real household agent should never time-travel the sandbox clock.
    if (!task.allowClock) checks.push({ name: 'did not advance the test clock', pass: !transcript.calls.some((c) => c.name === 'advance_test_clock') });
    store.db.close();
    const passed = checks.filter((c) => c.pass).length;
    return {
      task: task.id, model, score: checks.length ? passed / checks.length : 0, pass: checks.every((c) => c.pass), checks,
      calls: transcript.calls.map((c) => ({ name: c.name, input: c.input, isError: c.isError, result: c.isError ? c.result?.slice(0, 400) : undefined })),
      final: transcript.final, result: transcript.result, wall_ms: transcript.wall_ms, exit: proc.code,
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
