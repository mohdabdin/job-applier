// The data folder, tracker, memory guards, jobs, the fill plan's guards, discovery and CV variants.
// Run: node --test test/

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { tempFolder, fakeAi } from "./fs-handle.js";
import { Folder } from "../extension/lib/store.js";
import { Data, parseCsv, toCsv, jobId, urlKey } from "../extension/lib/data.js";
import * as fill from "../extension/lib/fill.js";
import * as disc from "../extension/lib/discover.js";
import * as jobs from "../extension/lib/jobs.js";
import { makeVariant, renderCv } from "../extension/lib/cv.js";
import * as setup from "../extension/lib/setup.js";

const EXAMPLE = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "examples", "data");

async function exampleData(extra = {}) {
  const files = {};
  async function walk(dir) {
    for (const d of await fs.readdir(dir, { withFileTypes: true })) {
      const p = path.join(dir, d.name);
      if (d.isDirectory()) await walk(p);
      else files[path.relative(EXAMPLE, p)] = await fs.readFile(p);
    }
  }
  await walk(EXAMPLE);
  const t = await tempFolder({ ...files, ...extra });
  return { ...t, data: new Data(new Folder(t.handle)) };
}

// ---- store / data --------------------------------------------------------------------------
test("folder paths can't climb out", async () => {
  const { handle } = await tempFolder();
  const f = new Folder(handle);
  for (const bad of ["../x", "a/../../x", "/etc/passwd", "", "a//b", "a\\b"]) await assert.rejects(f.write(bad, "x"), /bad path/);
  await f.write("a/b/c.txt", "hi");
  await f.append("a/b/c.txt", " there");
  assert.equal(await f.read("a/b/c.txt"), "hi there");
  assert.equal(await f.read("nope.txt"), null);
  assert.deepEqual(await f.list("a/b"), ["c.txt"]);
});

test("csv round trip with quotes, commas and newlines", () => {
  const rows = [["id", "notes"], ["1", 'says "hi", then\nleaves'], ["2", ""]];
  assert.deepEqual(parseCsv(toCsv(rows)), rows);
});

test("job ids and url keys", async () => {
  assert.equal(await jobId("https://www.linkedin.com/jobs/view/senior-dev-4481906852/"), "li-4481906852");
  assert.match(await jobId("https://jobs.lever.co/acme/1"), /^job-[0-9a-f]{10}$/);
  assert.equal(urlKey("https://www.Jobs.Ashbyhq.com/acme/1/?utm=x#y"), "jobs.ashbyhq.com/acme/1");
});

test("tracker: upsert in place, duplicates by url, apply url and company+role", async () => {
  const { data } = await exampleData();
  await data.tracker.upsert("li-1", { company: "Acme", role: "FDE", job_url: "https://www.linkedin.com/jobs/view/1/", apply_url: "https://jobs.lever.co/acme/1?src=li", stage: "found" });
  await data.tracker.upsert("li-1", { stage: "in_progress" });
  const rows = await data.tracker.rows();
  assert.equal(rows.filter((r) => r.id === "li-1").length, 1);
  assert.equal((await data.tracker.get("li-1")).stage, "in_progress");
  assert.equal((await data.tracker.findDuplicate("https://www.linkedin.com/jobs/view/2/", "", "", "https://jobs.lever.co/acme/1")).id, "li-1");
  assert.equal((await data.tracker.findDuplicate("https://www.linkedin.com/jobs/view/3/", "ACME", "fde")).id, "li-1");
  await assert.rejects(data.tracker.upsert("li-1", { stage: "bogus" }), /invalid stage/);
  await assert.rejects(data.tracker.upsert("li-1", { salary_band: "x" }), /unknown tracker columns/);
});

test("learned memory: kebab-case top-level files only, index kept", async () => {
  const { data } = await exampleData();
  await data.memory.writeLearned("notice-period.md", "Notice period", "Four weeks.");
  await data.memory.writeLearned("notice-period.md", "Notice period and start date", "Four weeks; can start 1 Dec.");
  const idx = await data.folder.read("memory/INDEX.md");
  assert.equal(idx.match(/notice-period\.md\]/g).length, 1);
  assert.match(idx, /Notice period and start date/);
  for (const bad of ["../profile/preferences.md", "profile/x.md", "INDEX.md", "Notice.md", "x.txt"]) {
    await assert.rejects(data.memory.writeLearned(bad, "x", "y"), /invalid memory file name/);
  }
  assert.equal(await data.memory.name(), "Sam Rivera");
  await data.folder.write("profile/profile.md", "no heading here");
  assert.equal(await data.memory.name(), "Sam Rivera"); // from the CV, not "# Job preferences"
});

