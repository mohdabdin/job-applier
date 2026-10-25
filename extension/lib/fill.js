// "Fill this page": one model call turns the form's fields into one answer each, then code checks the answers.
// Also: saving an answer the user typed into learned memory.
//
// ctx: { data: Data, ai(role, {system, prompt, schema, files}) → {data, cost_usd} }

import { bool, list, obj, oneOf, str } from "./schema.js";

const SLUG = /^[a-z0-9][a-z0-9-]{2,50}$/;

const ANSWER = obj({
  id: str("the field's id, unchanged"),
  action: oneOf(["fill", "choose", "check", "upload_cv", "ask", "skip"]),
  value: str("fill: the text to enter. check: 'yes' to tick, 'no' to leave unticked. Otherwise empty"),
  choices: list(str(), "choose: option(s) copied exactly from the field's options (one, except checkbox groups); " +
    "for a search-as-you-type field, the text to type. Otherwise empty"),
  source: str("profile | cv:<file> | memory:<file> | job posting | drafted"),
  reason: str("skip/ask: why, in a few words"),
  question: str("ask: the question to show the candidate, short"),
  draft: str("ask: your proposed answer from their real facts, if you have one"),
  remember: bool("ask: true if their answer is reusable in other applications"),
});

export const PLAN = obj({
  company: str(),
  role: str(),
  cv: str("PDF file name of the best existing CV, from cvs/INDEX.md, e.g. fde.pdf; empty if there's no CV"),
  cv_reason: str("one line: why this CV, or why a new variant; empty if the form has no CV upload"),
  new_cv_slug: str("only when a new variant is worth it: its role-type name, kebab-case, e.g. 'ai-platform-engineer' " +
    "(never a company name); else empty"),
  new_cv_base: str("new variant: the file name (without .pdf) of the CV it starts from; else empty"),
  new_cv_target_roles: str("new variant: the role titles it targets; else empty"),
  new_cv_emphasis: str("new variant: what to bring forward, in the posting's own terms (must-have skills, tools, " +
    "domain words), and which of their real experience shows each; else empty"),
  answers: list(ANSWER),
  notes: str("anything the candidate should know before submitting, else empty"),
});

const FILL_SYSTEM = (name, day, profile, learned) => `You fill in a job application form for ${name}. A Chrome extension has read the form's fields; you decide what goes in each one. ${name} reviews everything and clicks Submit themselves. Today is ${day}.

## Rules
- Only use facts from their profile, CVs and learned memory below. Tailor the wording to the company, but never invent experience, dates, numbers, qualifications, skills or eligibility answers.
- Give every field exactly one answer, with the same id. Pick the action:
  - \`fill\`: text fields. Respect \`max_length\`. Use the format the field implies: phone with country code, full URLs, \`date\` fields as YYYY-MM-DD.
  - \`choose\`: selects, radios, comboboxes and checkbox groups. \`choices\` must be copied exactly from the field's \`options\`. If a combobox lists no options (search-as-you-type, like location or school), put the text to type in \`choices[0]\`.
  - \`check\`: a single checkbox. Tick ("yes") required consent to processing their data for this application; leave marketing and newsletter opt-ins unticked ("no").
  - \`upload_cv\`: the resume/CV file field.
  - \`ask\`:
    - the answer isn't in their profile or memory, or memory doesn't cover this exact case;
    - legal status, right to work, visa sponsorship, salary, notice period, start date, relocation, or anything else they'll be held to, unless memory settles it;
    - their history with this company (applied or interviewed before, knows someone there), unless memory says;
    - open-ended questions ("Why do you want to work here?", "Tell us about a time…"): always ask, with a strong \`draft\` built from their real experience and this job;
    - anything you're unsure of.
    \`question\` is what they see (short). Set \`remember\` for answers they'd reuse elsewhere (salary, notice period, skills), not for company-specific ones.
  - \`skip\`: optional fields with nothing true to put; fields already holding the right value; cover-letter and other file uploads except the CV (if one of those is required, \`ask\` instead); anything that isn't part of the application (site search, newsletter sign-up, cookie or language pickers).
- Demographic, EEO and diversity questions: follow learned memory if it covers them; otherwise choose "Prefer not to say" / "Decline to self-identify" or the closest option when offered; otherwise ask.
- Never fill passwords or payment details.
- A field marked \`unclear\` is one whose question couldn't be read from the page; its \`context\` is the text around it (⟦THIS FIELD⟧ marks where it sits). Work out the question from that and the page text. If you still can't tell, \`ask\`, with a \`question\` that says where the field is ("the second text box under 'Preliminary questions'").
- \`source\` says where each answer comes from.

## CV (think like the ATS)
Only when the form has a CV/resume upload field. Work out how an ATS and a recruiter will screen this role: the must-have skills, tools, titles and domain terms, in the posting's exact wording. Compare them with the CVs in \`cvs/INDEX.md\` (their own CVs and variants made earlier).
- \`cv\` is always the best existing CV's PDF file name. Prefer reusing one: if an existing CV already covers what matters, that's the answer and the \`new_cv_*\` fields stay empty.
- Ask for a new variant (\`new_cv_slug\` etc.) only when a meaningfully different emphasis would clearly improve their chances: the role's core terms are missing from or buried in every existing CV, yet their real experience covers them. Not for a word or two.
- Name it by role type so it's reused for similar jobs (\`robotics-software-engineer\`, not \`acme\`). A variant only reorders, reframes and trims their real experience; it can't add facts.

\`company\` and \`role\` come from the job or the page. \`notes\`: anything they should know before submitting (for example, the form says there's no visa sponsorship), otherwise empty.

<profile>
${profile}
</profile>

<learned_memory>
${learned}
</learned_memory>`;

