# Hidden task outputs

Each directory here is the factory's output for one of the organisers' unseen specs, exactly as `grout run <spec> --out hidden/<spec name> --commit` wrote it. Nothing in these directories was edited by hand: between runs only the factory itself may change, and every such change is recorded.

Each output contains:

- the project (TypeScript sources, `dist/`, `package-lock.json`, the generated tests and harness)
- `RUN.md`: release status, the requirement table with test results, wall time and model cost
- `HUMAN_STEPS.md`: every human step-in during the run (`grout nudge`) and every factory change made before it (`grout run --note`); it says so when there were none
- `grout-run/trace.jsonl` and `grout-run/report.html`: the full trace and the run report

## Runs

| spec | run | status | our independent black-box suite | human steps | time | cost |
|---|---|---|---|---|---|---|
| box-office | 2026-10-31T17-04-28, 18:04–18:19 CET, `--candidates 2 --quality quality` | green (team B selected) | independent suite `bench/acceptance/box-office`: 68/68 | 0 | 907 s | $9.60 |
