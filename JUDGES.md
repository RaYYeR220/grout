# Reviewing grout in five minutes

Everything below runs from a fresh clone. Steps 1–4 need no API key and no Docker.

```
npm install
```

## 1. Watch a recorded run (no key)

```
npm run grout -- replay examples/shortener/grout-run
```

A real run of the factory on `bench/specs/shortener.md` (an HTTP URL shortener), replayed in the terminal: analyst and architect starting together, the ledger reaching the architect mid-flight, builders and test authors working at the same time, a **stale write refused and re-applied** (two test authors wrote the same file), the verifier sending a failure back to its task, the reviewer reopening a task, the release gate and the clean-room check.

Then open `examples/shortener/grout-run/report.html`: who worked when, the time and cost of every task, cost by role and model, the requirement matrix, and every refusal. `examples/shortener/RUN.md` is the summary the factory wrote, `HUMAN_STEPS.md` says nobody stepped in.

## 2. Check the concurrency claim (no key, ~30 s)

```
npm run grout -- race --runs 100
```

Three scripted builders read-modify-write one shared file through the real runtime, gate and workspace (only the model is scripted). Without compare-and-swap they lose updates in essentially every trial; with the interlock they lose none, and still finish faster than one builder at a time. The 500-trial numbers are in the README.

Where it lives:
- `src/state/workspace.ts` — `commit()`: the version check and the write in one synchronous step.
- `src/gates/gatekeeper.ts` — the Mozaik `InterceptionHandler` around every agent loop.
- `src/gates/policies.ts` — who may write what, each rule announced to the agents it applies to.
- `src/agents/tools.ts` — a stale write answers with the current content; the agent re-applies.

## 3. Check the output against tests the factory never saw (no key)

```
TARGET_DIR=$PWD/examples/shortener npx vitest run --config bench/vitest.config.ts bench/acceptance/shortener
```

18/18. The hidden suites under `bench/acceptance/` were written independently of the factory; `bench/fixtures/wrong-*` are deliberately buggy implementations that fail them, so a pass is not vacuous. All eight specs: [BENCHMARKS.md](BENCHMARKS.md).

## 4. Read the tests of the factory itself (no key)

```
npm test
```

Unit and integration tests, no network and no tokens. `GROUT_SLOW_TESTS=1 npm test` adds full scripted runs of the whole factory, with one candidate and with two.

## 5. Run it (needs a key; Docker optional)

```
cp .env.example .env     # VENICE_API_KEY, OPENROUTER_API_KEY, ANTHROPIC_API_KEY or OPENAI_API_KEY
npm run grout -- run bench/specs/hello.md --out out/hello
```

About a minute and ten cents on the default economy preset. The live log shows every agent starting and ending, every write, every refusal and every test run, with the running cost.

## The hidden task

The outputs for the organisers' specs are in `hidden/<spec name>/`, each with `RUN.md` (status, requirement table, time, cost), `HUMAN_STEPS.md` (every human step-in, automatically recorded; empty when nobody intervened) and `grout-run/` (trace and report). `hidden/README.md` lists the runs.
