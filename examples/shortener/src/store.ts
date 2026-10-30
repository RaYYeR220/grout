import { randomInt } from "node:crypto";
import type { Link, Store } from "./types.js";

const ALPHABET =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

export function createStore(): Store {
  // Map preserves insertion order, so iteration yields oldest links first.
  const links = new Map<string, Link>();

  return {
    get(code: string): Link | undefined {
      return links.get(code);
    },

    findByUrl(url: string): Link | undefined {
      for (const link of links.values()) {
        if (link.url === url) return link;
      }
      return undefined;
    },

    create(code: string, url: string): Link {
      const link: Link = {
        code,
        url,
        hits: 0,
        createdAt: new Date().toISOString(),
      };
      links.set(code, link);
      return link;
    },

    hit(code: string): Link | undefined {
      const link = links.get(code);
      if (!link) return undefined;
      link.hits += 1;
      return link;
    },

    delete(code: string): boolean {
      return links.delete(code);
    },

    generateCode(): string {
      for (;;) {
        let code = "";
        for (let i = 0; i < 6; i++) {
          code += ALPHABET[randomInt(ALPHABET.length)];
        }
        if (!links.has(code)) return code;
      }
    },
  };
}
