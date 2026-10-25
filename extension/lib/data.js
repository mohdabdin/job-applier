// What lives in the data folder, and the rules for writing it (enforced here, in code, not in prompts):
//
//   profile/          the user's ground truth: profile.md, preferences.md, ... Read-only to the extension, except
//     cvs/            new CV variants (cv.js) and lines appended to cvs/INDEX.md
//   memory/           learned answers, one kebab-case topic per file, plus INDEX.md
//   tracker.csv       one row per job
//   jobs/<id>.md      saved postings
//   logs/             plans.jsonl, proof screenshots

export const today = () => new Date().toLocaleDateString("en-CA"); // YYYY-MM-DD, local time

export class DataError extends Error {}

// ---- profile + learned memory -----------------------------------------------------------------
export const LEARNED_NAME = /^[a-z0-9][a-z0-9-]{0,60}\.md$/;
const INDEX_HEADER =
  "# Memory index\n\nOne line per memory file: `- [file.md](file.md) — what it answers`. Written by Job Applier from your answers.\n\n";

export class Memory {
  constructor(folder) {
    this.f = folder;
  }

  async profileFiles() {
    const top = (await this.f.list("profile")).filter((n) => n.endsWith(".md")).map((n) => `profile/${n}`);
    const cvs = (await this.f.list("profile/cvs")).filter((n) => n.endsWith(".md")).map((n) => `profile/cvs/${n}`);
    return [...top, ...cvs];
  }

  async profileText() {
    const out = [];
    for (const p of await this.profileFiles()) out.push(`<file path="${p}">\n${(await this.f.read(p)).trim()}\n</file>`);
    return out.join("\n\n");
  }

  /** The person's name: the first "# " heading of profile/profile.md, else of the first CV. */
  async name() {
    const cvs = (await this.f.list("profile/cvs")).filter((n) => n.endsWith(".md") && n !== "INDEX.md");
    for (const p of ["profile/profile.md", ...cvs.map((n) => `profile/cvs/${n}`)]) {
      const m = (await this.f.read(p))?.match(/^# (.+)$/m);
      if (m) return m[1].trim();
    }
    return "the candidate";
  }

  async index() {
    return (await this.f.read("memory/INDEX.md")) ?? INDEX_HEADER;
  }

  async learnedFiles() {
    return (await this.f.list("memory")).filter((n) => n.endsWith(".md") && n !== "INDEX.md");
  }

  /** INDEX plus every learned file while it's small; INDEX only once it grows. */
  async learnedText(maxChars = 40_000) {
    const index = `<file path="memory/INDEX.md">\n${(await this.index()).trim()}\n</file>`;
    const files = [];
    for (const n of await this.learnedFiles()) files.push(`<file path="memory/${n}">\n${(await this.f.read(`memory/${n}`)).trim()}\n</file>`);
    const full = [index, ...files].join("\n\n");
    return full.length <= maxChars ? full : `${index}\n\n(Learned memory is large; only the index is shown.)`;
  }

  async writeLearned(file, summary, content) {
    if (!LEARNED_NAME.test(file) || file === "INDEX.md") {
      throw new DataError(`invalid memory file name ${JSON.stringify(file)}: use a kebab-case name like notice-period.md`);
    }
    const path = `memory/${file}`;
    const old = await this.f.read(path);
    const created = old?.match(/^created: (\S+)$/m)?.[1] || today();
    summary = summary.split(/\s+/).join(" ").trim();
    await this.f.write(path, `---\ntopic: ${file.replace(/\.md$/, "")}\ncreated: ${created}\nupdated: ${today()}\n` +
      `source: user-answer\nsummary: ${summary}\n---\n\n${content.trim()}\n`);
    const lines = (await this.index()).split("\n");
    const entry = `- [${file}](${file}) — ${summary}`;
    const i = lines.findIndex((l) => l.startsWith(`- [${file}](`));
    if (i >= 0) lines[i] = entry;
    else lines.push(entry);
    await this.f.write("memory/INDEX.md", lines.join("\n").trimEnd() + "\n");
    return file;
  }
}

// ---- tracker.csv ------------------------------------------------------------------------------
export const COLUMNS = ["id", "company", "role", "job_url", "apply_url", "source", "location", "work_mode", "salary",
  "stage", "date_found", "date_applied", "last_updated", "cv_used", "cover_letter", "contact", "notes"];
export const STAGES = new Set(["found", "in_progress", "needs_input", "ready_to_submit", "applied", "interviewing",
  "offer", "rejected", "withdrawn", "skipped", "failed"]);

export function parseCsv(text) {
  const rows = [];
  let row = [], field = "", quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field); rows.push(row); row = []; field = "";
    } else field += c;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.length > 1 || r[0]);
}

