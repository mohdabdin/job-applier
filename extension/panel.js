// The side panel. Setup on first run; then Apply (the queue, "Fill this page" for the current tab), Discover (opt-in
// LinkedIn search) and Settings. Everything runs here: model calls go straight to the user's provider with their key,
// and their data lives in the folder they picked (lib/store.js). It never clicks Submit: the user does.

import { PROVIDERS, structured } from "./lib/llm.js";
import { Folder, folderState, loadHandle, saveHandle } from "./lib/store.js";
import { Data } from "./lib/data.js";
import * as fill from "./lib/fill.js";
import * as disc from "./lib/discover.js";
import * as jobs from "./lib/jobs.js";
import { makeVariant } from "./lib/cv.js";
import * as setup from "./lib/setup.js";
import { bool, obj } from "./lib/schema.js";

const $ = (sel) => document.querySelector(sel);
const DEFAULTS = {
  provider: "gemini", apiKey: "", models: { fast: "", strong: "" }, monthlyCapUsd: 0,
  discover: { enabled: false, target: 10, maxOpen: 50, minFit: "maybe" },
  setupStep: "model", setupDone: false,
};
let settings = structuredClone(DEFAULTS);
let handle = null, data = null;
const tabState = new Map(); // tabId → { plan, page, fields: Map(id → field), results: {id → {ok, value, error}}, answered: Set, stale }
let current = { tab: null, job: null };

// ---- ui helpers ---------------------------------------------------------------------------
const el = (tag, attrs = {}, ...kids) => {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") e.className = v;
    else if (k.startsWith("on")) e.addEventListener(k.slice(2), v);
    else if (k === "value") e.value = v;
    else if (v !== undefined && v !== null && v !== false) e.setAttribute(k, v === true ? "" : v);
  }
  for (const k of kids.flat()) if (k !== null && k !== undefined && k !== false) e.append(k);
  return e;
};
function status(msg, kind = "") {
  const s = $("#status");
  s.hidden = !msg;
  s.textContent = msg || "";
  s.className = kind;
}
const errMsg = (e) => e?.message || String(e);
const b64 = (bytes) => {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
};

// ---- settings, spend, the model -----------------------------------------------------------
async function loadSettings() {
  const s = (await chrome.storage.local.get("settings")).settings || {};
  settings = { ...structuredClone(DEFAULTS), ...s, models: { ...DEFAULTS.models, ...s.models }, discover: { ...DEFAULTS.discover, ...s.discover } };
}
const saveSettings = () => chrome.storage.local.set({ settings });

const month = () => new Date().toISOString().slice(0, 7);
async function spentThisMonth() {
  const s = (await chrome.storage.local.get("spend")).spend;
  return s?.month === month() ? s.usd : 0;
}
async function addSpend(usd) {
  const total = (await spentThisMonth()) + (usd || 0);
  await chrome.storage.local.set({ spend: { month: month(), usd: total } });
  $("#spend").textContent = `$${total.toFixed(2)}`;
}

const ctx = {
  get data() { return data; },
  async ai(role, args) {
    if (settings.monthlyCapUsd && (await spentThisMonth()) >= settings.monthlyCapUsd) {
      throw new Error(`This month's model budget ($${settings.monthlyCapUsd}) is used up. Raise it in Settings.`);
    }
    const r = await structured(settings, role, args);
    await addSpend(r.cost_usd);
    return r;
  },
};

// ---- views --------------------------------------------------------------------------------
const VIEWS = ["setup", "connect", "apply", "discover", "settings"];
let view = "apply";
function showView(v) {
  view = v;
  for (const name of VIEWS) $(`#view-${name}`).hidden = name !== v;
  $("#top").hidden = v === "setup" || v === "connect";
  document.querySelectorAll("[data-view]").forEach((b) => b.classList.toggle("on", b.dataset.view === v));
  if (v === "apply") refresh();
  if (v === "discover") renderDiscover();
  if (v === "settings") renderSettings();
  if (["apply", "discover"].includes(v)) chrome.storage.local.set({ view: v });
}
document.querySelectorAll("[data-view]").forEach((b) => { b.onclick = () => { status(""); showView(b.dataset.view); }; });

async function boot() {
  await loadSettings();
  handle = await loadHandle().catch(() => null);
  $("#spend").textContent = `$${(await spentThisMonth()).toFixed(2)}`;
  const state = await folderState(handle).catch(() => "none");
  if (state === "granted") data = new Data(new Folder(handle));
  if (!settings.setupDone) return renderSetup();
  if (state === "prompt") {
    $("#connect-name").textContent = handle.name;
    return showView("connect");
  }
  if (state === "none") {
    settings.setupDone = false;
    settings.setupStep = "folder";
    await saveSettings();
    return renderSetup();
  }
  showView((await chrome.storage.local.get("view")).view || "apply");
}
$("#connect").onclick = async () => {
  if ((await handle.requestPermission({ mode: "readwrite" })) !== "granted") return status("Chrome didn't open the folder.", "error");
  data = new Data(new Folder(handle));
  if (!settings.setupDone) return renderSetup();
  showView((await chrome.storage.local.get("view")).view || "apply");
};

// ---- setup --------------------------------------------------------------------------------
const STEPS = ["model", "folder", "cvs", "profile", "preferences", "answers", "discover"];
const draft = { contact: null }; // carried from the CV step to the profile step

async function goStep(step) {
  settings.setupStep = step;
  await saveSettings();
  renderSetup();
}

function stepShell(step, title, ...body) {
  const n = STEPS.indexOf(step) + 1;
  return el("div", { class: "setup" },
    el("div", { class: "muted" }, `Setup · step ${n} of ${STEPS.length}`),
    el("h1", {}, title), ...body);
}