// ---- jobs -----------------------------------------------------------------------------------
test("match, queue and applied with proof", async () => {
  const { data } = await exampleData();
  await data.tracker.upsert("li-1", { company: "Acme", role: "FDE", job_url: "https://www.linkedin.com/jobs/view/1/", apply_url: "https://jobs.ashbyhq.com/acme/abc-123?utm_source=li", stage: "found" });
  assert.equal((await jobs.match(data, "https://jobs.ashbyhq.com/acme/abc-123/application?x=1")).id, "li-1");
  assert.equal(await jobs.match(data, "https://jobs.ashbyhq.com/acme/abc-1234"), null);
  assert.deepEqual((await jobs.queue(data)).map((r) => r.id), ["li-1"]);
  const row = await jobs.setStage(data, "li-1", { stage: "applied", cv: "backend.pdf", screenshot: "data:image/jpeg;base64,aGk=" });
  assert.equal(row.cv_used, "backend.pdf");
  const proof = row.notes.split("Proof: ")[1];
  assert.equal(new TextDecoder().decode(await data.folder.readBytes(proof)), "hi");
  await assert.rejects(jobs.setStage(data, "li-1", { stage: "interviewing" }), /stage must be/);
  const made = await jobs.createJob(data, { url: "https://boards.greenhouse.io/x/jobs/9", company: "X", role: "Dev" });
  assert.equal(made.stage, "in_progress");
});

// ---- the fill plan -------------------------------------------------------------------------
const answer = (a) => ({ value: "", choices: [], source: "", reason: "", question: "", draft: "", remember: false, ...a });
const planOut = (a) => ({ company: "Acme", role: "FDE", cv: "nope.pdf", cv_reason: "", new_cv_slug: "", new_cv_base: "",
  new_cv_target_roles: "", new_cv_emphasis: "", answers: [], notes: "", ...a });

test("plan guards: choices, missing fields, unknown ids, CV", async () => {
  const { data } = await exampleData();
  await data.tracker.upsert("li-1", { company: "Acme", role: "FDE", job_url: "https://www.linkedin.com/jobs/view/1/", stage: "found" });
  const fields = [{ id: "0:f1", kind: "text", label: "Name", required: true },
    { id: "0:f2", kind: "radio", label: "Sponsorship?", options: ["Yes", "No"], required: true },
    { id: "3:f1", kind: "combobox", label: "Visa?", options: ["Yes", "No"] },
    { id: "0:f3", kind: "textarea", label: "Why us?", required: true }];
  const { ai, calls } = fakeAi(planOut({ answers: [
    answer({ id: "0:f1", action: "fill", value: "Sam Rivera", source: "profile" }),
    answer({ id: "0:f2", action: "choose", choices: ["yes"] }),
    answer({ id: "3:f1", action: "choose", choices: ["Maybe"] }),
    answer({ id: "9:f9", action: "fill", value: "x" })] }));
  const out = await fill.plan({ data, ai }, { job_id: "li-1", page: { url: "https://x" }, fields });
  const by = Object.fromEntries(out.answers.map((a) => [a.id, a]));
  assert.deepEqual(out.answers.map((a) => a.id), ["0:f1", "0:f2", "3:f1", "0:f3"]);
  assert.deepEqual(by["0:f2"].choices, ["Yes"]);
  assert.equal(by["3:f1"].action, "ask");
  assert.equal(by["0:f3"].action, "ask");
  assert.equal(out.cv, "backend.pdf"); // not a real file → the first CV
  assert.match(calls[0].prompt, /Acme — FDE/);
  assert.match(calls[0].system, /for Sam Rivera/);
  assert.match(await data.folder.read("logs/plans.jsonl"), /"job_id":"li-1"/);
});

