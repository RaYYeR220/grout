/** A minimal ustar writer: regular files only, enough to stream a snapshot into a container. */
export function tarFiles(files: Map<string, string>): Buffer {
  const blocks: Buffer[] = [];
  for (const [path, content] of files) {
    const body = Buffer.from(content, "utf8");
    blocks.push(header(path, body.length), body, Buffer.alloc((512 - (body.length % 512)) % 512));
  }
  blocks.push(Buffer.alloc(1024));
  return Buffer.concat(blocks);
}

function splitName(path: string): { name: string; prefix: string } {
  if (Buffer.byteLength(path) <= 100) return { name: path, prefix: "" };
  for (let i = path.lastIndexOf("/"); i > 0; i = path.lastIndexOf("/", i - 1)) {
    const prefix = path.slice(0, i);
    const name = path.slice(i + 1);
    if (Buffer.byteLength(prefix) <= 155 && Buffer.byteLength(name) <= 100) return { name, prefix };
  }
  throw new Error(`path too long for tar: ${path}`);
}

function header(path: string, size: number): Buffer {
  const h = Buffer.alloc(512);
  const { name, prefix } = splitName(path);
  const put = (value: string, offset: number, length: number) => h.write(value, offset, length, "utf8");
  const octal = (n: number, length: number) => n.toString(8).padStart(length - 1, "0") + "\0";
  put(name, 0, 100);
  put("0000644\0", 100, 8);
  put("0000000\0", 108, 8);
  put("0000000\0", 116, 8);
  put(octal(size, 12), 124, 12);
  put(octal(Math.floor(Date.now() / 1000), 12), 136, 12);
  put("        ", 148, 8);
  put("0", 156, 1);
  put("ustar\0", 257, 6);
  put("00", 263, 2);
  put(prefix, 345, 155);
  let sum = 0;
  for (const byte of h) sum += byte;
  put(sum.toString(8).padStart(6, "0") + "\0 ", 148, 8);
  return h;
}