function field(label, input, hint) {
  return el("label", { class: "field-in" }, el("span", {}, label), input, hint ? el("small", { class: "muted" }, hint) : null);
}

function renderSetup() {
  showView("setup");
  let step = settings.setupStep;
  // steps after "folder" need the folder; after a restart Chrome may want a click to reopen it
  if (STEPS.indexOf(step) > 1 && !data) {
    if (handle) {
      $("#connect-name").textContent = handle.name;
      return showView("connect");
    }
    step = "folder";
  }
  $("#view-setup").replaceChildren((SETUP[step] || SETUP.model)());
}

const SETUP = {
  model() {
    const provider = el("select", {}, ...Object.entries(PROVIDERS).map(([k, p]) => el("option", { value: k, selected: k === settings.provider }, p.label)));
    const key = el("input", { type: "password", placeholder: "Paste your API key", value: settings.apiKey });
    const link = el("a", { target: "_blank" }, "Get a key");
    const syncLink = () => { link.href = PROVIDERS[provider.value].keyUrl; };
    provider.onchange = syncLink;
    syncLink();
    const go = el("button", { class: "primary", onclick: async () => {
      settings.provider = provider.value;
      settings.apiKey = key.value.trim();
      go.disabled = true;
      status("Checking the key…");
      try {
        await ctx.ai("memory", { prompt: "Reply with ok = true.", schema: obj({ ok: bool() }) });
        status("");
        await goStep("folder");
      } catch (e) {
        status(errMsg(e), "error");
      } finally {
        go.disabled = false;
      }
    } }, "Check key and continue");
    return stepShell("model", "Welcome to Job Applier",
      el("p", {}, "It finds jobs that fit you, fills in application forms from your CV and your answers, and asks you about anything it doesn't know. You always review the form and click Submit yourself."),
      el("p", {}, "It uses an AI model with your own API key. The key stays in this browser and is only sent to that provider."),
      field("Model provider", provider, "Gemini is the cheapest. Typical use costs a few dollars a month."),
      field("API key", key), link, el("div", { class: "row" }, go));
  },

  folder() {
    const go = el("button", { class: "primary", onclick: async () => {
      let h;
      try {
        h = await window.showDirectoryPicker({ id: "job-applier", mode: "readwrite", startIn: "documents" });
      } catch {
        return; // cancelled
      }
      handle = h;
      await saveHandle(h);
      data = new Data(new Folder(h));
      if (await data.folder.exists("profile/preferences.md")) {
        settings.setupDone = true;
        await saveSettings();
        showView("apply");
        return status(`Using your existing data in "${h.name}".`);
      }
      await goStep("cvs");
    } }, "Choose folder");
    return stepShell("folder", "Where should your data live?",
      el("p", {}, "Pick or create an empty folder, for example Documents/Job Applier. Your profile, answers, CVs and the job tracker are kept there as plain files you can read, edit and back up."),
      el("p", { class: "muted" }, "Already used Job Applier? Pick that folder and you're done."),
      el("div", { class: "row" }, go));
  },

  cvs() {
    const list = el("div");
    const input = el("input", { type: "file", accept: "application/pdf,.pdf", multiple: true });
    const rows = [];
    input.onchange = () => {
      rows.length = 0;
      list.replaceChildren(...[...input.files].map((file) => {
        const targets = el("input", { placeholder: "Which roles is this CV for? e.g. backend engineering" });
        rows.push({ file, targets });
        return el("div", { class: "card" }, el("strong", {}, file.name), targets);
      }));
    };
    const go = el("button", { class: "primary", onclick: async () => {
      if (!rows.length) return status("Add at least one CV (PDF).", "error");
      go.disabled = true;
      try {
        const cvs = [];
        const used = new Set();
        for (const [i, r] of rows.entries()) {
          status(`Reading ${r.file.name} (${i + 1}/${rows.length})…`);
          const pdf = new Uint8Array(await r.file.arrayBuffer());
          const read = await setup.readCv(ctx, b64(pdf));
          let slug = setup.slugify(r.targets.value || r.file.name.replace(/\.pdf$/i, ""));
          while (used.has(slug)) slug += "-2";
          used.add(slug);
          cvs.push({ slug, targets: r.targets.value.trim(), pdf, markdown: read.markdown });
          draft.contact ||= read;
        }
        await setup.writeCvs(data.folder, cvs);
        status("");
        await goStep("profile");
      } catch (e) {
        status(errMsg(e), "error");
      } finally {
        go.disabled = false;
      }
    } }, "Read my CVs");
    return stepShell("cvs", "Your CVs",
      el("p", {}, "Add the CV(s) you apply with, as PDFs. If you have different CVs for different kinds of roles, add each one and say what it's for."),
      el("p", { class: "muted" }, "Your PDFs are uploaded to applications exactly as they are. A text copy is kept so tailored versions can be made for specific role types later; those are fact-checked against your own CVs and answers."),
      input, list, el("div", { class: "row" }, go));
  },

  profile() {
    const c = draft.contact || {};
    const inputs = {
      name: el("input", { value: c.name || "" }), email: el("input", { value: c.email || "" }),
      phone: el("input", { value: c.phone || "" }), location: el("input", { value: c.location || "" }),
      links: el("textarea", {}, (c.links || []).map((l) => `${l.label}: ${l.url}`).join("\n")),
      extra: el("textarea", { placeholder: "Pronouns, the name you go by, anything forms ask that isn't on your CV" }),
    };
    const go = el("button", { class: "primary", onclick: async () => {
      if (!inputs.name.value.trim()) return status("Your name, please.", "error");
      const links = inputs.links.value.split("\n").map((l) => l.trim()).filter(Boolean).map((l) => {
        const i = l.indexOf(": ");
        return i > 0 ? { label: l.slice(0, i), url: l.slice(i + 2) } : { label: "Link", url: l };
      });
      await data.folder.write("profile/profile.md", setup.profileMarkdown({
        name: inputs.name.value, email: inputs.email.value, phone: inputs.phone.value, location: inputs.location.value,
        links, extra: inputs.extra.value }));
      status("");
      await goStep("preferences");
    } }, "Continue");
    return stepShell("profile", "About you",
      el("p", { class: "muted" }, "Read from your CV. Check it; forms are filled from this."),
      field("Full name", inputs.name), field("Email", inputs.email), field("Phone (with country code)", inputs.phone),
      field("Location", inputs.location), field("Links (one per line, Label: URL)", inputs.links), field("Anything else", inputs.extra),
      el("div", { class: "row" }, go));
  },

  preferences() {
    const i = {
      roles: el("textarea", { placeholder: "Backend Engineer\nPlatform Engineer\nFounding Engineer" }),
      locations: el("textarea", { placeholder: "London\nUnited Kingdom\nRemote (Europe)" }),
      seniority: el("input", { placeholder: "e.g. mid to senior, no management roles" }),
      salary: el("input", { placeholder: "e.g. at least £70k in London" }),
      sponsorship: el("input", { placeholder: "e.g. I need a visa for the UK; none for the EU" }),
      companies: el("textarea", { placeholder: "e.g. startups and scale-ups, climate or robotics; no agencies" }),
      dealbreakers: el("textarea", { placeholder: "e.g. fully onsite outside London\ndefence\ncrypto" }),
      extra: el("textarea", { placeholder: "Anything else that makes a job a good or bad fit" }),
    };
    const modes = ["remote", "hybrid", "onsite"].map((m) => el("label", { class: "inline" }, el("input", { type: "checkbox", value: m, checked: true }), m));
    const go = el("button", { class: "primary", onclick: async () => {
      if (!i.roles.value.trim() || !i.locations.value.trim()) return status("Add at least one role and one location.", "error");
      const v = Object.fromEntries(Object.entries(i).map(([k, x]) => [k, x.value]));
      v.modes = modes.map((m) => m.querySelector("input")).filter((x) => x.checked).map((x) => x.value);
      await data.folder.write("profile/preferences.md", setup.preferencesMarkdown(v));
      status("");
      await goStep("answers");
    } }, "Continue");
    return stepShell("preferences", "What are you looking for?",
      el("p", { class: "muted" }, "Discover searches and judges jobs by this. Be as specific as you like; plain words are fine."),
      field("Roles, most important first", i.roles), field("Locations", i.locations),
      el("div", { class: "field-in" }, el("span", {}, "Work mode"), el("div", { class: "row" }, modes)),
      field("Seniority", i.seniority), field("Salary", i.salary), field("Visa sponsorship", i.sponsorship),
      field("Companies and industries", i.companies), field("Dealbreakers", i.dealbreakers), field("Anything else", i.extra),
      el("div", { class: "row" }, go));
  },

  answers() {
    const inputs = Object.fromEntries(setup.STANDARD.map((s) => [s.key, el("textarea", { placeholder: s.placeholder || "" })]));
    const go = el("button", { class: "primary", onclick: async () => {
      const answers = Object.fromEntries(Object.entries(inputs).map(([k, x]) => [k, x.value]));
      await setup.writeStandardAnswers(data.memory, answers);
      await goStep("discover");
    } }, "Continue");
    return stepShell("answers", "Questions most forms ask",
      el("p", { class: "muted" }, "Answer once and they're reused. Skip any; you'll be asked when a form needs it, and every answer you give later is remembered the same way."),
      ...setup.STANDARD.map((s) => field(s.q, inputs[s.key])), el("div", { class: "row" }, go));
  },

  discover() {
    const box = el("input", { type: "checkbox" });
    const go = el("button", { class: "primary", onclick: async () => {
      settings.discover.enabled = box.checked;
      settings.setupDone = true;
      await saveSettings();
      showView(box.checked ? "discover" : "apply");
    } }, "Finish setup");
    return stepShell("discover", "Finding jobs (optional)",
      el("p", {}, "Discover runs LinkedIn searches built from your preferences, opens each new listing, judges how well it fits you, and queues the good ones."),
      el("p", { class: "note" }, el("strong", {}, "Your LinkedIn account, your risk. "),
        "LinkedIn's terms don't allow automated browsing, and LinkedIn can restrict accounts it thinks are automated. Discover paces itself like a person, stops after a set number of listings, and never clicks Apply or Easy Apply, but the risk isn't zero."),
      el("label", { class: "inline" }, box, "Turn on Discover (you can change this in Settings)"),
      el("p", { class: "muted" }, "Without it, open any job application page yourself and press Fill."),
      el("div", { class: "row" }, go));
  },
};