test("plan keeps a new CV only when it can be made", async () => {
  const { data } = await exampleData();
  const upload = [{ id: "0:f1", kind: "file", label: "Resume" }];
  const nw = { new_cv_slug: "data-engineer", new_cv_base: "backend", new_cv_target_roles: "Data Engineer", new_cv_emphasis: "SQL" };
  const mk = (a) => planOut({ cv: "backend.pdf", answers: [answer({ id: "0:f1", action: "upload_cv" })], ...a });
  const run = async (out, fields = upload, opts) => fill.plan({ data, ai: fakeAi(out).ai }, { page: { url: "https://x" }, fields }, opts);
  assert.equal((await run(mk(nw))).new_cv_slug, "data-engineer");
  assert.equal((await run(mk({ ...nw, answers: [] }), [{ id: "0:f1", kind: "text", label: "Name" }])).new_cv_slug, "");
  assert.equal((await run(mk({ ...nw, new_cv_base: "nope" }))).new_cv_slug, "");
  const reused = await run(mk({ ...nw, new_cv_slug: "backend" }));
  assert.equal(reused.new_cv_slug, "");
  assert.equal(reused.cv, "backend.pdf");
  assert.equal((await run(mk(nw), upload, { canMakeCv: false })).new_cv_slug, "");
});

test("remember: saves reusable answers, declines company-specific, rejects bad paths", async () => {
  const { data } = await exampleData();
  const { ai } = fakeAi({ save: true, file: "notice-period.md", summary: "Notice period", content: "Four weeks." },
    { save: true, file: "../profile/preferences.md", summary: "x", content: "hijack" },
    { save: false, file: "why-acme.md", summary: "x", content: "x" });
  assert.equal((await fill.remember({ data, ai }, { question: "Notice?", answer: "Four weeks" })).file, "notice-period.md");
  await assert.rejects(fill.remember({ data, ai }, { question: "x", answer: "y" }), /invalid memory file name/);
  assert.equal((await fill.remember({ data, ai }, { question: "Why Acme?", answer: "Because" })).saved, false);
  assert.match(await data.folder.read("profile/preferences.md"), /Backend/);
});

// ---- discovery ------------------------------------------------------------------------------
const fit = (a) => ({ company: "Robo", role: "Backend Engineer", location: "London", work_mode: "hybrid", salary: "",
  fit: "strong", fit_reason: "Matches.", dealbreaker: "", key_requirements: "Go, Postgres", ...a });
const PANE = "About the job\n" + "We build robots. ".repeat(30);