const longDate = () => new Date().toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long", year: "numeric" });

/** req: { job_id, page: {url, title, text}, fields: [...] } → the checked plan + cost_usd + seconds. */
export async function plan(ctx, req, { canMakeCv = true } = {}) {
  const { data } = ctx;
  const row = req.job_id ? await data.tracker.get(req.job_id) : null;
  let job;
  if (row) {
    job = `${row.company} — ${row.role}\nLocation: ${row.location} (${row.work_mode})\nSalary: ${row.salary || "not stated"}\n` +
      `Notes from discovery: ${row.notes}\n\n${(await data.posting(row.id)) || "(full posting not saved; see the page text)"}`;
  } else {
    job = "(not a tracked job: work out the company and role from the page)";
  }
  const fields = req.fields.map((f) => Object.fromEntries(Object.entries(f).filter(([, v]) => v !== "" && v !== false && v !== null && !(Array.isArray(v) && !v.length))));
  const prompt = `<job>\n${job}\n</job>\n\n<page url="${req.page.url}" title="${req.page.title || ""}">\n${(req.page.text || "").slice(0, 6000)}\n</page>\n\n` +
    `<fields>\n${JSON.stringify(fields, null, 1)}\n</fields>`;
  const m = data.memory;
  const system = FILL_SYSTEM(await m.name(), longDate(), await m.profileText(), await m.learnedText());
  const start = Date.now();
  const r = await ctx.ai("fill", { system, prompt, schema: PLAN });
  const p = await checkPlan(data, r.data, req.fields, { canMakeCv });
  const out = { ...p, cost_usd: r.cost_usd, seconds: Math.round((Date.now() - start) / 100) / 10 };
  await data.log("plans.jsonl", { job_id: req.job_id, url: req.page.url, fields, plan: out }).catch(() => {});
  return out;
}

/** Code-side guards: every field answered once, choices really offered, the CV a real file. */
export async function checkPlan(data, plan, fields, { canMakeCv = true } = {}) {
  const byId = new Map(fields.map((f) => [f.id, f]));
  const seen = new Map();
  const norm = (s) => String(s).toLowerCase().trim();
  for (const a of plan.answers) {
    const f = byId.get(a.id);
    if (!f || seen.has(a.id)) continue;
    if (a.action === "choose" && f.options?.length) {
      const offered = new Map(f.options.map((o) => [norm(o), o]));
      const kept = (a.choices || []).map((c) => offered.get(norm(c))).filter(Boolean);
      if (!kept.length) {
        a.reason = `suggested ${JSON.stringify(a.choices)}, which isn't one of the options`;
        a.action = "ask";
        a.question ||= f.label;
      } else a.choices = kept;
    }
    seen.set(a.id, a);
  }
  for (const f of fields) {
    if (!seen.has(f.id)) {
      seen.set(f.id, { id: f.id, action: f.required ? "ask" : "skip", value: "", choices: [], source: "",
        reason: "not answered by the model", question: f.label, draft: "", remember: false });
    }
  }
  plan.answers = fields.map((f) => seen.get(f.id));

  const cvs = await data.folder.list("profile/cvs");
  const pdfs = cvs.filter((n) => n.endsWith(".pdf"));
  if (!pdfs.includes(plan.cv)) plan.cv = pdfs[0] || "";
  let slug = plan.new_cv_slug.replace(/\.pdf$/, "").trim();
  if (slug && pdfs.includes(`${slug}.pdf`)) { // made for an earlier job of this type
    plan.cv = `${slug}.pdf`;
    slug = "";
  }
  const hasUpload = plan.answers.some((a) => a.action === "upload_cv");
  const base = plan.new_cv_base.replace(/\.(pdf|md)$/, "");
  if (!(hasUpload && SLUG.test(slug) && cvs.includes(`${base}.md`))) slug = "";
  if (slug && !canMakeCv) {
    plan.cv_reason = `${plan.cv_reason} (A new variant would fit better; set up CV writing in Settings to make one.)`.trim();
    slug = "";
  }
  plan.new_cv_slug = slug;
  plan.new_cv_base = slug ? base : "";
  if (!slug) plan.new_cv_target_roles = plan.new_cv_emphasis = "";
  return plan;
}