// ---- settings view -------------------------------------------------------------------------
async function renderSettings() {
  const box = $("#view-settings");
  const provider = el("select", {}, ...Object.entries(PROVIDERS).map(([k, p]) => el("option", { value: k, selected: k === settings.provider }, p.label)));
  const key = el("input", { type: "password", value: settings.apiKey });
  const fast = el("input", { value: settings.models.fast, placeholder: PROVIDERS[settings.provider].models.fast });
  const strong = el("input", { value: settings.models.strong, placeholder: PROVIDERS[settings.provider].models.strong });
  const cap = el("input", { type: "number", min: "0", step: "1", value: settings.monthlyCapUsd || "", placeholder: "no limit" });
  const dOn = el("input", { type: "checkbox", checked: settings.discover.enabled });
  const target = el("input", { type: "number", min: "1", value: settings.discover.target });
  const maxOpen = el("input", { type: "number", min: "1", value: settings.discover.maxOpen });
  const minFit = el("select", {}, el("option", { value: "maybe", selected: settings.discover.minFit === "maybe" }, "strong and maybe"),
    el("option", { value: "strong", selected: settings.discover.minFit === "strong" }, "strong only"));
  const save = el("button", { class: "primary", onclick: async () => {
    const changedProvider = provider.value !== settings.provider;
    Object.assign(settings, { provider: provider.value, apiKey: key.value.trim(), monthlyCapUsd: +cap.value || 0,
      models: changedProvider ? { fast: "", strong: "" } : { fast: fast.value.trim(), strong: strong.value.trim() } });
    Object.assign(settings.discover, { enabled: dOn.checked, target: Math.max(1, +target.value || 10),
      maxOpen: Math.max(1, +maxOpen.value || 50), minFit: minFit.value });
    await saveSettings();
    await renderSettings();
    status("Saved.");
  } }, "Save");

  const files = ["profile/profile.md", "profile/preferences.md", "profile/cvs/INDEX.md", "memory/INDEX.md",
    ...((await data?.memory.learnedFiles()) || []).map((n) => `memory/${n}`)];
  const pick = el("select", {}, ...files.map((f) => el("option", { value: f }, f)));
  const text = el("textarea", { class: "big" });
  const load = async () => { text.value = (await data?.folder.read(pick.value)) || ""; };
  pick.onchange = load;
  const saveFile = el("button", { onclick: async () => { await data.folder.write(pick.value, text.value); status(`Saved ${pick.value}.`); } }, "Save file");
  const restart = (step) => async () => { settings.setupStep = step; settings.setupDone = false; await saveSettings(); renderSetup(); };

  box.replaceChildren(
    el("h2", {}, "Model"),
    field("Provider", provider), field("API key", key),
    el("details", {}, el("summary", {}, "Model names (optional)"),
      field("Fast (forms, fit, memory)", fast), field("Strong (CVs, fact checks)", strong)),
    field("Monthly budget, US$", cap, `Spent this month: $${(await spentThisMonth()).toFixed(2)}`),
    el("h2", {}, "Discover"),
    el("label", { class: "inline" }, dOn, "Discover on LinkedIn (see the risk note on the Discover tab)"),
    field("Stop after this many new jobs", target), field("…or after opening this many listings", maxOpen),
    field("Queue jobs that fit", minFit),
    el("div", { class: "row" }, save),
    el("h2", {}, "Your data"),
    el("p", { class: "muted" }, `Folder: ${handle?.name || "(none)"}. Edit your profile and answers here or in any text editor.`),
    pick, text, el("div", { class: "row" }, saveFile,
      el("button", { class: "ghost", onclick: restart("folder") }, "Use another folder"),
      el("button", { class: "ghost", onclick: restart("cvs") }, "Run setup again")),
  );
  if (data) load();
}

