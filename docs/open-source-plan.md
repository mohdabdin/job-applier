# Plan: an open-source, extension-only job applier

Written 2026-10-25. Decisions: **drop the Python server**, Discover opt-in, MIT.
Status 2026-10-25: phases 1–4 built (extension-only; `npm test`); phase 5 docs written; the Python version moved out of the repo (`../job-applier-python-legacy/`, plus a zip).

Everything runs in a Chrome extension that anyone installs
from the Chrome Web Store, with their own model API key. Their data stays on their machine as plain files.

## Why

Today: `uv` + a Python server + a token + "Load unpacked" + (in WSL) Chromium system libraries. Fine for one
developer, a wall for everyone else. The server's real work is small (prompts, a handful of model calls, guard code,
file writes) and all of it can live in the extension.

## What the product is

- **Discover:** one button runs LinkedIn searches built from the user's preferences, opens each new listing, judges
  the fit, queues good ones. Opt-in, with a plain warning (see Risks).
- **Apply:** on any application page, "Fill this page" reads the form, fills what the profile and memory answer,
  asks inline about the rest (answers become memory), picks or tailors the CV. **The user always clicks Submit.**
- **Track:** the queue, applied / skipped, proof screenshots, all in a local `tracker.csv`.

## Architecture

```
Chrome extension (MV3, plain JS, no build step)
├── sw.js              service worker: side panel behaviour, tab → job binding
├── panel.*            side panel: Onboarding · Discover · Apply · Settings
├── content.js         generic form reader/filler (unchanged)
├── linkedin.js        LinkedIn search reader (unchanged)
└── lib/
    ├── llm.js         one structured-output call for Gemini, Anthropic, OpenAI; price table; spend tracking
    ├── store.js       the data folder: read/write files, tracker.csv, path guards
    ├── fill.js        the fill plan: prompt + guards (port of server.py: plan, _check_plan)
    ├── discover.js    search plan + fit assessment (port of discover.py)
    ├── memory.js      learned memory writes + INDEX.md (port of memory.py guards + MemoryWrite call)
    ├── cv.js          variant writer + fact check + one-page PDF (port of cv.py)
    └── vendor/        pinned single-file libraries (PDF generation, PDF text extraction)
```

- **Model calls go straight from the extension to the provider** with the user's key. Extension pages with host
  permissions aren't subject to CORS. Anthropic additionally needs its `anthropic-dangerous-direct-browser-access`
  header. The key is kept in `chrome.storage.local` (never `sync`), is never written to the data folder, and is
  only ever sent to that provider.
