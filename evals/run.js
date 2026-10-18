#!/usr/bin/env -S node --no-warnings
// Run the household evals against real assistant models.
//
//   node evals/run.js                                   # every task, sonnet + haiku, 3 trials
//   node evals/run.js --models claude-haiku-5-5 --trials 1 --tasks held-order,vacation
//   node evals/run.js --label "clearer approval errors"  # adds a row to evals/SCORES.md
//
// Needs the Claude Code CLI (`claude`) signed in. Each run uses a fresh
// sandbox store, so nothing real is ever ordered or charged.

import { mkdirSync, writeFileSync, appendFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';
import { TASKS } from './tasks.js';
import { runTask } from './harness.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const opt = (name, dflt) => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : dflt; };

const models = opt('models', 'claude-sonnet-5-5,claude-haiku-5-5').split(',');
const trials = Number(opt('trials', '3'));
const concurrency = Number(opt('concurrency', '6'));
const label = opt('label', '');
const only = opt('tasks', '');
const tasks = only ? TASKS.filter((t) => only.split(',').includes(t.id)) : TASKS;
if (!tasks.length) throw new Error(`No tasks match ${only}. Known: ${TASKS.map((t) => t.id).join(', ')}`);

const jobs = [];
for (const model of models) for (const task of tasks) for (let i = 0; i < trials; i++) jobs.push({ model, task, trial: i + 1 });

const results = [];
let next = 0; let done = 0;
async function worker() {
  while (next < jobs.length) {
    const job = jobs[next++];
    const r = await runTask(job.task, { model: job.model });
    r.trial = job.trial;
    results.push(r);
    done++;
    const failed = r.checks.filter((c) => !c.pass).map((c) => c.name);
    console.log(`[${done}/${jobs.length}] ${r.pass ? 'PASS' : 'FAIL'} ${job.model} ${job.task.id} #${job.trial}${failed.length ? `  - ${failed.join('; ')}` : ''}`);
  }
}
await Promise.all(Array.from({ length: Math.min(concurrency, jobs.length) }, worker));

// ---- summary
const commit = (() => { try { return execSync('git rev-parse --short HEAD', { cwd: HERE }).toString().trim(); } catch { return '?'; } })();
const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const summary = {};
for (const model of models) {
  const rs = results.filter((r) => r.model === model);
  const perTask = Object.fromEntries(tasks.map((t) => {
    const tr = rs.filter((r) => r.task === t.id);
    return [t.id, { passed: tr.filter((r) => r.pass).length, of: tr.length, mean_score: tr.reduce((s, r) => s + r.score, 0) / (tr.length || 1) }];
  }));
  summary[model] = {
    task_pass_rate: rs.filter((r) => r.pass).length / (rs.length || 1),
    check_score: rs.reduce((s, r) => s + r.score, 0) / (rs.length || 1),
    cost_usd: rs.reduce((s, r) => s + (r.result?.cost_usd ?? 0), 0),
    per_task: perTask,
  };
}

mkdirSync(join(HERE, 'results'), { recursive: true });
const file = join(HERE, 'results', `${stamp}.json`);
writeFileSync(file, JSON.stringify({ label, commit, trials, models, summary, results }, null, 2));

console.log('\nModel                     tasks passed   checks passed');
for (const [m, s] of Object.entries(summary)) console.log(`${m.padEnd(26)}${(s.task_pass_rate * 100).toFixed(0).padStart(5)}%${(s.check_score * 100).toFixed(0).padStart(15)}%`);
console.log('\nPer task (passed/trials):');
for (const t of tasks) console.log(`  ${t.id.padEnd(22)} ${models.map((m) => `${summary[m].per_task[t.id].passed}/${summary[m].per_task[t.id].of}`).join('   ')}`);
console.log(`\nFull results: ${file}`);

if (label && !only) {
  const log = join(HERE, 'SCORES.md');
  if (!existsSync(log)) appendFileSync(log, '# Eval score log\n\nOne row per full run. "Tasks" is the share of task runs where every check passed; "checks" is the share of individual checks passed.\n\n| Date | Commit | Change | Model | Trials | Tasks | Checks |\n|---|---|---|---|---|---|---|\n');
  for (const [m, s] of Object.entries(summary)) {
    appendFileSync(log, `| ${new Date().toISOString().slice(0, 10)} | ${commit} | ${label} | ${m} | ${trials} | ${(s.task_pass_rate * 100).toFixed(0)}% | ${(s.check_score * 100).toFixed(0)}% |\n`);
  }
}