// ---- current tab --------------------------------------------------------------------------
const stateFor = (tabId) => {
  if (!tabState.has(tabId)) tabState.set(tabId, { plan: null, page: null, fields: new Map(), results: {}, answered: new Set(), stale: false });
  return tabState.get(tabId);
};
const splitId = (id) => { const i = id.indexOf(":"); return [+id.slice(0, i), id.slice(i + 1)]; };
function setBusy(on) {
  for (const b of ["#fill", "#applied", "#skip"]) $(b).disabled = on;
}

async function activeTab() {
  const [t] = await chrome.tabs.query({ active: true, currentWindow: true });
  return t;
}
async function jobForTab(tab) {
  const key = `tab:${tab.id}`;
  const saved = (await chrome.storage.session.get(key))[key];
  if (saved) return (await data.tracker.get(saved.id)) || saved;
  if (!/^https?:/.test(tab.url || "")) return null;
  const job = await jobs.match(data, tab.url);
  if (job) await chrome.storage.session.set({ [key]: job });
  return job;
}

async function refresh() {
  if (view !== "apply" || !data) return;
  const tab = await activeTab();
  current.tab = tab;
  try {
    current.job = tab ? await jobForTab(tab) : null;
  } catch (e) {
    current.job = null;
    status(errMsg(e), "error");
  }
  renderCurrent();
  loadQueue();
}

function renderCurrent() {
  const { tab, job } = current;
  const st = tab ? stateFor(tab.id) : null;
  const plan = st?.plan;
  $("#job-title").textContent = job ? `${job.company} — ${job.role}` : plan ? `${plan.company} — ${plan.role}` : "Untracked page";
  $("#job-sub").textContent = job ? [job.location, job.work_mode, job.salary, job.stage].filter(Boolean).join(" · ")
    : "Not in the queue. Fill works anyway; it's added to the tracker when you mark it applied.";
  $("#cost").textContent = plan ? `${plan.answers.length} fields · ${plan.seconds}s · $${plan.cost_usd.toFixed(3)}` : "";
  $("#fill").textContent = plan ? (st.stale ? "Page changed: fill again" : "Fill again") : "Fill this page";
  $("#notes").hidden = !plan?.notes;
  $("#notes").textContent = plan?.notes || "";
  $("#view-cv").hidden = !plan?.cv || !!plan?.new_cv_slug;
  $("#cv-why").hidden = !plan?.cv_reason;
  $("#cv-why").textContent = plan?.cv_reason ? `CV (${plan.cv}): ${plan.new_cv_slug ? "making a new one. " : ""}${plan.cv_reason}` : "";
  renderQuestions(st);
  renderFields(st);
}

