import { normalizePath } from "../paths.js";

export type FileEntry = { path: string; content: string; version: number; author: string; taskId?: string };

export type CommitRecord = {
  rev: number;
  path: string;
  author: string;
  taskId?: string;
  baseVersion: number | null;
  newVersion: number;
  overwroteUnseen: boolean;
  at: number;
};

export type StaleResult = {
  ok: false;
  reason: "stale";
  path: string;
  current: number;
  seen: number | null;
  currentAuthor: string;
  currentContent: string;
};

export type CommitResult = { ok: true; path: string; version: number; rev: number } | StaleResult;

export type EditResult = CommitResult | { ok: false; reason: "no-match" | "ambiguous"; path: string };

function stale(path: string, current: FileEntry, seen: number | null): StaleResult {
  return {
    ok: false,
    reason: "stale",
    path,
    current: current.version,
    seen,
    currentAuthor: current.author,
    currentContent: current.content,
  };
}

/**
 * The shared codebase every agent writes into. Each file carries a version; each agent
 * carries the version it last read. A write is a compare-and-swap against that version.
 */
export class Workspace {
  private readonly files = new Map<string, FileEntry>();
  private readonly seen = new Map<string, Map<string, number>>();
  private readonly commits: CommitRecord[] = [];
  private revision = 0;
  private readonly cas: boolean;

  constructor(opts: { cas?: boolean } = {}) {
    this.cas = opts.cas ?? true;
  }

  get rev(): number {
    return this.revision;
  }

  get log(): readonly CommitRecord[] {
    return this.commits;
  }

  read(agent: string, path: string): FileEntry | undefined {
    const p = normalizePath(path);
    const entry = this.files.get(p);
    if (entry) this.seenBy(agent).set(p, entry.version);
    return entry;
  }

  peek(path: string): FileEntry | undefined {
    return this.files.get(normalizePath(path));
  }

  list(prefix = ""): string[] {
    return [...this.files.keys()].filter((p) => p.startsWith(prefix)).sort();
  }

  /**
   * Synchronous on purpose: the version check and the write happen in one step with no
   * `await` between them. Splitting them (check now, write after an async gap) lets two
   * concurrent agents both pass the check and silently lose one update.
   */
  commit(agent: string, path: string, content: string, taskId?: string): CommitResult {
    const p = normalizePath(path);
    const current = this.files.get(p);
    const saw = this.seenBy(agent).get(p) ?? null;
    const unseen = current !== undefined && saw !== current.version;
    if (unseen && this.cas) return stale(p, current, saw);
    const version = (current?.version ?? 0) + 1;
    this.files.set(p, { path: p, content, version, author: agent, taskId });
    this.seenBy(agent).set(p, version);
    this.revision += 1;
    this.commits.push({
      rev: this.revision,
      path: p,
      author: agent,
      taskId,
      baseVersion: current ? saw : null,
      newVersion: version,
      overwroteUnseen: unseen,
      at: Date.now(),
    });
    return { ok: true, path: p, version, rev: this.revision };
  }

  edit(agent: string, path: string, oldText: string, newText: string, taskId?: string): EditResult {
    const p = normalizePath(path);
    const current = this.files.get(p);
    const saw = this.seenBy(agent).get(p) ?? null;
    if (current && saw !== current.version && this.cas) return stale(p, current, saw);
    const content = current?.content ?? "";
    const first = content.indexOf(oldText);
    if (oldText === "" || first === -1) return { ok: false, reason: "no-match", path: p };
    if (content.indexOf(oldText, first + 1) !== -1) return { ok: false, reason: "ambiguous", path: p };
    return this.commit(agent, p, content.slice(0, first) + newText + content.slice(first + oldText.length), taskId);
  }

  snapshot(): Map<string, string> {
    return new Map([...this.files].map(([p, e]) => [p, e.content]));
  }

  lostUpdates(): number {
    return this.commits.filter((c) => c.overwroteUnseen).length;
  }

  private seenBy(agent: string): Map<string, number> {
    let m = this.seen.get(agent);
    if (!m) {
      m = new Map();
      this.seen.set(agent, m);
    }
    return m;
  }
}