test("assess: queues good fits, records the rest, enforces dealbreakers", async () => {
  const { data } = await exampleData();
  const { ai } = fakeAi(fit(), fit({ company: "Nope", role: "SWE", dealbreaker: "needs visa sponsorship" }), fit({ role: "Backend Engineer II" }));
  const ctx = { data, ai };
  await data.tracker.upsert("li-7", { company: "Old", role: "X", job_url: "https://www.linkedin.com/jobs/view/7/", stage: "skipped" });
  assert.deepEqual(await disc.known(data, ["7", "8"]), ["7"]);
  let r = await disc.assess(ctx, { id: "8", card: "Robo", pane: PANE, applyHref: "https://www.linkedin.com/safety/go/?url=https%3A%2F%2Fjobs.lever.co%2Frobo%2F1", hasApply: true });
  assert.equal(r.status, "found");
  assert.equal(r.job.apply_url, "https://jobs.lever.co/robo/1");
  assert.match(await data.folder.read("jobs/li-8.md"), /We build robots/);
  r = await disc.assess(ctx, { id: "9", card: "Nope", pane: PANE, applyHref: "https://boards.greenhouse.io/nope/1", hasApply: true });
  assert.equal(r.status, "skipped");
  assert.equal(r.fit, "poor");
  r = await disc.assess(ctx, { id: "10", card: "Robo II", pane: PANE, hasApply: true });
  assert.equal(r.job.apply_url, "https://www.linkedin.com/jobs/view/10/");
  assert.equal((await disc.assess(ctx, { id: "11", card: "x", pane: PANE, easy: true })).status, "easy_apply");
  assert.equal((await disc.assess(ctx, { id: "8", card: "x", pane: PANE, hasApply: true })).status, "tracked");
  await assert.rejects(disc.assess(ctx, { id: "../8", card: "x", pane: PANE }), /bad LinkedIn job id/);
  await assert.rejects(disc.assess(ctx, { id: "12", card: "x", pane: "short" }), /didn't load/);
});

test("search plan is cached until preferences change", async () => {
  const { data } = await exampleData();
  const { ai, calls } = fakeAi({ queries: [{ keywords: "Backend Engineer", location: "London" }] },
    { queries: [{ keywords: "Platform Engineer", location: "Berlin" }] });
  const a = await disc.searches({ data, ai });
  assert.match(a.queries[0].url, /keywords=Backend%20Engineer&location=London/);
  await disc.searches({ data, ai });
  assert.equal(calls.length, 1);
  await data.folder.append("profile/preferences.md", "\n- Platform Engineer\n");
  assert.equal((await disc.searches({ data, ai })).queries[0].keywords, "Platform Engineer");
});

// ---- CVs ------------------------------------------------------------------------------------
test("a variant is fact-checked, retried, saved; existing CVs untouched", async () => {
  const { data } = await exampleData();
  const base = await data.folder.read("profile/cvs/backend.md");
  const { ai, calls } = fakeAi({ markdown: base + "\n- Led a team of 40 at NASA.", changes: "x" },
    { unsupported_claims: ["Led a team of 40 at NASA"], ok: false },
    { markdown: base.replace("## EXPERIENCE", "## EXPERIENCE\n"), changes: "Data pipelines first" },
    { unsupported_claims: [], ok: true });
  const out = await makeVariant({ data, ai }, { slug: "data-engineer", base: "backend", target_roles: "Data Engineer", emphasis: "pipelines" });
  assert.equal(out.created, true);
  assert.equal(new TextDecoder().decode((await data.folder.readBytes("profile/cvs/data-engineer.pdf")).slice(0, 5)), "%PDF-");
  assert.doesNotMatch(await data.folder.read("profile/cvs/data-engineer.md"), /NASA/);
  assert.match(await data.folder.read("profile/cvs/INDEX.md"), /`data-engineer\.md` \/ `\.pdf` — Data Engineer — based on backend — Data pipelines first/);
  assert.match(calls[2].prompt, /rejected[\s\S]*NASA/);
  assert.equal(await data.folder.read("profile/cvs/backend.md"), base);
  assert.deepEqual(await makeVariant({ data, ai }, { slug: "data-engineer", base: "backend" }), { cv: "data-engineer.pdf", created: false, cost_usd: 0 });
  for (const bad of ["../backend", "Acme CV"]) await assert.rejects(makeVariant({ data, ai }, { slug: bad, base: "backend" }), /bad CV name/);
});

test("a variant that fails the fact check twice isn't saved", async () => {
  const { data } = await exampleData();
  const base = await data.folder.read("profile/cvs/backend.md");
  const bad = { unsupported_claims: ["PhD"], ok: false };
  const { ai } = fakeAi({ markdown: base, changes: "x" }, bad, { markdown: base, changes: "x" }, bad);
  await assert.rejects(makeVariant({ data, ai }, { slug: "ml-engineer", base: "backend", target_roles: "ML", emphasis: "x" }), /didn't pass the checks/);
  assert.equal(await data.folder.exists("profile/cvs/ml-engineer.md"), false);
});

test("the example CV renders to one page", async () => {
  const md = await fs.readFile(path.join(EXAMPLE, "profile/cvs/backend.md"), "utf8");
  const r = await renderCv(md);
  assert.equal(r.pages, 1);
  assert.ok(r.bytes.length > 5000);
});

// ---- setup ----------------------------------------------------------------------------------
test("setup writes profile, preferences and standard answers", async () => {
  const { handle } = await tempFolder();
  const data = new Data(new Folder(handle));
  await setup.writeCvs(data.folder, [{ slug: "backend", targets: "backend roles", pdf: new Uint8Array([37, 80, 68, 70]), markdown: "# Sam Rivera\n" }]);
  await data.folder.write("profile/profile.md", setup.profileMarkdown({ name: "Sam Rivera", email: "sam@example.com", links: [{ label: "GitHub", url: "https://github.com/x" }] }));
  await data.folder.write("profile/preferences.md", setup.preferencesMarkdown({ roles: "Backend\nPlatform", locations: "London", modes: ["remote"] }));
  const saved = await setup.writeStandardAnswers(data.memory, { "notice-period": "One month", salary: "" });
  assert.deepEqual(saved, ["notice-period"]);
  assert.equal(await data.memory.name(), "Sam Rivera");
  assert.match(await data.folder.read("profile/cvs/INDEX.md"), /`backend\.md` \/ `\.pdf` — backend roles/);
  assert.match(await data.folder.read("profile/preferences.md"), /- Backend\n- Platform/);
  assert.match(await data.folder.read("memory/INDEX.md"), /notice-period\.md/);
  assert.equal(setup.slugify("Senior Backend (EU).pdf"), "senior-backend-eu-pdf");
});