// ---- filling ------------------------------------------------------------------------------
async function scanTab(tabId) {
  await chrome.scripting.executeScript({ target: { tabId, allFrames: true }, files: ["content.js"] });
  const res = await chrome.scripting.executeScript({
    target: { tabId, allFrames: true },
    func: () => (window.__jobApplier ? window.__jobApplier.scan() : null),
  });
  const fields = [];
  let page = null;
  for (const r of res) {
    if (!r.result) continue;
    for (const f of r.result.fields) fields.push({ ...f, id: `${r.frameId}:${f.id}` });
    if (r.frameId === 0) page = r.result.page;
  }
  return { fields, page };
}

async function cvFile(name) {
  const bytes = await data.folder.readBytes(`profile/cvs/${name}`);
  if (!bytes) throw new Error(`CV ${name} isn't in profile/cvs/`);
  return { name, b64: b64(bytes), type: "application/pdf" };
}

async function fillField(tabId, st, answer) {
  const [frameId, localId] = splitId(answer.id);
  try {
    const file = answer.action === "upload_cv" ? await cvFile(st.plan.cv) : null;
    const [r] = await chrome.scripting.executeScript({
      target: { tabId, frameIds: [frameId] },
      func: (id, a, f) => window.__jobApplier.fill(id, a, f),
      args: [localId, answer, file],
    });
    st.results[answer.id] = r?.result || { ok: false, error: "no result from the page" };
  } catch (e) {
    st.results[answer.id] = { ok: false, error: errMsg(e) };
  }
  return st.results[answer.id];
}

async function fillPage() {
  const tab = await activeTab();
  if (!tab || !/^https?:/.test(tab.url || "")) return status("Open an application page first.", "error");
  const st = stateFor(tab.id);
  setBusy(true);
  try {
    status("Reading the form…");
    const { fields, page } = await scanTab(tab.id);
    if (!fields.length) return status("No form fields found. If the page has an Apply button, click it first, then fill.", "error");
    status(`Working out answers for ${fields.length} fields…`);
    const pageInfo = page || { url: tab.url, title: tab.title, text: "" };
    const plan = await fill.plan(ctx, { job_id: current.job?.id || "", page: pageInfo, fields });
    Object.assign(st, { plan, page: pageInfo, fields: new Map(fields.map((f) => [f.id, f])), results: {}, answered: new Set(), stale: false });
    renderCurrent();
    const todo = plan.answers.filter((a) => ["fill", "choose", "check", "upload_cv"].includes(a.action));
    // a new CV variant takes a minute: fill everything else first, upload once it exists
    const later = plan.new_cv_slug ? todo.filter((a) => a.action === "upload_cv") : [];
    let n = 0;
    for (const a of todo.filter((x) => !later.includes(x))) {
      status(`Filling ${++n}/${todo.length}…`);
      await fillField(tab.id, st, a);
      renderFields(st);
    }
    if (later.length) {
      await tailorCv(st);
      for (const a of later) {
        status(`Filling ${++n}/${todo.length}…`);
        await fillField(tab.id, st, a);
        renderFields(st);
      }
    }
    const asks = plan.answers.filter((a) => a.action === "ask").length;
    const bad = todo.filter((a) => !st.results[a.id]?.ok).length;
    status([`Filled ${todo.length - bad}/${todo.length}.`, bad && `${bad} didn't stick: do those by hand.`,
      asks && `${asks} question${asks > 1 ? "s" : ""} for you above.`, "Check the page, then submit it yourself."].filter(Boolean).join(" "));
    if (current.job && current.job.stage === "found") await bind(tab.id, await jobs.setStage(data, current.job.id, { stage: "in_progress" }));
  } catch (e) {
    status(errMsg(e), "error");
  } finally {
    setBusy(false);
    renderCurrent();
  }
}
$("#fill").onclick = fillPage;

async function tailorCv(st) {
  const p = st.plan;
  status(`Writing a CV for ${p.new_cv_target_roles || p.new_cv_slug} (about a minute; the rest of the form is filled)…`);
  try {
    const r = await makeVariant(ctx, { slug: p.new_cv_slug, base: p.new_cv_base, target_roles: p.new_cv_target_roles,
      emphasis: p.new_cv_emphasis, job_id: current.job?.id || "", page_text: st.page?.text || "" });
    p.cv = r.cv;
    p.cost_usd += r.cost_usd || 0;
    p.cv_reason = r.created ? `New CV, saved for similar roles: ${r.changes}` : `Using ${r.cv}, made earlier for this kind of role.`;
  } catch (e) {
    p.cv_reason = `Couldn't make a new CV (${errMsg(e)}), so uploading ${p.cv} instead.`;
  }
  p.new_cv_slug = "";
  renderCurrent();
}

$("#view-cv").onclick = async () => {
  const st = current.tab && stateFor(current.tab.id);
  if (!st?.plan?.cv) return;
  const bytes = await data.folder.readBytes(`profile/cvs/${st.plan.cv}`);
  chrome.tabs.create({ url: URL.createObjectURL(new Blob([bytes], { type: "application/pdf" })) });
};

// ---- questions ----------------------------------------------------------------------------
function renderQuestions(st) {
  const box = $("#questions");
  box.replaceChildren();
  if (!st?.plan) return;
  for (const a of st.plan.answers.filter((x) => x.action === "ask")) box.append(questionCard(st, a));
}

