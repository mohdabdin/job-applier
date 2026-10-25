// CV variants: written from a base CV + the posting, fact-checked against the profile and memory, rendered to a
// one-page PDF, saved as *new* files in profile/cvs/ with a line in cvs/INDEX.md. Existing CVs are never changed.
//
// ctx: { data: Data, ai(role, args) → {data, cost_usd} }

import { bool, list, obj, str } from "./schema.js";
import { today } from "./data.js";
import { PDFDocument, PDFName, PDFString, StandardFonts, rgb } from "./vendor/pdf-lib.esm.min.js";

export const SLUG = /^[a-z0-9][a-z0-9-]{2,50}$/;

export class VariantError extends Error {}

const CV_DRAFT = obj({
  markdown: str("the whole CV, in exactly the base CV's markdown format"),
  changes: str("one line for cvs/INDEX.md: what was emphasised"),
});

const FACT_CHECK = obj({ unsupported_claims: list(str()), ok: bool() });

const CV_SYSTEM = (name, profile, learned) => `You tailor ${name}'s CV for a type of role. Start from the base CV below and produce a variant that an ATS and a recruiter screening this role will rate higher:
- use the posting's terminology wherever it honestly describes their experience;
- move the most relevant roles' bullets up and sharpen the summary and skills line for this role type;
- trim what's irrelevant so it stays on one A4 page (about the base CV's length);
- keep the exact markdown structure of the base CV (header lines, \`## SECTION\` headings, \`**Role | Company** | Place | **Dates**\` lines, bullets).

Never add facts: no new employers, titles, dates, degrees, numbers, tools, skills, projects or responsibilities beyond the profile, base CVs and learned memory below. A fact check rejects anything unsupported, and so does a claim stretched past what the sources say. It's written for the role type, not one company: no company name, no "I'm excited to join X".

<profile>
${profile}
</profile>

<learned_memory>
${learned}
</learned_memory>`;

const FACT_CHECK_PROMPT = (name, sources, variant) => `You verify that a tailored CV contains no fabricated facts.

Below are the sources of truth: ${name}'s own CVs and profile, plus facts they have confirmed (learned memory). Then a tailored CV variant.

List every claim in the variant that is NOT supported by the sources: new employers, titles, dates, degrees, numbers/metrics, tools, skills, technologies, projects or responsibilities, and any claim stretched beyond what the sources say (e.g. "daily", "led", "production" when the sources don't say so). Rewording, reordering, emphasis and dropping content are all fine. A skill counts as supported if it appears anywhere in the sources (including learned memory). Be strict about numbers and named technologies; don't flag pure phrasing.

Set ok=true only if there are no unsupported claims.

<sources>
${sources}
</sources>

<variant>
${variant}
</variant>`;

/**
 * A new variant: { slug, base, target_roles, emphasis, job_id?, page_text? } → { cv, created, changes, cost_usd, seconds }.
 * The writer gets one retry with the fact check's objections.
 */
