// The queue and a job's lifecycle in tracker.csv: which job a page belongs to, stage changes, proof screenshots.

import { jobId, urlKey } from "./data.js";

const QUEUE_STAGES = new Set(["found", "in_progress", "needs_input", "ready_to_submit"]);
const SET_STAGES = new Set(["found", "in_progress", "applied", "skipped", "failed"]);

/** Started applications first, then the newest finds. */
export async function queue(data) {
  const rows = (await data.tracker.rows()).filter((r) => QUEUE_STAGES.has(r.stage) && r.apply_url);
  rows.sort((a, b) => b.date_found.localeCompare(a.date_found));
  return rows.sort((a, b) => (a.stage !== "in_progress") - (b.stage !== "in_progress"));
}

/** The tracked job this page belongs to: the same application URL, or a page under it (…/apply). */
export async function match(data, url) {
  const key = urlKey(url);
  if (!key) return null;
  for (const r of await data.tracker.rows()) {
    for (const known of [urlKey(r.apply_url), urlKey(r.job_url)]) {
      if (known && (key === known || key.startsWith(known + "/"))) return r;
    }
  }
  return null;
}

/** A page the user opened themselves (not from the queue). */
export async function createJob(data, { url, company, role }) {
  const dup = await data.tracker.findDuplicate(url, company, role, url);
  if (dup) return dup;
  return data.tracker.upsert(await jobId(url), { company, role, job_url: url, apply_url: url, source: "extension", stage: "in_progress" });
}

export async function setStage(data, id, { stage, note = "", cv = "", screenshot = "" }) {
  if (!SET_STAGES.has(stage)) throw new Error(`stage must be one of ${[...SET_STAGES].join(", ")}`);
  const row = await data.tracker.get(id);
  if (!row) throw new Error(`no tracked job ${id}`);
  const fields = { stage };
  let notes = row.notes;
  if (stage === "applied") {
    fields.date_applied = new Date().toLocaleDateString("en-CA");
    if (cv) fields.cv_used = cv;
    if (screenshot) notes = `${notes} Proof: ${await saveProof(data, id, screenshot)}`.trim();
  }
  if (note) notes = `${notes} ${note}`.trim();
  fields.notes = notes;
  return data.tracker.upsert(id, fields);
}

async function saveProof(data, id, dataUrl) {
  const m = dataUrl.match(/^data:image\/(png|jpeg);base64,(.+)$/s);
  if (!m) throw new Error("screenshot must be a PNG or JPEG data URL");
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
  const path = `logs/proof/${id}-${stamp}.${m[1] === "png" ? "png" : "jpg"}`;
  await data.folder.write(path, Uint8Array.from(atob(m[2]), (c) => c.charCodeAt(0)));
  return path;
}