function questionCard(st, a) {
  const f = st.fields.get(a.id) || { label: a.id, kind: "text" };
  const done = st.answered.has(a.id);
  const save = el("input", { type: "checkbox", checked: a.remember });
  const card = el("div", { class: `card${done ? " done" : ""}` },
    el("h3", {}, f.label, f.required ? " *" : ""),
    a.question && a.question !== f.label ? el("div", { class: "q" }, a.question) : null,
    a.reason ? el("div", { class: "muted" }, a.reason) : null);

  const submit = async (value, action) => {
    const answer = { ...a, action, value, choices: [value] };
    const r = await fillField(current.tab.id, st, answer);
    if (!r.ok) status(`Couldn't fill "${f.label}": ${r.error}. Fill it on the page.`, "error");
    st.answered.add(a.id);
    renderFields(st);
    card.classList.add("done");
    if (save.checked) {
      try {
        const m = await fill.remember(ctx, { question: a.question || f.label, answer: value, company: st.plan.company, role: st.plan.role });
        status(m.saved ? `Saved to memory/${m.file}.` : "Not saved: looks specific to this company.");
      } catch (e) {
        status(`Memory: ${errMsg(e)}`, "error");
      }
    }
  };

  if (f.kind === "file") {
    card.append(el("div", { class: "muted" }, "Attach this one on the page yourself."),
      el("button", { onclick: () => { st.answered.add(a.id); card.classList.add("done"); } }, "Done"));
    return card;
  }
  const opts = f.kind === "checkbox" ? ["Yes", "No"] : f.options || [];
  if (opts.length && opts.length <= 30) {
    const row = el("div", { class: "opts" });
    for (const o of opts) {
      row.append(el("button", { onclick: (ev) => {
        row.querySelectorAll("button").forEach((b) => b.classList.remove("picked"));
        ev.target.classList.add("picked");
        submit(f.kind === "checkbox" ? o.toLowerCase() : o, f.kind === "checkbox" ? "check" : "choose");
      } }, o));
    }
    card.append(row);
  } else {
    // keep what's been typed if the panel re-renders (tab events)
    const input = el("textarea", { oninput: (ev) => { a.typed = ev.target.value; } }, a.typed ?? a.draft ?? "");
    const action = f.kind === "combobox" || f.kind === "select" ? "choose" : "fill";
    card.append(input, el("div", { class: "row" }, el("button", { class: "primary", onclick: () => input.value.trim() && submit(input.value.trim(), action) },
      a.draft ? "Use this" : "Fill")));
  }
  card.append(el("label", { class: "save" }, save, "Save to memory"));
  return card;
}

// ---- field list ---------------------------------------------------------------------------
function renderFields(st) {
  const box = $("#fields");
  box.replaceChildren();
  if (!st?.plan) return;
  const rank = (a) => {
    const r = st.results[a.id];
    if (a.action === "ask" && !st.answered.has(a.id)) return 0;
    if (r && !r.ok) return 1;
    return a.action === "skip" ? 3 : 2;
  };
  for (const a of [...st.plan.answers].sort((x, y) => rank(x) - rank(y))) {
    const f = st.fields.get(a.id) || { label: a.id };
    const r = st.results[a.id];
    let icon, cls;
    if (a.action === "ask" && !st.answered.has(a.id)) [icon, cls] = ["?", "s-ask"];
    else if (a.action === "skip") [icon, cls] = ["–", "s-skip"];
    else if (!r) [icon, cls] = ["…", "s-wait"];
    else [icon, cls] = r.ok ? ["✓", "s-ok"] : ["✗", "s-bad"];
    const shown = r?.value ?? (a.action === "skip" ? a.reason : a.value || (a.choices || []).join(" | "));
    box.append(el("div", { class: "field", onclick: () => focusField(a.id) },
      el("span", { class: cls }, icon),
      el("div", {},
        el("div", { class: "label" }, f.label || "(no label)", f.required ? " *" : ""),
        shown ? el("div", { class: "value" }, String(shown).slice(0, 400)) : null,
        a.source && a.action !== "skip" ? el("div", { class: "src muted" }, a.source) : null,
        r && !r.ok ? el("div", { class: "err" }, r.error) : null)));
  }
}

async function focusField(id) {
  const [frameId, localId] = splitId(id);
  try {
    await chrome.scripting.executeScript({ target: { tabId: current.tab.id, frameIds: [frameId] },
      func: (i) => window.__jobApplier && window.__jobApplier.focusField(i), args: [localId] });
  } catch {}
}

// ---- applied / skipped ----------------------------------------------------------------------
async function bind(tabId, job) {
  current.job = job;
  await chrome.storage.session.set({ [`tab:${tabId}`]: job });
}

async function ensureJob(tab) {
  if (current.job) return current.job;
  const st = stateFor(tab.id);
  // the fill call read the company and role off the page; without one, the site and tab title will do
  const company = st.plan?.company || new URL(tab.url).hostname.replace(/^(www|jobs|careers|apply)\./, "");
  const role = st.plan?.role || tab.title || "Unknown role";
  const job = await jobs.createJob(data, { url: tab.url, company, role });
  await bind(tab.id, job);
  return job;
}

$("#applied").onclick = async () => {
  const tab = await activeTab();
  setBusy(true);
  try {
    const job = await ensureJob(tab);
    const shot = await chrome.tabs.captureVisibleTab(tab.windowId, { format: "jpeg", quality: 70 });
    const row = await jobs.setStage(data, job.id, { stage: "applied", cv: stateFor(tab.id).plan?.cv || "", screenshot: shot });
    await bind(tab.id, row);
    status(`Marked applied: ${row.company} — ${row.role}. Screenshot saved as proof.`);
  } catch (e) {
    status(errMsg(e), "error");
  } finally {
    setBusy(false);
    refresh();
  }
};

