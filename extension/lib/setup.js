// First-run setup: turns the user's CVs and answers into the data folder's profile/ and memory/.
// After setup, the extension treats profile/ as read-only (only new CV variants are added); the user edits it
// in Settings.

import { list, obj, str } from "./schema.js";

const CV_READ = obj({
  name: str("the person's full name"),
  email: str(), phone: str(), location: str("city, country as written on the CV"),
  links: list(obj({ label: str("e.g. LinkedIn, GitHub, Portfolio"), url: str() })),
  markdown: str("the whole CV transcribed into the markdown format described, word for word"),
});

const CV_FORMAT = `Transcribe this CV into markdown, word for word: don't add, drop, summarise or improve anything. Use exactly this structure, which a renderer depends on:

# Full Name

City, Country | [email@example.com](mailto:email@example.com) | +44 7700 900000 | [LinkedIn](https://...) | [GitHub](https://...)

---

The summary paragraph, if the CV has one.

## EXPERIENCE

**Job Title | [Company](https://company-url-if-on-the-cv)** | Place | **2022–Present**
An optional one-line description of the company or role, if the CV has one.

- A bullet, with **bold** where the CV bolds.

## EDUCATION

**University Name**, Degree (Year). Details.

## SKILLS

Skills as written, separated as on the CV.

Section names follow the CV's own (PROJECTS, CERTIFICATIONS, ...), in capitals. Every role or degree with dates gets the \`**Title | Org** | Place | **Dates**\` line. Keep links that are on the CV.`;

/** One uploaded CV (base64 PDF) → contact details + markdown transcription. */
export async function readCv(ctx, pdfBase64) {
  const r = await ctx.ai("profile", { prompt: CV_FORMAT, schema: CV_READ, files: [{ mimeType: "application/pdf", data: pdfBase64 }] });
  return { ...r.data, cost_usd: r.cost_usd };
}

export const slugify = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 50) || "cv";

/** cvs: [{ slug, targets, pdf: Uint8Array, markdown }] */
export async function writeCvs(folder, cvs) {
  const lines = ["# CV index", "", "One line per CV: `file` — target roles — notes. Each CV is a `.md` text copy plus the `.pdf` that gets uploaded.", "",
    "## Your CVs (never modified by Job Applier)"];
  for (const cv of cvs) {
    await folder.write(`profile/cvs/${cv.slug}.pdf`, cv.pdf);
    await folder.write(`profile/cvs/${cv.slug}.md`, cv.markdown.trim() + "\n");
    lines.push(`- \`${cv.slug}.md\` / \`.pdf\` — ${cv.targets || "general"}`);
  }
  lines.push("", "## Tailored variants", "<!-- Job Applier adds a line here for each variant it makes: file — target roles — based on — what changed — date -->", "");
  await folder.write("profile/cvs/INDEX.md", lines.join("\n"));
}

export function profileMarkdown(p) {
  const links = (p.links || []).filter((l) => l.url).map((l) => `- ${l.label || "Link"}: ${l.url}`).join("\n");
  return `# ${p.name.trim()}

- Email: ${p.email || ""}
- Phone: ${p.phone || ""}
- Location: ${p.location || ""}

## Links

${links || "- (none)"}

## Anything else applications should know

${(p.extra || "").trim() || "(nothing yet)"}
`;
}

export function preferencesMarkdown(p) {
  const bullets = (s) => s.split(/\n|,/).map((x) => x.trim()).filter(Boolean).map((x) => `- ${x}`).join("\n") || "- (not set)";
  return `# Job preferences

## Target roles (most important first)

${bullets(p.roles || "")}

## Locations

${bullets(p.locations || "")}

Work mode: ${(p.modes || []).join(", ") || "any"}

## Seniority

${p.seniority || "(not set)"}

## Salary

${p.salary || "(not set)"}

## Visa sponsorship

${p.sponsorship || "(not set)"}

## Companies and industries

${p.companies || "(no preference)"}

## Dealbreakers (rule these out)

${bullets(p.dealbreakers || "")}

## Anything else

${(p.extra || "").trim() || "(nothing)"}
`;
}

/** The standard questions, saved as learned memory so the first form isn't ten questions. */
export const STANDARD = [
  { key: "work-authorization", q: "Where can you work without needing a visa or sponsorship? Do you need sponsorship anywhere you're applying?", summary: "Right to work and visa sponsorship" },
  { key: "notice-period", q: "Notice period / earliest start date?", summary: "Notice period and earliest start date" },
  { key: "salary", q: "Salary expectations (per country or role type if they differ)?", summary: "Salary expectations" },
  { key: "relocation", q: "Willing to relocate? Where?", summary: "Relocation" },
  { key: "demographics", q: "Diversity / EEO questions (gender, ethnicity, disability, veteran status): how should they be answered?", summary: "Diversity and EEO questions", placeholder: "Prefer not to say" },
];

export async function writeStandardAnswers(memory, answers) {
  const saved = [];
  for (const s of STANDARD) {
    const a = (answers[s.key] || "").trim();
    if (!a) continue;
    await memory.writeLearned(`${s.key}.md`, s.summary, `**Q:** ${s.q}\n\n${a}`);
    saved.push(s.key);
  }
  return saved;
}
