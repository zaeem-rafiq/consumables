# Household evals

Can a real assistant keep a household stocked using only Domaru's MCP tools and their descriptions? Each task gives a model a household request ("Set us up with a monthly delivery of the basics, there are four of us now"), lets it work through the Domaru MCP server against a fresh sandbox store, then checks what actually happened in the store: orders, subscriptions, approvals, problem reports and deliveries. A judge model answers a few yes/no questions about the final reply.

```
npm run evals                                         # all tasks, Sonnet + Haiku, 3 trials each
npm run evals -- --models claude-haiku-5-5 --trials 1 --tasks held-order,vacation
npm run evals -- --label "clearer approval errors"    # full run, adds rows to SCORES.md
```

Requirements: the Claude Code CLI (`claude`) signed in. Nothing real is ordered or charged; every run uses an in-memory store with mock payments.

- `tasks.js`: the tasks and their graders. Dates are relative to today.
- `harness.js`: seeds a household through the Connect Domaru flow, runs `claude -p` with only the Domaru tools, parses the transcript, and asks the judge.
- `run.js`: runs tasks in parallel and writes `results/<time>.json` (not committed). With `--label`, it also appends a row per model to `SCORES.md`.
- `SCORES.md`: the score log. Add a row for every change made to improve the scores.

**Hill-climbing.** When a task fails, read the transcript in the results file. Fix the product (tool descriptions, error messages, response fields, flows), not the task, unless the grader is wrong. Run long evals from a git worktree pinned to a commit, so edits made during the run don't change the code under test.