export async function makeVariant(ctx, { slug, base, target_roles, emphasis, job_id = "", page_text = "" }) {
  const { data } = ctx, f = data.folder, m = data.memory;
  if (!SLUG.test(slug || "")) throw new VariantError("bad CV name");
  if (await f.exists(`profile/cvs/${slug}.pdf`)) return { cv: `${slug}.pdf`, created: false, cost_usd: 0 };
  const baseMd = await f.read(`profile/cvs/${base}.md`);
  if (!baseMd) throw new VariantError(`no base CV ${base}`);
  const start = Date.now();
  let spent = 0;
  const posting = (job_id && (await data.posting(job_id))) || page_text.slice(0, 8000);
  const name = await m.name(), profile = await m.profileText();
  const prompt = `Role type: ${target_roles}\nWhat to bring forward: ${emphasis}\n\n<posting>\n${posting || "(not available)"}\n</posting>\n\n` +
    `<base_cv name="${base}">\n${baseMd}\n</base_cv>`;
  const system = CV_SYSTEM(name, profile, await m.learnedText());
  let feedback = "", draft, error = "";
  for (let attempt = 0; attempt < 2; attempt++) {
    const w = await ctx.ai("cv", { system, prompt: prompt + feedback, schema: CV_DRAFT });
    spent += w.cost_usd;
    draft = w.data;
    const fc = await ctx.ai("fact_check", { prompt: FACT_CHECK_PROMPT(name, `${profile}\n\n${await m.learnedText(1e9)}`, draft.markdown), schema: FACT_CHECK });
    spent += fc.cost_usd;
    if (fc.data.ok && !fc.data.unsupported_claims.length) {
      const pdf = await renderCv(draft.markdown);
      if (pdf.pages <= 1) { error = ""; break; }
      error = "It runs past one page even at the smallest font. Trim it.";
    } else {
      error = `These claims aren't supported by the profile or learned memory:\n${fc.data.unsupported_claims.map((c) => `- ${c}`).join("\n")}`;
    }
    feedback = `\n\nYour previous draft was rejected. Fix this and write it again:\n${error}`;
  }
  if (error) throw new VariantError(`the tailored CV didn't pass the checks, so it wasn't saved. ${error}`);
  if (await f.exists(`profile/cvs/${slug}.pdf`) || await f.exists(`profile/cvs/${slug}.md`)) {
    throw new VariantError(`cvs/${slug} appeared meanwhile; existing CVs are never overwritten`);
  }
  const { bytes } = await renderCv(draft.markdown);
  await f.write(`profile/cvs/${slug}.md`, draft.markdown.trim() + "\n");
  await f.write(`profile/cvs/${slug}.pdf`, bytes);
  const line = `- \`${slug}.md\` / \`.pdf\` — ${target_roles} — based on ${base} — ${draft.changes.replace(/\s+/g, " ")} — created ${today()}\n`;
  const index = (await f.read("profile/cvs/INDEX.md")) || "# CV index\n\n";
  await f.write("profile/cvs/INDEX.md", index.endsWith("\n") ? index + line : `${index}\n${line}`);
  return { cv: `${slug}.pdf`, created: true, changes: draft.changes, cost_usd: spent, seconds: Math.round((Date.now() - start) / 1000) };
}

// ---- markdown → one-page PDF ----------------------------------------------------------------------
// The subset the CVs use: "# Name", a contact paragraph, "---", "## SECTION", "**Role | Org** | Place | **Dates**"
// lines (optionally followed by an italic description line), "- " bullets, paragraphs; inline **bold** and [links](url).

const A4 = [595.28, 841.89];
const MARGIN = { top: 31, bottom: 28, side: 37 };
const FONT_STEPS = [10.5, 10, 9.5, 9, 8.5];
const INK = rgb(0.067, 0.067, 0.067), LINK = rgb(0.1, 0.36, 0.79);

const ROLE_LINE = /^(.*?)\s*\|\s*\*\*([^*]*\d{4}[^*]*)\*\*\s*$/;

function blocks(md) {
  const out = [];
  let para = [];
  const flush = () => { if (para.length) out.push({ t: "p", lines: para }); para = []; };
  for (const raw of md.replace(/\r/g, "").split("\n")) {
    const line = raw.trimEnd();
    if (!line.trim()) { flush(); continue; }
    if (/^# /.test(line)) { flush(); out.push({ t: "h1", text: line.slice(2) }); }
    else if (/^## /.test(line)) { flush(); out.push({ t: "h2", text: line.slice(3) }); }
    else if (/^-{3,}$/.test(line.trim())) { flush(); out.push({ t: "hr" }); }
    else if (/^\s*[-*] /.test(line)) { flush(); out.push({ t: "li", text: line.replace(/^\s*[-*] /, "") }); }
    else para.push(line.trim());
  }
  flush();
  return out;
}

/** Inline runs: [{text, bold, url}] */
function runs(text) {
  const out = [];
  const re = /\*\*(.+?)\*\*|\[([^\]]+)\]\(([^)]+)\)/g;
  let i = 0, m;
  while ((m = re.exec(text))) {
    if (m.index > i) out.push({ text: text.slice(i, m.index) });
    if (m[1] !== undefined) out.push(...runs(m[1]).map((r) => ({ ...r, bold: true })));
    else out.push({ text: m[2], url: m[3] });
    i = re.lastIndex;
  }
  if (i < text.length) out.push({ text: text.slice(i) });
  return out;
}