- **Structured output:** Gemini `responseSchema`, OpenAI `json_schema`, Anthropic tool use / structured outputs.
  One JSON Schema per call (taken from today's pydantic models), validated in code after the call.
- **The code-side guards carry over one-for-one:** every field answered once, `choose` values really offered,
  required-but-skipped → ask, CV must exist, no-sponsorship → poor fit, duplicate checks, memory writes confined to
  learned memory, profile and base CVs read-only, variants only as new files, fact check before saving a variant.
- **Model defaults:** a cheap fast model for everything (filling, fit, memory), a stronger one optional for CV
  writing and fact checks. Per-provider presets so nobody has to know model names.
- **Spend:** every call is priced; Settings shows this month's spend and an optional monthly cap.

### Data: a folder the user picks

A clean layout (the Python version's data was copied into it once):

```
<chosen folder>/
  profile/           # the user's ground truth (onboarding writes it; the extension never edits it after)
    profile.md, preferences.md, ...
    cvs/  INDEX.md, <base>.pdf (+ .md text), <variant>.md/.pdf
  memory/            # learned answers, one topic per file, + INDEX.md
  tracker.csv
  jobs/<id>.md       # saved postings
  logs/              # plans.jsonl, proof screenshots
```

- File System Access API: `showDirectoryPicker()` once, the handle kept in IndexedDB. Chrome 122+ offers "Allow on
  every visit", so it shouldn't ask again. **To verify first (spike):** that this works from the side panel's
  extension origin and survives restarts. Fallback: store everything in IndexedDB, with "Export folder" /
  "Import folder" in Settings.
- Plain files keep it transparent: people can read, edit, back up, or put the folder in git.

### PDFs without a browser engine

- The **uploaded base CV is used as-is** (the user's own PDF, their own design).
- Its text is extracted (a vendored PDF text library, or the model reads the PDF directly: Gemini, Claude and
  OpenAI all accept PDFs) into a markdown copy, which is what variants are written from.
- Variants are rendered with a vendored PDF library in one clean one-page layout, shrinking the font until it fits.
  A variant won't look like the user's own design. That's acceptable, but the panel shows it with "View CV" before
  it's uploaded.

## Onboarding (first open of the side panel, about 5 minutes)

1. **Model:** pick a provider (Gemini recommended: cheapest), paste the key with a link to where to get one, and run
   a test call. Show typical costs (below).
2. **Data folder:** pick or create one. "Already have a job-applier folder? Pick it."
3. **CVs:** drop 1–3 PDFs, then say what each targets ("founding engineer roles", "AI solutions roles").
   The model drafts `profile.md` (contact, links, work history, education, skills) from them and the user reviews it.
4. **Preferences:** a short form plus free text for target roles, locations (place names; no LinkedIn geo ids),
   remote/hybrid/onsite, seniority, salary floor, sponsorship needed, company types, dealbreakers. This becomes
   `preferences.md`.
5. **Standard answers up front:** right to work and sponsorship per country, notice period, salary expectation,
   start date, relocation, EEO preference (default "prefer not to say"), and links (LinkedIn, GitHub, portfolio).
   This seeds learned memory so the first form isn't ten questions.
6. **Done:** "Discover jobs" (with the LinkedIn warning and an opt-in toggle) or "Open an application page".

Everything stays editable later in Settings → Profile.

## Costs to show users (measured on Gemini, 2026-10)

| Action | Cost |
|---|---|
| Judge one listing | about $0.015 |
| Fill one form page | about $0.025 |
| New CV variant (write + fact check) | about $0.04 |
| An active month (about 300 listings, 60 applications) | about $6–8 |

Cheaper presets (flash-only) should roughly halve this. These numbers also set the price floor for a hosted tier.

## Risks

- **LinkedIn's terms ban automated access**, and accounts can be restricted. Discover is opt-in, warns plainly,
  paces itself, caps listings per press, and never touches Apply or Easy Apply. A "read the page I opened" mode
  (no clicks made for the user) is the safer alternative to offer.
- **Chrome Web Store review:** `<all_urls>` triggers in-depth review and needs a justification (forms live on any
  ATS domain). It also needs a privacy policy: no data leaves the machine except to the model provider the user
  chose, nothing is collected by us, and there's no analytics.
- **Keys in the browser:** readable by anyone with access to the Chrome profile. Say so; recommend a key with a
  spend limit.
- **Model quality varies by provider:** keep the code guards; test fill quality per provider preset.

## Repo before the first public commit

Nothing is committed yet, so there's no history to scrub.

- **Remove:** `src/job_applier/` (server, Scout, Applier, Browserbase, Stagehand, Slack), `pyproject.toml`,
  `uv.lock`, `.python-version`, Python tests, `scripts/sync-extension.sh`, `config.json` (Slack id),
  `.env.example`. They remain in the author's local copy; they don't ship.
- **Gitignore:** any data folder, `tracker.csv`, `state/`, `logs/`, `.env`, `*.pdf` outside `examples/`.
- **Ship `examples/data/`:** a fictional person's profile, preferences, a CV, a few memory files, so the format is
  obvious.
- **De-personalise:** the author's name in prompts → the profile's name; the UK/Norway geo ids → locations from
  preferences; the side panel copy; the manifest description.
- **Docs:** README (below), `CONTRIBUTING.md` (replaces the personal `CLAUDE.md`; a short `CLAUDE.md` / `AGENTS.md`
  for coding agents), `PRIVACY.md`, `LICENSE`.
- **Name:** "job-applier" is generic; pick something searchable before the store listing.

## README outline

1. One-line pitch plus a 20-second GIF (Discover → queue → Fill → questions → user clicks Submit).
2. What it does and doesn't do (no auto-submit, no CAPTCHA solving, Easy Apply skipped).
3. Privacy: a data-flow diagram (your browser ↔ your model provider; nothing else).
4. Install: Chrome Web Store link; or "Load unpacked" for developers.
5. Setup: the onboarding steps, where to get an API key, costs table.
6. Using it: Discover, Apply, questions and memory, CVs and variants, the tracker.
7. Your data folder: layout, editing it by hand, backing it up.
8. LinkedIn caveat; FAQ; contributing; licence.

## Phases

1. **Spike (half a day):** folder access from the side panel (persistence across restarts), direct calls with
   structured output to all three providers, PDF generation of a one-page CV. Decide store.js's fallback.
2. **Core port:** `llm.js`, `store.js`, `fill.js`, `memory.js`; the Apply view works without the server against
   the author's existing folder. Port the Python tests to `node --test` (guards, matching, memory paths).
3. **Discover + CVs:** `discover.js`, `cv.js`, PDF rendering; Settings (model, spend, profile editing).
4. **Onboarding:** the six steps; `examples/data/`.
5. **Ship:** de-personalise, delete the Python, README/PRIVACY/CONTRIBUTING/LICENSE, Playwright extension tests on
   saved form fixtures in GitHub Actions (CI has Chromium's libraries, so WSL doesn't matter), store listing.
6. **Later, hosted tier:** a "use my account" option next to "use my key". A small relay holds the provider key and
   meters usage per user; data still stays local. Only the relay is closed source.

## Open decisions

- **Discover default:** opt-in with warning (proposed), on by default, or the read-only mode only.
- **Licence:** MIT (proposed: widest use; the hosted tier's edge is convenience) or AGPL (blocks closed hosted clones).
- **Name.**
