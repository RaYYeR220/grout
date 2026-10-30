import type { TestStatus } from "../state/test-matrix.js";

export type TscError = { file: string; line: number; col: number; code: string; message: string };
export type VitestResult = { file: string; title: string; status: TestStatus; failure?: string; stackFiles: string[] };

const TSC_LINE = /^(.+?)\((\d+),(\d+)\): error (TS\d+): (.*)$/;

export function parseTsc(output: string): TscError[] {
  const errors: TscError[] = [];
  for (const line of output.split(/\r?\n/)) {
    const m = line.match(TSC_LINE);
    if (m) {
      errors.push({ file: m[1].replace(/\\/g, "/"), line: Number(m[2]), col: Number(m[3]), code: m[4], message: m[5] });
    } else if (/^\s+\S/.test(line) && errors.length > 0) {
      errors[errors.length - 1].message += `\n${line.trim()}`;
    }
  }
  return errors;
}

type VitestReport = {
  testResults?: {
    name: string;
    status: string;
    message?: string;
    assertionResults: { title: string; ancestorTitles?: string[]; status: string; failureMessages?: string[] }[];
  }[];
};

const STATUS: Record<string, TestStatus> = { passed: "pass", failed: "fail", skipped: "skip", pending: "skip", todo: "skip" };

function relative(path: string, root: string): string {
  const p = path.replace(/\\/g, "/");
  const r = root.replace(/\\/g, "/").replace(/\/$/, "");
  // An empty root would otherwise match every absolute path and only strip its leading slash.
  if (r !== "" && p.toLowerCase().startsWith(`${r.toLowerCase()}/`)) return p.slice(r.length + 1);
  const m = p.match(/(?:^|\/)((?:src|test)\/.*)$/);
  return m ? m[1] : p;
}

/** Workspace files (src/ or test/) mentioned in a failure's stack, in order of appearance. */
function stackFiles(text: string, root: string): string[] {
  const out: string[] = [];
  for (const m of text.replace(/\\/g, "/").matchAll(/((?:[A-Za-z]:)?\/[^\s():]*?\/(?:src|test)\/[^\s():]+\.[cm]?[jt]s)/g)) {
    if (m[1].includes("node_modules")) continue;
    const rel = relative(m[1], root);
    if (!out.includes(rel)) out.push(rel);
  }
  return out;
}

export function parseVitestJson(json: string, root: string): VitestResult[] {
  let report: VitestReport;
  try {
    report = JSON.parse(json) as VitestReport;
  } catch {
    return [{ file: "", title: "(no test report)", status: "error", failure: json.slice(0, 2000), stackFiles: [] }];
  }
  const results: VitestResult[] = [];
  for (const file of report.testResults ?? []) {
    const rel = relative(file.name, root);
    if (file.assertionResults.length === 0 && file.status === "failed") {
      const failure = file.message ?? "test file failed to load";
      results.push({ file: rel, title: "(file failed to load)", status: "error", failure, stackFiles: stackFiles(failure, root) });
      continue;
    }
    for (const a of file.assertionResults) {
      const failure = (a.failureMessages ?? []).join("\n");
      const title = [...(a.ancestorTitles ?? []), a.title].join(" > ");
      results.push({
        file: rel,
        title,
        status: STATUS[a.status] ?? "error",
        ...(failure ? { failure } : {}),
        stackFiles: failure ? stackFiles(failure, root) : [],
      });
    }
  }
  return results;
}
