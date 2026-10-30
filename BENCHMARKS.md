# Benchmarks

Two measurements: what the factory produces on specs it has never seen, judged by tests it has never seen; and what the compare-and-swap interlock does to concurrent writers.

## 1. Eight unseen specs, hidden acceptance tests

`bench/specs/` holds eight one-page specs written like hackathon briefs: four CLIs and four HTTP APIs, with exact output formats, exit codes, validation messages, stdin input, file persistence, pagination and sorting, time-to-live, rate limits with headers, and four different ways of being started (`node dist/x.js`, a `bin` command, `npm start --`, and port variables with defaults). For each one, `bench/acceptance/<spec>/` holds a hidden acceptance suite written independently of the factory; the factory never reads it. After a run the suite is run against the output directory.

Setup: economy preset (planner, reviewer and arbiter on `claude-sonnet-5-5`, builders and test authors on `claude-haiku-5-5`, through Venice), Docker sandbox, one candidate, three builder slots, two test authors, a budget cap of $1 per run ($0.50 for `hello`), no human input. Each spec was run once; nothing was re-run or picked.

| spec | kind | hidden tests | release | human steps | time | cost | agents | peak concurrent | stale writes caught | gate refusals | tasks sent back |
|---|---|---|---|---|---|---|---|---|---|---|---|
| hello | CLI | 8/8 | green | 0 | 67 s | $0.095 | 6 | 4 | 0 | 1 | 0 |
| hitcount | HTTP | 12/12 | green | 0 | 366 s | $0.369 | 18 | 5 | 0 | 0 | 3 |
| inventory | HTTP | 24/24 | green | 0 | 584 s | $0.988 | 27 | 6 | 0 | 0 | 6 |
| kv | HTTP | 18/18 | green | 0 | 219 s | $0.201 | 8 | 5 | 1 | 0 | 0 |
| semver | CLI | 16/16 | green | 0 | 327 s | $0.221 | 10 | 8 | 1 | 0 | 0 |
| shortener | HTTP | 18/18 | green | 0 | 473 s | $0.335 | 13 | 5 | 1 | 0 | 2 |
| todo | CLI | 18/18 | green | 0 | 266 s | $0.224 | 10 | 6 | 1 | 0 | 0 |
| wordfreq | CLI | 25/25 | green | 0 | 260 s | $0.230 | 15 | 7 | 1 | 0 | 2 |
| **total** | | **139/139** | 8/8 green | 0 | | **$2.664** | | | 5 | 1 | 13 |

Columns: *hidden tests* = the independent suite against the output; *release* = the factory's own release gate (its own tests, coverage of every requirement, clean-room install/build/test in a fresh container); *agents* = agent loops started (each task attempt, review and arbitration is one); *peak concurrent* = the most agent loops running at the same moment; *stale writes caught* = writes refused by the compare-and-swap and re-applied by the agent; *tasks sent back* = reopens by the verifier, reviewer or clean room. Costs are Venice's own per-call figures.

**Negative controls.** A pass is only meaningful if the suites can fail. For two specs, `bench/fixtures/ref-*` are reference implementations and `bench/fixtures/wrong-*` carry two or three subtle, planted bugs each:

| fixture | result |
|---|---|
| `ref-todo` | 18/18 pass |
| `wrong-todo` (ids reused after removal, unknown id exits 2 instead of 1, `list` creates the data file) | 3 fail, each on its planted bug |
| `ref-inventory` | 24/24 pass |
| `wrong-inventory` (`totalPages` rounded down, descending sort reverses ties, duplicate sku is 400 instead of 409) | 6 fail, all on the planted bugs |

The expected values in every suite were also checked against a second, independent implementation of each spec written from the spec text alone.

**Two candidates.** The same factory with `--candidates 2` on `todo`: both teams released green, each team's program passed the combined suite of both teams' tests (86/86), and the cheaper one was exported. 360 s, $0.91 (team B builds on the planner model).

Reproduce:

```
npm run grout -- bench --build                       # build every spec, then run its hidden suite
npm run grout -- bench                               # only re-run the hidden suites against runs-out/<spec>
TARGET_DIR=$PWD/examples/shortener npx vitest run --config bench/vitest.config.ts bench/acceptance/shortener
```

Raw numbers: `results/bench-economy.json`.

## 2. The lost-update experiment

`npm run grout -- race --runs 500 --builders 3 --seed 1` runs three builder agents that each read the shared route registry and write it back with one more line, with random latency between the read and the write, the read-modify-write every LLM builder does. The runtime, the gate, the tools and the workspace are the real ones; only the model is scripted, so the experiment costs nothing and is reproducible from the seed.

| mode | trials | lost updates | trials that lost a line | stale writes refused and re-applied | mean wall time |
|---|---|---|---|---|---|
| parallel, no compare-and-swap (`--mode naive`) | 500 | **944** | **500** | 0 | 52 ms |
| parallel, interlocked (default) | 500 | **0** | **0** | 1306 | 98 ms |
| one builder at a time (`--mode sequential`) | 500 | 0 | 0 | 0 | 131 ms |

Without the interlock every trial loses work and nothing reports it. With it no update is lost; conflicts become stale refusals the agents recover from, and the team still finishes about 25% faster than working one at a time. Raw numbers: `results/race-500.json`.

## What these numbers do not show

- One run per spec. Model output varies between runs; the factory's own release gate is what makes a bad run visible (it would have been exported as *incomplete*, not green), but a spec can still need a second run.
- The specs are ours. The organisers' hidden specs may be harder or phrased differently; the factory is tuned for one-page specs and nothing larger.
- `inventory` needed six reopens and came within $0.02 of its $1 budget in this run: a reviewer's finding led to a change that broke four passing tests, which the verifier then sent back. Since then the verifier labels such failures as regressions caused by a recent change.
