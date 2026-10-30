import type { CmdResult, ExecOptions, Sandbox } from "../sandbox/types.js";

type Fix = { pattern: string; test: RegExp; action: string };

const NETWORK: Fix = { pattern: "network", test: /ECONNRESET|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|socket hang up|network request.*failed|ECONNREFUSED.*registry/i, action: "retry" };
const NPM_CACHE: Fix = { pattern: "npm-cache", test: /EINTEGRITY|ENOTEMPTY|EBADF|integrity checksum failed|cache.*corrupt/i, action: "npm cache clean --force, retry" };
const PORT: Fix = { pattern: "port-in-use", test: /EADDRINUSE/, action: "rerun on a new port" };

const output = (r: CmdResult) => `${r.stderr}\n${r.stdout}`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Environment failures are not the code's fault and must never cost a builder an attempt:
 * flaky registry connections are retried, a corrupted npm cache is cleaned, a port collision is
 * rerun in a fresh snapshot (which gets its own port). Anything else is passed through untouched.
 */
export function withEnvDoctor(inner: Sandbox, report: (pattern: string, action: string, attempt: number) => void, backoffMs = 2000): Sandbox {
  async function heal<T extends CmdResult>(run: () => Promise<T>, fixes: Fix[], attempts = 3): Promise<T> {
    let r = await run();
    for (let attempt = 1; attempt <= attempts && r.exitCode !== 0; attempt++) {
      const fix = fixes.find((f) => f.test.test(output(r)));
      if (!fix) return r;
      report(fix.pattern, fix.action, attempt);
      if (fix === NPM_CACHE) await inner.exec(new Map(), "npm cache clean --force", { timeoutMs: 120_000 });
      if (fix === NETWORK) await sleep(backoffMs * attempt);
      r = await run();
    }
    return r;
  }

  return {
    kind: inner.kind,
    init: (runId) => inner.init(runId),
    installDeps: (pkg) => heal(() => inner.installDeps(pkg), [NETWORK, NPM_CACHE]),
    exec: (files, cmd, opts?: ExecOptions) => heal(() => inner.exec(files, cmd, opts), [PORT], 1),
    cleanRoom: async (files, cmds, opts?: ExecOptions) => {
      let results = await inner.cleanRoom(files, cmds, opts);
      for (let attempt = 1; attempt <= 3; attempt++) {
        const failed = results.find((r) => r.exitCode !== 0);
        const fix = failed && [NETWORK, NPM_CACHE, PORT].find((f) => f.test.test(output(failed)));
        if (!fix) break;
        report(fix.pattern, fix.action, attempt);
        if (fix === NETWORK) await sleep(backoffMs * attempt);
        results = await inner.cleanRoom(files, cmds, opts);
      }
      return results;
    },
    dispose: () => inner.dispose(),
  };
}
