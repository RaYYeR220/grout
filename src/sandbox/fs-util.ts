import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export async function writeTree(root: string, files: Map<string, string>): Promise<void> {
  for (const [path, content] of files) {
    const abs = join(root, path);
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, content);
  }
}

async function walk(dir: string, prefix: string, out: Record<string, string>): Promise<void> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const rel = `${prefix}${e.name}`;
    if (e.isDirectory()) await walk(join(dir, e.name), `${rel}/`, out);
    else if (e.isFile()) out[rel] = await readFile(join(dir, e.name), "utf8");
  }
}

/** Reads exact paths, and every file under entries that end with "/". Missing paths are skipped. */
export async function collectFiles(root: string, collect: string[] = []): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const c of collect) {
    if (c.endsWith("/")) await walk(join(root, c), c, out);
    else {
      try {
        out[c] = await readFile(join(root, c), "utf8");
      } catch {
        /* not produced */
      }
    }
  }
  return out;
}

/** Shell metacharacters are never allowed in a sandbox command; every token must be plain. */
export function unsafeToken(cmd: string): string | undefined {
  return cmd
    .trim()
    .split(/\s+/)
    .find((t) => !/^[\w@./:=,+%-]+$/.test(t));
}
