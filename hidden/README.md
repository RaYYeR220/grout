# Hidden task outputs

Each directory here is the factory's output for one of the organisers' unseen specs, exactly as `grout run <spec> --out hidden/<spec name> --commit` wrote it. Nothing in these directories was edited by hand: between runs only the factory itself may change, and every such change is recorded.

Each output contains:

- the project (TypeScript sources, `dist/`, `package-lock.json`, the generated tests and harness)
- `RUN.md`: release status, the requirement table with test results, wall time and model cost
- `HUMAN_STEPS.md`: every human step-in during the run (`grout nudge`) and every factory change made before it (`grout run --note`); it says so when there were none
- `grout-run/trace.jsonl` and `grout-run/report.html`: the full trace and the run report

## Runs

| spec | run | status | hidden tests (ours) | human steps | time | cost |
|---|---|---|---|---|---|---|
