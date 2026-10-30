import { randomInt } from "node:crypto";
const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
export function createStore() {
    // Map preserves insertion order, so iteration yields oldest links first.
    const links = new Map();
    return {
        get(code) {
            return links.get(code);
        },
        findByUrl(url) {
            for (const link of links.values()) {
                if (link.url === url)
                    return link;
            }
            return undefined;
        },
        create(code, url) {
            const link = {
                code,
                url,
                hits: 0,
                createdAt: new Date().toISOString(),
            };
            links.set(code, link);
            return link;
        },
        hit(code) {
            const link = links.get(code);
            if (!link)
                return undefined;
            link.hits += 1;
            return link;
        },
        delete(code) {
            return links.delete(code);
        },
        generateCode() {
            for (;;) {
                let code = "";
                for (let i = 0; i < 6; i++) {
                    code += ALPHABET[randomInt(ALPHABET.length)];
                }
                if (!links.has(code))
                    return code;
            }
        },
    };
}
