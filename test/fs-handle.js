// A real directory behind the File System Access handle interface (the subset lib/store.js uses), for node --test.

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

class FileHandle {
  constructor(p) { this.path = p; this.kind = "file"; this.name = path.basename(p); }
  async getFile() {
    const buf = await fs.readFile(this.path);
    return { size: buf.length, text: async () => buf.toString("utf8"), arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length) };
  }
  async createWritable({ keepExistingData = false } = {}) {
    let buf = keepExistingData ? await fs.readFile(this.path) : Buffer.alloc(0);
    let pos = 0;
    const p = this.path;
    return {
      async seek(n) { pos = n; },
      async write(data) {
        const chunk = typeof data === "string" ? Buffer.from(data) : Buffer.from(data.buffer ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength) : data);
        const end = pos + chunk.length;
        if (end > buf.length) buf = Buffer.concat([buf, Buffer.alloc(end - buf.length)]);
        chunk.copy(buf, pos);
        pos = end;
      },
      async close() { await fs.writeFile(p, buf); },
    };
  }
}

const notFound = (what) => Object.assign(new Error(`${what} not found`), { name: "NotFoundError" });

export class DirHandle {
  constructor(p) { this.path = p; this.kind = "directory"; this.name = path.basename(p); }
  async getDirectoryHandle(name, { create = false } = {}) {
    const p = path.join(this.path, name);
    if (create) await fs.mkdir(p, { recursive: true });
    const st = await fs.stat(p).catch(() => null);
    if (!st?.isDirectory()) throw notFound(name);
    return new DirHandle(p);
  }
  async getFileHandle(name, { create = false } = {}) {
    const p = path.join(this.path, name);
    const st = await fs.stat(p).catch(() => null);
    if (!st) {
      if (!create) throw notFound(name);
      await fs.writeFile(p, "");
    } else if (!st.isFile()) throw Object.assign(new Error("not a file"), { name: "TypeMismatchError" });
    return new FileHandle(p);
  }
  async *entries() {
    for (const d of await fs.readdir(this.path, { withFileTypes: true })) {
      yield [d.name, d.isDirectory() ? new DirHandle(path.join(this.path, d.name)) : new FileHandle(path.join(this.path, d.name))];
    }
  }
}

/** A fresh temp folder, optionally seeded with { "relative/path": content }. */
export async function tempFolder(files = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "job-applier-"));
  for (const [rel, content] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(dir, rel)), { recursive: true });
    await fs.writeFile(path.join(dir, rel), content);
  }
  return { dir, handle: new DirHandle(dir) };
}

/** ctx.ai that returns scripted outputs in order and records the calls. */
export function fakeAi(...outputs) {
  const calls = [];
  const ai = async (role, args) => {
    calls.push({ role, ...args });
    if (!outputs.length) throw new Error(`no scripted output left for ${role}`);
    return { data: structuredClone(outputs.shift()), cost_usd: 0.01 };
  };
  return { ai, calls };
}
