import { posix } from "node:path";

export class PathError extends Error {
  constructor(path: string, reason: string) {
    super(`invalid path ${JSON.stringify(path)}: ${reason}`);
    this.name = "PathError";
  }
}

/** Workspace paths are relative POSIX paths that never leave the project root. */
export function normalizePath(path: string): string {
  if (path.trim() === "") throw new PathError(path, "empty");
  if (path !== path.trim()) throw new PathError(path, "leading or trailing spaces");
  if (/[\u0000-\u001f\u007f]/.test(path)) throw new PathError(path, "control characters");
  if (path.length > 200) throw new PathError(path, "longer than 200 characters");
  const slashed = path.replace(/\\/g, "/");
  if (slashed.startsWith("/")) throw new PathError(path, "absolute paths are not allowed");
  if (/^[a-zA-Z]:/.test(slashed)) throw new PathError(path, "drive letters are not allowed");
  const normalized = posix.normalize(slashed);
  if (normalized === ".." || normalized.startsWith("../")) throw new PathError(path, "escapes the project root");
  if (normalized === ".") throw new PathError(path, "points at the project root, not a file");
  return normalized.replace(/\/$/, "");
}