$("#skip").onclick = async () => {
  const tab = await activeTab();
  if (!current.job) return status("This page isn't a tracked job.", "error");
  setBusy(true);
  try {
    const job = await jobs.setStage(data, current.job.id, { stage: "skipped", note: "Skipped in the extension." });
    await bind(tab.id, job);
    status(`Skipped ${job.company} — ${job.role}.`);
  } catch (e) {
    status(errMsg(e), "error");
  } finally {
    setBusy(false);
    refresh();
  }
};

// ---- queue --------------------------------------------------------------------------------
async function loadQueue() {
  if (!data) return;
  let rows;
  try { rows = await jobs.queue(data); } catch (e) { return status(errMsg(e), "error"); }
  $("#queue-count").textContent = `(${rows.length})`;
  $("#queue-empty").hidden = rows.length > 0;
  $("#queue").replaceChildren(...rows.map((j) => el("li", { class: current.job?.id === j.id ? "here" : "", onclick: () => openJob(j) },
    el("div", {}, el("strong", {}, j.company), ` — ${j.role}`, j.stage !== "found" ? el("span", { class: "badge" }, j.stage.replace("_", " ")) : null),
    el("div", { class: "why" }, [j.location, j.work_mode, j.salary].filter(Boolean).join(" · ") + (j.notes ? ` — ${j.notes}` : "")))));
}

async function openJob(job) {
  const tab = await chrome.tabs.create({ url: job.apply_url, active: true });
  await chrome.storage.session.set({ [`tab:${tab.id}`]: job });
}
$("#queue-refresh").onclick = loadQueue;

// ---- discover -----------------------------------------------------------------------------
// "Discover more": the searches from preferences.md, each up to PAGES deep, in one LinkedIn tab the panel drives.
// Stops at the limits in Settings (new jobs found / listings opened per press). Progress is kept per day, so the
// next press carries on with the searches not yet done; the next day they all start again (newest first).
const PAGES = 2;
const isLinkedInJobs = (url) => /^https:\/\/www\.linkedin\.com\/jobs\//.test(url || "");
const scan = { running: false, stop: false, seen: new Set(), counts: {}, cost: 0, opened: 0, tabId: null };
const today = () => new Date().toLocaleDateString("en-CA");

function renderDiscover() {
  $("#discover-off").hidden = settings.discover.enabled;
  $("#discover-on").hidden = !settings.discover.enabled;
}
$("#discover-enable").onclick = async () => {
  settings.discover.enabled = true;
  await saveSettings();
  renderDiscover();
};

// Pauses with a long tail, like someone reading: mostly short, sometimes much longer.
const wait = (min, max) => new Promise((r) => setTimeout(r, min + (max - min) * Math.random() ** 2));

async function inLinkedIn(tabId, fn, ...args) {
  const [r] = await chrome.scripting.executeScript({ target: { tabId }, func: fn, args });
  return r?.result;
}

function scanStats(extra = "") {
  const c = scan.counts;
  const parts = [c.found && `${c.found} added to the queue`, c.skipped && `${c.skipped} poor fit`,
    c.tracked && `${c.tracked} seen before`, c.easy_apply && `${c.easy_apply} Easy Apply`,
    c.duplicate && `${c.duplicate} duplicate`, c.failed && `${c.failed} didn't load`].filter(Boolean);
  $("#scan-stats").textContent = [extra, parts.join(" · "), scan.cost && `$${scan.cost.toFixed(3)}`].filter(Boolean).join(" — ");
}
const count = (k) => { scan.counts[k] = (scan.counts[k] || 0) + 1; };

function foundRow(card) {
  const li = el("li", {}, el("span", { class: "fit busy" }, "…"),
    el("div", {}, el("div", { class: "who" }, card.text.split(" ").slice(0, 12).join(" ")), el("div", { class: "why" }, "Reading…")));
  $("#found").prepend(li);
  return (r) => {
    const fit = r.status === "found" || r.status === "skipped" ? r.fit : r.status.replace("_", " ");
    li.replaceChildren(el("span", { class: `fit ${r.fit || ""}` }, fit || "?"),
      el("div", {}, el("div", { class: "who" }, r.company ? `${r.company} — ${r.role}` : card.text.slice(0, 80)),
        el("div", { class: "why" }, r.reason || r.error || "")));
    if (r.status === "found" && r.job) {
      li.classList.add("clickable");
      li.onclick = () => openJob(r.job);
    }
  };
}

// Load a URL in the LinkedIn tab and wait for it (results render a little after the load event).
async function goTo(tabId, url) {
  const loaded = new Promise((resolve) => {
    const done = (id, info) => {
      if (id === tabId && info.status === "complete") { chrome.tabs.onUpdated.removeListener(done); resolve(); }
    };
    chrome.tabs.onUpdated.addListener(done);
    setTimeout(() => { chrome.tabs.onUpdated.removeListener(done); resolve(); }, 30000);
  });
  await chrome.tabs.update(tabId, { url });
  await loaded;
  await wait(2500, 5000);
}

async function linkedInTab(url) {
  const t = scan.tabId && await chrome.tabs.get(scan.tabId).catch(() => null);
  if (t && isLinkedInJobs(t.url)) {
    await chrome.tabs.update(t.id, { active: true });
    await goTo(t.id, url);
    return t.id;
  }
  const tab = await chrome.tabs.create({ url: "about:blank", active: true });
  scan.tabId = tab.id;
  await goTo(tab.id, url);
  return tab.id;
}

