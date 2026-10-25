# Contributing

Thanks for helping. Bug reports with the site name are the most useful contribution; pull requests are welcome too.

## Layout

```
extension/            the whole product: load this folder unpacked in Chrome
  manifest.json       MV3; side panel, scripting, tabs, storage; <all_urls> (forms live on any site)
  sw.js               service worker: opens the side panel, carries a tab's job to tabs it opens
  panel.html/css/js   the side panel: setup, Apply, Discover, Settings
  content.js          injected into every frame of a page on "Fill": reads questions, fills answers (no per-site code);
                      flags questions it can't place, with their surroundings, for fill.clarify (text, then screenshot)
  linkedin.js         injected into the Discover tab only: reads LinkedIn search cards and job details
  lib/
    llm.js            one structured-output call to Gemini or Claude with the user's key; prices; retries
    schema.js         strict JSON Schemas (every property required) + a checker for model output
    store.js          the data folder via the File System Access API; path guards
    data.js           what's in the folder: profile, learned memory (write guards), tracker.csv
    fill.js           the fill plan (prompt + code guards) and saving answers to memory
    discover.js       search plan from preferences, fit assessment, tracker writes
    cv.js             tailored CV variants: writer, fact check, one-page PDF (pdf-lib)
    jobs.js           queue, page → job matching, stages, proof screenshots
    setup.js          first-run: reading CVs, writing profile/preferences/standard answers
    vendor/           pinned third-party files (pdf-lib, MIT)
examples/data/        a fictional person's data folder (also the test fixture)
test/                 node --test suites
```

Plain JavaScript modules, no build step, no runtime dependencies beyond `lib/vendor/`.

## Develop

1. `chrome://extensions` → Developer mode → **Load unpacked** → `extension/`. After a change, press the reload
   icon on the extension's card, then close and reopen the side panel.
2. During setup, you can pick a copy of `examples/data` as the data folder to skip straight to using it.
3. WSL: Chrome on Windows can't load from the Linux filesystem directly. `scripts/sync-extension.sh
   /mnt/c/Users/<you>/job-applier-extension` copies it across.

## Test

```
npm test
```

Node 20+. No install needed. The tests run the real `lib/` code against a temporary folder (through an fs-backed
version of the folder handle in `test/fs-handle.js`) with scripted model outputs. Nothing calls a real API.

## Rules the code keeps (please keep them)

- **The user clicks Submit.** Nothing in the extension submits a form or clicks a submit button.
- **Never invent facts.** Answers come from the profile, CVs and learned memory; anything else is asked. Tailored
  CVs pass a fact check before they're saved.
- **The profile and the user's own CVs are read-only** to the extension. It only adds new files: learned memory
  (`memory/<kebab-name>.md` + `INDEX.md`), CV variants (new files in `profile/cvs/` + a line in its `INDEX.md`),
  tracker rows, saved postings and logs. These rules are enforced in `lib/data.js` and `lib/cv.js`, not only in
  prompts.
- **Model output is checked in code**: every field answered once, choices really offered, required fields never
  silently skipped, dealbreakers enforced, file names validated.
- **Generic, not per-site.** Form reading works from labels and ARIA, the way a person reads the page. Fix the
  general rule rather than special-casing a site.
- **Data goes only to the user's chosen AI provider.** No analytics, no other network calls.
- Never read or fill password or payment card fields.

## Pull requests

- Keep changes focused, and add or update a test in `test/` for anything in `lib/`.
- For `content.js` changes, say which sites you tried it on.
- Prompts live next to the code that uses them. If you change one, run it against both providers.