const csvField = (v) => (/[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
export const toCsv = (rows) => rows.map((r) => r.map((v) => csvField(String(v ?? ""))).join(",")).join("\r\n") + "\r\n";

/** An application URL without query/fragment (tracking params vary per click). */
export const urlKey = (url) => (url ? url.split("#")[0].split("?")[0].replace(/^https?:\/\/(www\.)?/, "").replace(/\/+$/, "").toLowerCase() : "");
const nameKey = (company, role) => {
  const norm = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  return `${norm(company)}|${norm(role)}`;
};

/** Stable id: the LinkedIn job id when present, else a short hash of the URL. */
export async function jobId(url) {
  const m = url.match(/linkedin\.com\/jobs\/view\/(?:[^/?]*-)?(\d+)/) || url.match(/currentJobId=(\d+)/);
  if (m) return `li-${m[1]}`;
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-1", new TextEncoder().encode(url)));
  return "job-" + [...hash].map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 10);
}

export class Tracker {
  constructor(folder) {
    this.f = folder;
    this.queue = Promise.resolve(); // writes one at a time
  }

  async rows() {
    const text = await this.f.read("tracker.csv");
    if (!text) return [];
    const [header, ...rest] = parseCsv(text);
    return rest.map((r) => Object.fromEntries(COLUMNS.map((c) => [c, r[header.indexOf(c)] ?? ""])));
  }

  async get(id) {
    return (await this.rows()).find((r) => r.id === id) || null;
  }

  /** The same job by id/URL, by external application URL, or by company + role (reposts get new ids). */
  async findDuplicate(jobUrl, company = "", role = "", applyUrl = "") {
    const id = await jobId(jobUrl), ak = urlKey(applyUrl), nk = nameKey(company, role);
    return (await this.rows()).find((r) => r.id === id || r.job_url === jobUrl || (ak && urlKey(r.apply_url) === ak) ||
      (company && role && nameKey(r.company, r.role) === nk)) || null;
  }

  upsert(id, fields) {
    const run = this.queue.then(async () => {
      const bad = Object.keys(fields).filter((k) => !COLUMNS.includes(k));
      if (bad.length) throw new DataError(`unknown tracker columns: ${bad}`);
      if ("stage" in fields && !STAGES.has(fields.stage)) throw new DataError(`invalid stage ${fields.stage}`);
      const rows = await this.rows();
      let row = rows.find((r) => r.id === id);
      if (!row) {
        row = { ...Object.fromEntries(COLUMNS.map((c) => [c, ""])), id, date_found: today() };
        rows.push(row);
      }
      for (const [k, v] of Object.entries(fields)) if (v !== undefined && v !== null) row[k] = String(v);
      row.last_updated = today();
      await this.f.write("tracker.csv", toCsv([COLUMNS, ...rows.map((r) => COLUMNS.map((c) => r[c]))]));
      return row;
    });
    this.queue = run.catch(() => {});
    return run;
  }
}

// ---- everything together ------------------------------------------------------------------------
export class Data {
  constructor(folder) {
    this.folder = folder;
    this.memory = new Memory(folder);
    this.tracker = new Tracker(folder);
  }

  posting(id) {
    return this.folder.read(`jobs/${id}.md`).then((t) => t || "");
  }

  async log(name, rec) {
    await this.folder.append(`logs/${name}`, JSON.stringify({ ts: new Date().toISOString(), ...rec }) + "\n");
  }
}