// One result page: open every listing not seen before, judge it. Returns how many cards the page had.
async function scanPage(tabId, limits) {
  await chrome.scripting.executeScript({ target: { tabId }, files: ["linkedin.js"] });
  const cards = await inLinkedIn(tabId, () => window.__jobLinkedIn.cards());
  if (!cards?.length) {
    const none = await inLinkedIn(tabId, () => window.__jobLinkedIn.noResults());
    if (!none) throw new Error("No job cards on the LinkedIn page (signed out, or LinkedIn changed its layout).");
    return 0;
  }
  const fresh = cards.filter((c) => !scan.seen.has(c.id));
  fresh.forEach((c) => scan.seen.add(c.id));
  const knownSet = new Set(await disc.known(data, fresh.map((c) => c.id)));
  let lastPane = "";
  for (const [i, card] of fresh.entries()) {
    if (scan.stop || (scan.counts.found || 0) >= limits.target || scan.opened >= limits.maxOpen) break;
    if (knownSet.has(card.id)) { count("tracked"); scanStats(); continue; }
    if (/easy apply/i.test(card.text)) { count("easy_apply"); scanStats(); continue; }
    const now = await chrome.tabs.get(tabId).catch(() => null);
    if (!now) throw new Error("The LinkedIn tab was closed.");
    if (!isLinkedInJobs(now.url)) throw new Error("The LinkedIn tab left the search.");
    scanStats(`Listing ${i + 1}/${fresh.length}`);
    await wait(1200, 5000);
    const show = foundRow(card);
    const opened = await inLinkedIn(tabId, (id) => window.__jobLinkedIn.open(id), card.id);
    if (!opened?.ok) { count("failed"); show({ status: "failed", error: opened?.error || "couldn't open it" }); continue; }
    scan.opened++;
    let pane = null;
    for (let t = 0; t < 40 && !scan.stop; t++) { // up to ~12 s for this job's details to replace the last one's
      await wait(300, 300);
      const p = await inLinkedIn(tabId, (id) => window.__jobLinkedIn.pane(id), card.id);
      if (p && p.text.length > 300 && p.text !== lastPane && (p.ext || p.easy || p.hasApply)) { pane = p; break; }
    }
    if (!pane) { count("failed"); show({ status: "failed", error: "the details didn't load" }); continue; }
    lastPane = pane.text;
    // judge it while "reading" the description, so the pace stays human without wasting time
    const [r] = await Promise.all([
      disc.assess(ctx, { id: card.id, card: card.text, pane: pane.text, applyHref: pane.ext || "", easy: pane.easy, hasApply: pane.hasApply },
        { minFit: settings.discover.minFit }).catch((e) => ({ status: "failed", error: errMsg(e) })),
      wait(2500, 9000),
    ]);
    scan.cost += r.cost_usd || 0;
    count(r.status === "failed" || r.status === "no_apply_link" ? "failed" : r.status);
    show(r);
    scanStats(`Listing ${i + 1}/${fresh.length}`);
  }
  return cards.length;
}

async function discoverMore() {
  Object.assign(scan, { running: true, stop: false, counts: {}, cost: 0, opened: 0 });
  $("#discover").disabled = true;
  $("#discover-stop").hidden = false;
  status("");
  let why = "";
  try {
    $("#scan-where").textContent = "Getting your searches (the first time, worked out from your preferences)…";
    const { queries } = await disc.searches(ctx);
    const limits = { target: settings.discover.target, maxOpen: settings.discover.maxOpen };
    const saved = (await chrome.storage.local.get("discover")).discover;
    const done = new Set(saved?.date === today() ? saved.done : []);
    outer:
    for (const [qi, q] of queries.entries()) {
      for (let page = 0; page < PAGES; page++) {
        const key = `${q.keywords}|${q.location}|${page}`;
        if (done.has(key)) continue;
        if (scan.stop) { why = "Stopped."; break outer; }
        $("#scan-where").textContent = `Search ${qi + 1}/${queries.length}: ${q.keywords} · ${q.location}${page ? `, page ${page + 1}` : ""}`;
        const tabId = await linkedInTab(disc.searchUrl(q, page));
        const n = await scanPage(tabId, limits);
        if (scan.stop) { why = "Stopped."; break outer; } // the page wasn't finished: do it again next time
        done.add(key);
        if (n < 25) for (let p = page + 1; p < PAGES; p++) done.add(`${q.keywords}|${q.location}|${p}`); // no more pages
        await chrome.storage.local.set({ discover: { date: today(), done: [...done] } });
        if ((scan.counts.found || 0) >= limits.target) { why = `Found ${limits.target} new jobs; press again for more.`; break outer; }
        if (scan.opened >= limits.maxOpen) { why = `Opened ${limits.maxOpen} listings; press again for more.`; break outer; }
      }
    }
    why ||= "All of today's searches are done. New listings get picked up tomorrow.";
  } catch (e) {
    status(errMsg(e), "error");
    why = "Stopped by an error; press again to carry on.";
  } finally {
    scan.running = false;
    $("#discover").disabled = false;
    $("#discover-stop").hidden = true;
    $("#scan-where").textContent = why;
    scanStats();
  }
}
$("#discover").onclick = discoverMore;
$("#discover-stop").onclick = () => { scan.stop = true; };

// ---- tab changes --------------------------------------------------------------------------
chrome.tabs.onActivated.addListener(() => refresh());
chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (tabId !== current.tab?.id) return;
  if (info.url) stateFor(tabId).stale = !!stateFor(tabId).plan;
  if (info.url || info.status === "complete") refresh();
});

boot().catch((e) => status(errMsg(e), "error"));
