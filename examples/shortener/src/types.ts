export interface Link {
  code: string;
  url: string;
  hits: number;
  createdAt: string;
}

export interface Store {
  get(code: string): Link | undefined;
  /** Oldest link with exactly this url. */
  findByUrl(url: string): Link | undefined;
  /** Creates a link with the given code (caller ensures it is free); createdAt = new Date().toISOString(). */
  create(code: string, url: string): Link;
  /** Increments hits, returns updated link or undefined. */
  hit(code: string): Link | undefined;
  delete(code: string): boolean;
  /** Random 6-char [A-Za-z0-9] code not currently in use. */
  generateCode(): string;
}

export type CreateInput =
  | { ok: true; url: string; code?: string }
  | { ok: false; error: string };
