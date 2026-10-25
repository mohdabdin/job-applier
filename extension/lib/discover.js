// Finding jobs on LinkedIn, minus the browser: the search plan, the fit assessment, tracker writes.
// linkedin.js reads the cards and detail panes; the panel paces it; this judges what it read.
//
// ctx: { data: Data, ai(role, args) → {data, cost_usd} }

import { list, obj, oneOf, str } from "./schema.js";

const SEARCH_URL = "https://www.linkedin.com/jobs/search-results/?keywords={kw}&location={loc}&f_TPR=r604800&sortBy=DD";

const SEARCH_PLAN = obj({
  queries: list(obj({
    keywords: str("LinkedIn search keywords: one role or theme, e.g. 'Forward Deployed Engineer' or 'robotics software'"),
    location: str("a place name LinkedIn understands: a country, region or city, e.g. 'United Kingdom', 'Berlin', 'Remote'"),
  }), "most important first, at most 8"),
});

const ASSESSMENT = obj({
  company: str(),
  role: str(),
  location: str(),
  work_mode: oneOf(["onsite", "hybrid", "remote", ""]),
  salary: str("as stated, or empty"),
  fit: oneOf(["strong", "maybe", "poor"]),
  fit_reason: str("one or two sentences"),
  dealbreaker: str("the preference this posting clearly breaks, quoted from the preferences (e.g. 'needs visa " +
    "sponsorship' when the posting says it won't sponsor), or empty if none"),
  key_requirements: str("must-have skills, tools, years and the ad's exact phrases (<= 1500 chars)"),
});

const PLAN_PROMPT = (name, prefs) => `Turn ${name}'s job preferences into LinkedIn job searches.

Return up to 8 queries, most important first, following the priority order in the preferences. Use short keyword phrases a recruiter would put in a job title or description (one role or theme per query). Run each across the locations the preferences target (one query per keyword + location).

<preferences>
${prefs}
</preferences>`;

const ASSESS_SYSTEM = (name, profile) => `You assess LinkedIn job postings for ${name}. Their profile, preferences and CVs follow. Judge how well the posting fits their preferences:
- strong: clearly matches;
- maybe: worth applying, with some gaps or unknowns;
- poor: wrong location, seniority, domain, company type, or anything the preferences rule out.

If the posting clearly breaks a hard requirement in the preferences (sponsorship, location, work mode, salary floor, an excluded industry), name it in \`dealbreaker\`. Extract facts only from the posting; never invent them.

${profile}`;

async function sha(text) {
  const h = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
  return [...h].map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 16);
}

export const searchUrl = (q, page = 0) =>
  SEARCH_URL.replace("{kw}", encodeURIComponent(q.keywords)).replace("{loc}", encodeURIComponent(q.location)) +
  (page ? `&start=${page * 25}` : "");

/** preferences.md → searches (one model call, cached until the file changes). */
export async function searches(ctx) {
  const { folder, memory } = ctx.data;
  const prefs = await folder.read("profile/preferences.md");
  if (!prefs) throw new Error("No preferences yet: finish setup (profile/preferences.md).");
  const digest = await sha(prefs);
  try {
    const cached = JSON.parse((await folder.read("cache/search-plan.json")) || "{}");
    if (cached.prefs_sha === digest) return { queries: cached.queries, cost_usd: 0 };
  } catch {}
  const r = await ctx.ai("searches", { prompt: PLAN_PROMPT(await memory.name(), prefs), schema: SEARCH_PLAN });
  const queries = r.data.queries.slice(0, 8).map((q) => ({ ...q, url: searchUrl(q) }));
  await folder.write("cache/search-plan.json", JSON.stringify({ prefs_sha: digest, queries }, null, 1));
  return { queries, cost_usd: r.cost_usd };
}

/** LinkedIn wraps the company's application link in /safety/go/?url=… */
export function externalUrl(href) {
  if (href && href.includes("/safety/go/")) {
    try { return new URL(href).searchParams.get("url") || ""; } catch { return ""; }
  }
  return href || "";
}

/** LinkedIn ids already in the tracker (any stage), so they're never opened again. */
export async function known(data, ids) {
  const tracked = new Set((await data.tracker.rows()).map((r) => r.id));
  return ids.filter((i) => tracked.has(`li-${i}`));
}

/**
 * One opened listing → its outcome. `applyHref`: the "Apply on company website" link, if the pane has one.
 * An Apply control without a readable link keeps the job with its LinkedIn URL (Apply is clicked there).
 * Returns { status: found|skipped|duplicate|easy_apply|no_apply_link|tracked, job_id, reason, job, company, role, fit, cost_usd }
 */
export async function assess(ctx, { id, card, pane, applyHref = "", easy = false, hasApply = false }, { minFit = "maybe" } = {}) {
  const { data } = ctx;
  if (!/^\d+$/.test(id || "")) throw new Error("bad LinkedIn job id");
  if ((pane || "").length < 200) throw new Error("the job's description didn't load");
  const jid = `li-${id}`;
  const tracked = await data.tracker.get(jid);
  if (tracked) return { status: "tracked", job_id: jid, job: tracked, cost_usd: 0 };
  if (easy && !applyHref) return { status: "easy_apply", job_id: jid, cost_usd: 0 };
  const jobUrl = `https://www.linkedin.com/jobs/view/${id}/`;
  const applyUrl = externalUrl(applyHref) || (hasApply ? jobUrl : "");
  if (!applyUrl) return { status: "no_apply_link", job_id: jid, cost_usd: 0 };

  const m = data.memory;
  const r = await ctx.ai("assess", {
    system: ASSESS_SYSTEM(await m.name(), await m.profileText()),
    prompt: `<card>\n${card.slice(0, 1000)}\n</card>\n\n<posting>\n${pane.slice(0, 15000)}\n</posting>`,
    schema: ASSESSMENT,
  });
  const a = r.data;
  if (a.dealbreaker && a.fit !== "poor") { // a stated hard requirement, enforced in code
    a.fit = "poor";
    a.fit_reason = `${a.dealbreaker}. ${a.fit_reason}`;
  }
  const out = { job_id: jid, company: a.company, role: a.role, fit: a.fit, reason: a.fit_reason, cost_usd: r.cost_usd };
  const dup = await data.tracker.findDuplicate(jobUrl, a.company, a.role, applyUrl === jobUrl ? "" : applyUrl);
  if (dup) return { ...out, status: "duplicate", reason: `same job as ${dup.company} — ${dup.role}`, job: dup };
  const common = { company: a.company, role: a.role, job_url: jobUrl, apply_url: applyUrl, source: "LinkedIn",
    location: a.location, work_mode: a.work_mode, salary: a.salary };
  const want = minFit === "strong" ? ["strong"] : ["strong", "maybe"];
  if (!want.includes(a.fit)) {
    const job = await data.tracker.upsert(jid, { ...common, stage: "skipped", notes: `Discovery: ${a.fit} fit. ${a.fit_reason}` });
    return { ...out, status: "skipped", job };
  }
  const note = applyUrl === jobUrl ? " Apply opens from the LinkedIn page." : "";
  const job = await data.tracker.upsert(jid, { ...common, stage: "found", notes: `Fit: ${a.fit}. ${a.fit_reason}${note}` });
  await data.folder.write(`jobs/${jid}.md`, `# ${a.company} — ${a.role}\n\nFit: ${a.fit}. ${a.fit_reason}\n\n` +
    `## Key requirements\n\n${a.key_requirements}\n\n## Card\n\n${card}\n\n## Posting\n\n${pane}\n`);
  return { ...out, status: "found", job };
}
