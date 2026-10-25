// The user's data folder, through the File System Access API (a FileSystemDirectoryHandle they picked once).
// Paths are always relative, "/"-separated, and can't climb out of the folder.
// Tests pass an fs-backed object with the same handle interface (tests/fs-handle.js).

export class StoreError extends Error {}

function parts(path) {
  const ps = String(path).split("/");
  if (!path || ps.some((p) => !p || p === "." || p === ".." || p.includes("\\"))) throw new StoreError(`bad path ${path}`);
  return ps;
}

export class Folder {
  constructor(root) {
    this.root = root;
  }

  get name() {
    return this.root.name;
  }

  async _dir(ps, create) {
    let d = this.root;
    for (const p of ps) d = await d.getDirectoryHandle(p, { create });
    return d;
  }

  async _file(path, create = false) {
    const ps = parts(path);
    const dir = await this._dir(ps.slice(0, -1), create);
    return dir.getFileHandle(ps.at(-1), { create });
  }

  async exists(path) {
    try {
      await this._file(path);
      return true;
    } catch {
      return false;
    }
  }

  async read(path) {
    try {
      return await (await (await this._file(path)).getFile()).text();
    } catch (e) {
      if (e.name === "NotFoundError" || e.name === "TypeMismatchError") return null;
      throw e;
    }
  }

  async readBytes(path) {
    try {
      return new Uint8Array(await (await (await this._file(path)).getFile()).arrayBuffer());
    } catch (e) {
      if (e.name === "NotFoundError" || e.name === "TypeMismatchError") return null;
      throw e;
    }
  }

  async write(path, data) {
    const w = await (await this._file(path, true)).createWritable();
    await w.write(data);
    await w.close();
  }

  async append(path, text) {
    const h = await this._file(path, true);
    const size = (await h.getFile()).size;
    const w = await h.createWritable({ keepExistingData: true });
    await w.seek(size);
    await w.write(text);
    await w.close();
  }

  /** Names of files (not folders) directly in `dir` ("" for the top level), sorted. */
  async list(dir = "") {
    let d;
    try {
      d = dir ? await this._dir(parts(dir), false) : this.root;
    } catch {
      return [];
    }
    const out = [];
    for await (const [name, h] of d.entries()) if (h.kind === "file") out.push(name);
    return out.sort();
  }
}

// ---- remembering the folder (browser only) --------------------------------------------------
const DB = "job-applier";

function idb() {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore("handles");
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

async function idbDo(mode, fn) {
  const db = await idb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction("handles", mode);
    const req = fn(tx.objectStore("handles"));
    tx.oncomplete = () => resolve(req?.result);
    tx.onerror = () => reject(tx.error);
  });
}

export const saveHandle = (h) => idbDo("readwrite", (s) => s.put(h, "data"));
export const loadHandle = () => idbDo("readonly", (s) => s.get("data"));

/** "granted" | "prompt" | "none". requestPermission needs a click, so "prompt" means: show a Reconnect button. */
export async function folderState(h) {
  if (!h) return "none";
  const p = await h.queryPermission({ mode: "readwrite" });
  return p === "granted" ? "granted" : "prompt";
}
