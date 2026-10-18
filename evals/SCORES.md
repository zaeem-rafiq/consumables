# Eval score log

One row per full run. "Tasks" is the share of task runs where every check passed; "checks" is the share of individual checks passed.

| Date | Commit | Change | Model | Trials | Tasks | Checks |
|---|---|---|---|---|---|---|
| 2026-10-18 | mvp 256bb18 | baseline (store with Connect Domaru) | claude-sonnet-5-5 | 3 | 90% | 98% |
| 2026-10-18 | mvp 256bb18 | baseline (store with Connect Domaru) | claude-haiku-5-5 | 3 | 87% | 97% |
| 2026-10-18 | df7bdd9 | round 1: two-speed bundle, pause dates, held-order guidance | claude-sonnet-5-5 | 3 | 100% | 100% |
| 2026-10-18 | df7bdd9 | round 1: two-speed bundle, pause dates, held-order guidance | claude-haiku-5-5 | 3 | 100% | 100% |
| 2026-10-18 | 7ed6440 | round 2 baseline, the 6 new harder tasks only (household-grows grader was too loose, fixed in 2e7dbb0) | claude-sonnet-5-5 | 3 | 83% | 96% |
| 2026-10-18 | 7ed6440 | round 2 baseline, the 6 new harder tasks only | claude-haiku-5-5 | 3 | 67% | 87% |