// ---- unclear questions ---------------------------------------------------------------------------
// The form reader flags fields whose question the markup doesn't make clear (no label, the same label on several
// fields) and sends their surroundings. One cheap call reads the questions from that text; the panel can follow up
// with screenshots of the fields it still couldn't place.
const CLARIFY = obj({
  fields: list(obj({
    id: str("the field's id, unchanged"),
    label: str("the question this field asks, worded as on the page; empty if you can't tell"),
    help: str("instructions or limits the page gives for it (word counts, format), else empty"),
  })),
});

const CLARIFY_SYSTEM = `A browser extension is reading a job application form. For some fields it couldn't tell which question they ask from the page's markup: there's no label, or several fields share one. For each field you get what it did read (\`label_read\`), the field's kind and options, and the text around it on the page, with ⟦THIS FIELD⟧ where the field sits and ⟦other field⟧ for other fields. Screenshots, when attached, show the field outlined in red.

Give the question each field asks, the way a person looking at the form would read it: usually the text just before ⟦THIS FIELD⟧ (or just after, for a checkbox), not a section heading shared by several fields. When numbered questions share a heading, each field gets its own question. \`label_read\` is what didn't work (often an attribute like "custom q 77"), so don't repeat it. Never make a question up: if the text and screenshot don't show it, leave \`label\` empty.`;

/** fields: the unclear ones (each with `context`); shots: [{id, data}] JPEG screenshots. Updates labels in place. */
export async function clarify(ctx, fields, shots = []) {
  if (!fields.length) return { unresolved: [], cost_usd: 0 };
  const items = fields.map((f) => ({ id: f.id, kind: f.kind, label_read: f.label, section: f.section || "",
    options: f.options || [], surroundings: f.context || "" }));
  const pics = shots.length ? `Screenshots, in order, show these fields outlined: ${shots.map((s) => s.id).join(", ")}.\n\n` : "";
  const r = await ctx.ai("clarify", { system: CLARIFY_SYSTEM, schema: CLARIFY,
    prompt: `${pics}<fields>\n${JSON.stringify(items, null, 1)}\n</fields>`,
    files: shots.map((s) => ({ mimeType: "image/jpeg", data: s.data })) });
  const got = new Map(r.data.fields.map((x) => [x.id, x]));
  const unresolved = [];
  for (const f of fields) {
    const g = got.get(f.id);
    const label = (g?.label || "").trim();
    if (!label || label.toLowerCase() === f.label.toLowerCase()) { unresolved.push(f); continue; } // echoing what failed isn't an answer
    f.label_read = f.label;
    f.label = label;
    if (g.help.trim() && !f.help) f.help = g.help.trim();
    delete f.unclear;
    delete f.context;
  }
  return { unresolved, cost_usd: r.cost_usd };
}

// ---- memory writes -------------------------------------------------------------------------------
const MEMORY_WRITE = obj({
  save: bool("false if the answer only makes sense for this company"),
  file: str("kebab-case file name like notice-period.md; reuse an existing file for the same topic"),
  summary: str("one line for INDEX.md: what this file answers"),
  content: str("the file's full new content (markdown, no frontmatter): keep what an existing file already says and " +
    "add or update this answer, noting where it applies"),
});

const MEMORY_SYSTEM = (name, learned) => `You keep ${name}'s learned memory: short markdown files, one topic each, holding answers they gave to application questions so they're never asked twice. Decide where the new answer goes. Update an existing file when it's the same topic rather than creating a near-duplicate. Write the answer faithfully: don't add facts they didn't give.

<learned_memory>
${learned}
</learned_memory>`;

export async function remember(ctx, { question, answer, company = "", role = "" }) {
  const m = ctx.data.memory;
  const prompt = `Application: ${company} — ${role}\nQuestion on the form: ${question}\nTheir answer: ${answer}`;
  const r = await ctx.ai("memory", { system: MEMORY_SYSTEM(await m.name(), await m.learnedText()), prompt, schema: MEMORY_WRITE });
  if (!r.data.save) return { saved: false, cost_usd: r.cost_usd };
  const file = await m.writeLearned(r.data.file, r.data.summary, r.data.content);
  return { saved: true, file, summary: r.data.summary, cost_usd: r.cost_usd };
}

