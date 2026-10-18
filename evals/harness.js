// Runs one eval task: seed a fresh sandbox store, hand a real assistant model
// only the Domaru MCP tools (or, with surface "rest", only curl and the REST
// API), let it work, then grade what actually happened.

import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomBytes } from 'node:crypto';
import { Store } from '../src/store.js';
import { startServer } from '../src/http.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
// Accounts start on the real date, so the store's clock agrees with the date the
// model already knows. Tasks phrase their dates relative to it.
export const TODAY = new Date().toISOString().slice(0, 10);
export const addDays = (date, n) => { const d = new Date(`${date}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
export const human = (date) => new Date(`${date}T00:00:00Z`).toLocaleDateString('en-US', { month: 'long', day: 'numeric', timeZone: 'UTC' });
export const nextMonday = (date) => { const dow = new Date(`${date}T00:00:00Z`).getUTCDay(); return addDays(date, ((8 - dow) % 7) || 7); };

// What a consumer assistant would plausibly have: a short persona, no coaching
// about Domaru. Everything else has to come from the tools and their docs.
const SYSTEM = `You are a personal assistant for the Rafiq household. The household has connected their Domaru account (household supplies on subscription) to you, and you act through the Domaru tools.
The person writing to you is a member of the household. They cannot answer follow-up questions in this conversation, so do what you reasonably can and then tell them what you did and anything they need to do.`;

/**
 * A household that has already connected Domaru to its assistant: the owner
 * accepted the terms, saved a card and address, set limits, and tapped Allow.
 * The assistant holds only the OAuth access token from that Connect flow.
 */
export async function seedAccount(store, { household_size = 3, policy, card = 'pm_card_visa', address = true } = {}) {
  const created = store.createAccount({ name: 'Rafiq household', email: 'sam@example.com', household_size, start_date: TODAY });
  const accountId = created.account.id;
  const owner = { accountId, role: 'owner' };
  store.acceptTerms(owner);
  if (policy) store.updatePolicy(owner, policy);
  if (card) await store.addPaymentMethod(owner, { token: card });
  if (address) store.addAddress(owner, { name: 'Sam Rafiq', line1: '12 Oak St', city: 'Bentonville', region: 'AR', postal_code: '72712', phone: '479-555-0134' });

  const redirect = 'http://localhost:7777/callback';
  const client = store.registerClient({ client_name: 'Eval assistant', redirect_uris: [redirect] });
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  const code = store.createAuthCode(owner, { client_id: client.client_id, redirect_uri: redirect, code_challenge: challenge, code_challenge_method: 'S256' });
  const token = store.oauthToken({ grant_type: 'authorization_code', code, code_verifier: verifier, client_id: client.client_id, redirect_uri: redirect });
  const agent = store.authenticate(token.access_token);
  return { account: created.account, api_key: token.access_token, agent, owner };
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
export async function judge(question, message, { model = process.env.EVAL_JUDGE_MODEL ?? 'claude-sonnet-5-5' } = {}) {
  const prompt = `You are grading an AI shopping assistant's reply to a household member. Judge only the question asked, literally. Today's date is ${TODAY}.\n\nReply:\n<<<\n${message}\n>>>\n\nQuestion: ${question}\n\nThink briefly, then end with a final line that is exactly "VERDICT: YES" or "VERDICT: NO".`;
  const { out } = await runProcess('claude', ['-p', prompt, '--model', model, '--tools', '', '--no-session-persistence', '--setting-sources', '', '--system-prompt', 'You grade assistant replies strictly and literally.'], { env: process.env, timeoutMs: 180_000, cwd: tmpdir() });
  const verdicts = [...out.matchAll(/VERDICT:\s*(YES|NO)/gi)];
  const last = verdicts.at(-1)?.[1]?.toUpperCase();
  return { pass: last === 'YES', reason: out.replace(/VERDICT:\s*(YES|NO)/gi, '').trim().replace(/\s+/g, ' ').slice(0, 300) || 'judge gave no verdict' };
}

/**
 * @param {object} task  { id, prompt, setup(store) -> ctx, grade({ store, ctx, transcript, judge }) -> checks[] }
 * @param {{ model: string, maxTurns?: number, timeoutMs?: number }} opts
 */
// REST calls are graded like the MCP tools they match.
const REST_TOOLS = [
  ['GET', /^\/v1\/categories$/, 'list_categories'], ['GET', /^\/v1\/products$/, 'search_products'], ['GET', /^\/v1\/products\/[^/]+$/, 'get_product'],
  ['POST', /^\/v1\/recommendations$/, 'recommend_bundle'], ['GET', /^\/v1\/account$/, 'get_account'], ['PATCH', /^\/v1\/account$/, 'update_household'],
  ['POST', /^\/v1\/payment_methods$/, 'add_payment_method'], ['POST', /^\/v1\/payment_methods\/setup_link$/, 'create_card_setup_link'],
  ['POST', /^\/v1\/payment_methods\/bank_setup_link$/, 'create_bank_setup_link'],
  ['GET', /^\/v1\/payment_methods$/, 'list_payment_methods'], ['POST', /^\/v1\/addresses$/, 'add_address'], ['GET', /^\/v1\/addresses$/, 'list_addresses'],
  ['POST', /^\/v1\/quotes$/, 'quote'], ['POST', /^\/v1\/subscriptions$/, 'create_subscription'], ['GET', /^\/v1\/subscriptions$/, 'list_subscriptions'],
  ['GET', /^\/v1\/subscriptions\/[^/]+$/, 'get_subscription'], ['PATCH', /^\/v1\/subscriptions\/[^/]+$/, 'update_subscription'],
  ['POST', /\/pause$/, 'pause_subscription'], ['POST', /\/resume$/, 'resume_subscription'], ['POST', /\/skip$/, 'skip_next_delivery'], ['POST', /\/ship_now$/, 'ship_now'],
  ['POST', /\/supply_signal$/, 'report_supply_level'], ['POST', /^\/v1\/subscriptions\/[^/]+\/cancel$/, 'cancel_subscription'],
  ['POST', /^\/v1\/orders$/, 'place_order'], ['GET', /^\/v1\/orders$/, 'list_orders'], ['GET', /^\/v1\/orders\/[^/]+$/, 'get_order'],
  ['POST', /^\/v1\/orders\/[^/]+\/cancel$/, 'cancel_order'], ['POST', /\/problems$/, 'report_problem'], ['GET', /^\/v1\/cases/, 'list_cases'],
  ['GET', /^\/v1\/approvals$/, 'list_approvals'], ['POST', /^\/v1\/approvals\//, 'decide_approval'], ['GET', /^\/v1\/events$/, 'list_events'],
  ['POST', /^\/v1\/test\/clock\/advance$/, 'advance_test_clock'],
];

/** Turn curl commands in a transcript into the MCP tool calls they correspond to. */
export function restCalls(calls) {
  const out = [];
  for (const c of calls) {
    let cmd = String(c.input?.command ?? '');
    // Resolve shell variables that hold the base URL (B=http://...; curl "$B/v1/...").
    for (const [, name, val] of cmd.matchAll(/\b([A-Za-z_]\w*)=["']?(https?:\/\/[^\s"';]+)/g)) cmd = cmd.replace(new RegExp(`\\$\\{?${name}\\}?(?!\\w)`, 'g'), val);
    for (const m of cmd.matchAll(/curl\b[^|;&]*/g)) {
      const part = m[0];
      const url = /https?:\/\/[^\s'"]+/.exec(part)?.[0];
      if (!url) continue;
      let path; try { path = new URL(url).pathname; } catch { continue; } // e.g. a shell variable in the URL
      const body = /(?:-d|--data(?:-raw)?)\s+(?:'([^']*)'|"((?:[^"\\]|\\.)*)")/.exec(part);
      const method = (/-X\s*(\w+)/.exec(part)?.[1] ?? (body ? 'POST' : 'GET')).toUpperCase();
      const tool = REST_TOOLS.find(([mm, re]) => mm === method && re.test(path))?.[2] ?? `${method} ${path}`;
      let input = {};
      try { input = body ? JSON.parse(body[1] ?? body[2].replace(/\\"/g, '"')) : Object.fromEntries(new URL(url).searchParams); } catch { /* not JSON */ }
      out.push({ name: tool, input, result: c.result, isError: c.isError, command: part.slice(0, 600) });
    }
  }
  return out;
}

const restSystem = (base, key) => `${SYSTEM}
Domaru has no tools in this conversation. Use its HTTP API with curl: base URL ${base}, and send the header "Authorization: Bearer ${key}" on every request. Start by reading ${base}/llms.txt (the OpenAPI spec is at ${base}/openapi.json).`;

export async function runTask(task, { model, maxTurns = 30, timeoutMs = 300_000, surface = 'mcp' } = {}) {
  const dir = mkdtempSync(join(tmpdir(), `domaru-eval-${task.id}-`));
  const dbPath = join(dir, 'store.db');
  let server; let serverStore;
  try {
    const seedStore = new Store({ dbPath });
    const ctx = await task.setup(seedStore);
    seedStore.db.close();

    let args;
    if (surface === 'rest') {
      serverStore = new Store({ dbPath });
      server = await startServer(serverStore, { port: 0, host: '127.0.0.1' });
      const base = `http://127.0.0.1:${server.address().port}`;
      serverStore.publicUrl = base;
      args = ['-p', task.prompt, '--model', model, '--tools', 'Bash', '--allowedTools', 'Bash(curl:*)', '--system-prompt', restSystem(base, ctx.api_key)];
    } else {
      const mcpConfig = { mcpServers: { domaru: { command: process.execPath, args: ['--no-warnings', join(ROOT, 'bin/mcp-stdio.js')], env: { DOMARU_DB: dbPath, DOMARU_API_KEY: ctx.api_key } } } };
      writeFileSync(join(dir, 'mcp.json'), JSON.stringify(mcpConfig));
      args = ['-p', task.prompt, '--model', model, '--mcp-config', join(dir, 'mcp.json'), '--strict-mcp-config', '--tools', '', '--allowedTools', 'mcp__domaru__*', '--system-prompt', SYSTEM];
    }
    args.push('--max-turns', String(maxTurns), '--output-format', 'stream-json', '--verbose', '--no-session-persistence', '--setting-sources', '');
    const started = Date.now();
    const proc = await runProcess('claude', args, { env: process.env, timeoutMs, cwd: dir });
    const transcript = parseTranscript(proc.out);
    transcript.wall_ms = Date.now() - started;
    if (surface === 'rest') {
      transcript.calls = restCalls(transcript.calls);
      await new Promise((r) => server.close(r)); server = null;
      serverStore.db.close(); serverStore = null;
    }

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
      task: task.id, model, surface, score: checks.length ? passed / checks.length : 0, pass: checks.every((c) => c.pass), checks,
      calls: transcript.calls.map((c) => ({ name: c.name, input: c.input, isError: c.isError, ...(c.command ? { command: c.command } : {}), result: c.isError ? String(c.result ?? '').slice(0, 400) : undefined })),
      final: transcript.final, result: transcript.result, wall_ms: transcript.wall_ms, exit: proc.code,
    };
  } finally {
    if (server) server.close();
    if (serverStore) serverStore.db.close();
    rmSync(dir, { recursive: true, force: true });
  }
}