const SUBST = { "−": "-", "≥": ">=", "≤": "<=", "→": "->", "←": "<-", "✓": "", " ": " ", " ": " ", " ": " " };

function sanitizer(font) {
  const ok = new Set(font.getCharacterSet());
  return (s) => [...s].map((c) => (ok.has(c.codePointAt(0)) ? c : SUBST[c] ?? "?")).join("");
}

async function layout(md, fs) {
  const doc = await PDFDocument.create();
  const F = {
    r: await doc.embedFont(StandardFonts.Helvetica),
    b: await doc.embedFont(StandardFonts.HelveticaBold),
    i: await doc.embedFont(StandardFonts.HelveticaOblique),
  };
  const clean = sanitizer(F.r);
  const [W, H] = A4, left = MARGIN.side, right = W - MARGIN.side, width = right - left;
  let page = doc.addPage(A4), y = H - MARGIN.top, pages = 1;
  const lh = fs * 1.32;
  const newPage = () => { page = doc.addPage(A4); y = H - MARGIN.top; pages++; };
  const need = (h) => { if (y - h < MARGIN.bottom) newPage(); };
  const links = [];

  // Wrap runs into lines of words; returns [[{text, font, url, w}]]
  const wrap = (rs, size, maxW, fontFor) => {
    const words = [];
    for (const r of rs) {
      const font = fontFor(r);
      for (const piece of clean(r.text).split(/(\s+)/)) if (piece) words.push({ text: piece, font, url: r.url, space: /^\s+$/.test(piece) });
    }
    const lines = [[]];
    let w = 0;
    for (const wd of words) {
      const ww = wd.font.widthOfTextAtSize(wd.space ? " " : wd.text, size);
      if (wd.space) { if (lines.at(-1).length) { lines.at(-1).push({ ...wd, text: " ", w: ww }); w += ww; } continue; }
      if (w + ww > maxW && lines.at(-1).length) {
        while (lines.at(-1).length && lines.at(-1).at(-1).text === " ") lines.at(-1).pop();
        lines.push([]); w = 0;
      }
      lines.at(-1).push({ ...wd, w: ww }); w += ww;
    }
    return lines.filter((l) => l.length);
  };
  const lineWidth = (l) => l.reduce((s, x) => s + x.w, 0);
  const drawLine = (l, x, size) => {
    for (const piece of l) {
      page.drawText(piece.text, { x, y, size, font: piece.font, color: piece.url ? LINK : INK });
      if (piece.url && piece.text.trim()) links.push({ page, rect: [x, y - 2, x + piece.w, y + size], url: piece.url });
      x += piece.w;
    }
  };
  const para = (rs, { size = fs, indent = 0, align = "left", italic = false, gap = 0.3 * fs } = {}) => {
    const fontFor = (r) => (r.bold ? F.b : italic ? F.i : F.r);
    for (const l of wrap(rs, size, width - indent, fontFor)) {
      need(size * 1.32);
      y -= size;
      const x = align === "center" ? left + (width - lineWidth(l)) / 2 : left + indent;
      drawLine(l, x, size);
      y -= size * 0.32;
    }
    y -= gap;
  };

  let afterH1 = false;
  for (const b of blocks(md)) {
    if (b.t === "h1") {
      const size = fs * 2.35, text = clean(b.text);
      need(size * 1.2);
      y -= size;
      page.drawText(text, { x: left + (width - F.b.widthOfTextAtSize(text, size)) / 2, y, size, font: F.b, color: INK });
      y -= size * 0.25;
      afterH1 = true;
      continue;
    }
    if (b.t === "hr") {
      need(8);
      y -= 3;
      page.drawLine({ start: { x: left, y }, end: { x: right, y }, thickness: 0.8, color: rgb(0.2, 0.2, 0.2) });
      y -= 6;
      continue;
    }
    if (b.t === "h2") {
      const size = fs * 1.05, text = clean(b.text.toUpperCase());
      need(size * 2.4);
      y -= fs * 0.75 + size;
      let x = left;
      for (const ch of text) { page.drawText(ch, { x, y, size, font: F.b, color: INK }); x += F.b.widthOfTextAtSize(ch, size) + size * 0.12; }
      y -= 3;
      page.drawLine({ start: { x: left, y }, end: { x: right, y }, thickness: 0.8, color: rgb(0.2, 0.2, 0.2) });
      y -= fs * 0.45;
      afterH1 = false;
      continue;
    }
    if (b.t === "li") {
      const bullet = "•", bw = F.r.widthOfTextAtSize(bullet, fs), indent = fs * 1.6;
      const fontFor = (r) => (r.bold ? F.b : F.r);
      const lines = wrap(runs(b.text), fs, width - indent, fontFor);
      lines.forEach((l, i) => {
        need(lh);
        y -= fs;
        if (i === 0) page.drawText(bullet, { x: left + indent - bw - fs * 0.5, y, size: fs, font: F.r, color: INK });
        drawLine(l, left + indent, fs);
        y -= fs * 0.32;
      });
      y -= fs * 0.18;
      continue;
    }
    // paragraph: the contact line under the name, a role line, or plain text
    if (afterH1) {
      para(runs(b.lines.join(" ")), { size: fs * 0.95, align: "center", gap: 0.2 * fs });
      afterH1 = false;
      continue;
    }
    const role = b.lines[0].match(ROLE_LINE);
    if (role) {
      const date = clean(role[2]), dw = F.b.widthOfTextAtSize(date, fs);
      const head = wrap(runs(role[1]), fs, width - dw - 12, (r) => (r.bold ? F.b : F.r));
      y -= fs * 0.45;
      head.forEach((l, i) => {
        need(lh);
        y -= fs;
        drawLine(l, left, fs);
        if (i === 0) page.drawText(date, { x: right - dw, y, size: fs, font: F.b, color: INK });
        y -= fs * 0.32;
      });
      if (b.lines.length > 1) para(runs(b.lines.slice(1).join(" ")), { italic: true, gap: 0.15 * fs });
      continue;
    }
    para(runs(b.lines.join(" ")));
  }

  for (const l of links) {
    const annot = doc.context.obj({
      Type: "Annot", Subtype: "Link", Rect: l.rect, Border: [0, 0, 0],
      A: { Type: "Action", S: "URI", URI: PDFString.of(l.url) },
    });
    const ref = doc.context.register(annot);
    const existing = l.page.node.lookup(PDFName.of("Annots"));
    if (existing) existing.push(ref);
    else l.page.node.set(PDFName.of("Annots"), doc.context.obj([ref]));
  }
  doc.setTitle("CV");
  doc.setProducer("Job Applier");
  return { doc, pages };
}

/** Shrinks the font until it fits on one page (or the smallest step). Returns { bytes, pages, fontSize }. */
export async function renderCv(md) {
  let last;
  for (const fs of FONT_STEPS) {
    const { doc, pages } = await layout(md, fs);
    last = { doc, pages, fontSize: fs };
    if (pages <= 1) break;
  }
  return { bytes: await last.doc.save(), pages: last.pages, fontSize: last.fontSize };
}
