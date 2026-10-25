# Job Applier

An open-source (MIT) Chrome extension: it fills job applications from the user's CV and answers, asks them inline
about anything it can't answer, tailors CVs per role type, and (opt-in) discovers jobs on LinkedIn. **The user
always clicks Submit.** Bring-your-own-key (Gemini or Claude); all data lives in a local folder the user picks.

Start with `CONTRIBUTING.md` (layout, rules the code keeps, how to test) and `README.md` (what users see).
Plan: `docs/open-source-plan.md`.

## Working on it

- Plain JS modules in `extension/`, no build step, no runtime dependencies beyond `extension/lib/vendor/`.
- `npm test` (Node 20+, nothing to install) runs `test/*.test.js` against the real `lib/` code with a temp folder
  and scripted model outputs. Add or update a test for any change in `lib/`.
- Prompts live next to their code (`lib/fill.js`, `lib/discover.js`, `lib/cv.js`, `lib/setup.js`) and must stay
  generic: the person's name comes from `memory.name()`, never hard-coded; use they/them.
- Structured output: schemas are built with `lib/schema.js` (every property required, no extras) so the same schema
  works for Gemini (`responseJsonSchema`) and Claude (`output_config.format`). Optional values are "" / [] / false.
- `content.js` and `linkedin.js` are injected with `chrome.scripting.executeScript`; keep them free of per-site code.
- WSL: `scripts/sync-extension.sh /mnt/c/Users/<you>/job-applier-extension` copies the extension to Windows.

## Hard rules

- Never submit a form or click a submit button. Never read or fill passwords or payment fields.
- Never invent facts in answers or CVs; ask the user instead. CV variants pass `cv.js`'s fact check before saving.
- The user's profile and own CVs are read-only to the extension; write guards are in `lib/data.js` / `lib/cv.js`.
- Network calls go only to the user's chosen model provider (and the pages the user or Discover opens).
- No real personal data in the repo: `examples/data/` is a fictional person. `.gitignore` keeps `memory/`,
  `tracker.csv`, `state/`, `logs/` and PDFs out.
