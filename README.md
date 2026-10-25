# Job Applier

A Chrome extension that fills in job applications from your CV and your own answers, asks you about anything it
doesn't know, and (optionally) finds jobs on LinkedIn that fit what you're looking for. **You always review the
form and click Submit yourself.**

- **Bring your own AI key.** Google Gemini or Anthropic Claude. Typical use costs a few dollars a month, paid
  straight to the provider.
- **Your data stays on your computer**, as plain files in a folder you choose: your profile, your answers, your
  CVs and a job tracker spreadsheet. There's no account and no server, and nothing is collected.
- **Works on any application site** (Greenhouse, Lever, Ashby, Workable, Teamtailor, company career pages…). It
  reads the form the way a person does; there's no per-site code.

> Status: early. It works day to day for its author; expect rough edges on unusual forms.

## What it does

**Apply.** Open an application page and press **Fill this page**. Job Applier:

1. reads every question on the form, including dropdowns, radio buttons, checkboxes and file uploads;
2. works out each answer from your profile, CVs and the answers you've given before, in one model call;
3. fills them in, then checks each one stuck. Anything that didn't is flagged for you to do by hand;
4. asks you, in the side panel, about anything it can't answer from what it knows: salary, notice period, "Why
   do you want to work here?" (with a draft), anything legal. Your answers fill the form and, if you like, are
   remembered for next time;
5. picks the CV that fits the role best, or writes a tailored version for that type of role when it would clearly
   help (see [CVs](#cvs)).

Then you check the page and submit it yourself. **Mark applied** records it in your tracker with a screenshot.

**Discover (optional, off by default).** One button runs LinkedIn job searches built from your preferences, opens
each new listing, judges how well it fits you, and adds the good ones to your queue. See
[the LinkedIn caveat](#linkedin) before turning it on.

**What it won't do:** submit for you, solve CAPTCHAs, create accounts, type passwords or payment details, or apply
through LinkedIn Easy Apply.

## Install

**From the Chrome Web Store:** coming soon.

**From source** (any Chromium browser, version 122 or later):

1. Download or clone this repository.
2. Open `chrome://extensions`, turn on **Developer mode**, click **Load unpacked**, and pick the `extension`
   folder.
3. Click the Job Applier icon in the toolbar to open the side panel. (Pin it from the puzzle-piece menu first if
   you don't see it.)

## Setup (about 5 minutes)

The side panel walks you through it the first time you open it:

1. **AI provider and key.** Pick Gemini (cheapest) or Claude, and paste an API key:
   [Gemini](https://aistudio.google.com/apikey) · [Claude](https://console.anthropic.com/settings/keys).
   Consider setting a spending limit on the key at the provider.
2. **Data folder.** Pick or create an empty folder, for example `Documents/Job Applier`. Chrome asks permission;
   choose **Allow on every visit** so it doesn't ask again after a restart.
3. **Your CVs.** Add the PDF(s) you apply with and say which roles each one is for. They're read into a text copy;
   the PDFs themselves are uploaded to applications unchanged.
4. **About you.** Contact details and links, read from your CV for you to check.
5. **What you're looking for.** Roles, locations, work mode, seniority, salary, sponsorship, industries,
   dealbreakers. Plain words are fine.
6. **Questions most forms ask.** Right to work, notice period, salary expectations, relocation, diversity
   questions. Answer once, or skip and be asked when a form needs it.
7. **Discover.** Turn it on or leave it off.

Everything can be changed later in **Settings** (⚙).

## Costs

You pay your AI provider directly. Measured in October 2026 with Gemini's default models:

| Action | Cost |
|---|---|
| Fill one application page | about $0.025 |
| Judge one LinkedIn listing | about $0.015 |
| Write a tailored CV (including the fact check) | about $0.02–0.04 |
| A busy month (about 300 listings judged, 60 applications) | about $6–8 |

Claude's default models cost about the same. The panel shows what you've spent this month, and you can set a
monthly budget in Settings.

## Your data folder

```
Job Applier/
  profile/
    profile.md          contact details and links
    preferences.md      what you're looking for
    cvs/
      INDEX.md          which CV is for which roles
      <name>.pdf        your CVs, uploaded as they are
      <name>.md         text copies, used to write tailored versions
  memory/
    INDEX.md            what each answer file covers
    notice-period.md …  answers you've given, one topic per file
  tracker.csv           every job: found, applied, skipped… (opens in any spreadsheet app)
  jobs/<id>.md          the full text of postings Discover saved
  logs/                 what was filled on each form, and screenshots of submitted applications
```

They're plain text: edit them in Settings or any editor, back them up, or keep them in git. Job Applier never
edits your profile or your own CVs; it only adds new files (answers you agreed to save, tailored CVs) and updates
the tracker.

## CVs

When a form has a CV upload, Job Applier compares the job's requirements with your CVs and uploads the best fit.
If none of them puts the job's core requirements up front, it writes a tailored version **for that type of role**
(for example "data engineer", never one per company) and reuses it for similar jobs later.

A tailored CV only reorders, reframes and trims what's already true. Before it's saved, a second model call checks
every claim against your own CVs and answers; anything unsupported gets it rejected and rewritten once, and if it
still fails, your normal CV is uploaded instead. Tailored CVs use one clean layout (not your original design), so
press **View CV** to check one before you submit.

## Privacy

- Your API key is stored in this browser only (`chrome.storage.local`, never synced) and sent only to your AI
  provider.
- To fill a form or judge a job, the page's questions, the job description, your profile, your answers and your
  CV text are sent to your AI provider. Nothing is sent anywhere else. There are no analytics.
- Your data is in your folder. Uninstalling the extension doesn't delete it.

Details: [PRIVACY.md](PRIVACY.md).

## LinkedIn

LinkedIn's terms don't allow automated browsing, and LinkedIn can restrict accounts it believes are automated.
Discover is off by default. When on, it paces itself like a person, stops after a set number of listings (10 new
jobs or 50 opened, adjustable), skips Easy Apply, and never clicks Apply. **Using it is your call and your risk.**
Everything else works without it: open any application page yourself and press Fill.

## FAQ

**Does it submit applications?** No. It fills the form; you read it and click Submit.

**A field didn't fill.** Some custom widgets ignore scripted input. It's marked ✗ in the panel; fill it by hand.
Please [open an issue](../../issues) with the site's name so the reader can be improved.

**It asked me something it should know.** Answer it with "Save to memory" ticked and it won't ask again. You can
also edit `memory/` files directly.

**Firefox / Safari?** Not yet. It uses Chrome's side panel and folder-access APIs (also in Edge, Brave and other
Chromium browsers).

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Bug reports with the site name (and, if you can, the anonymised field list
from `logs/plans.jsonl`) are the most useful thing you can send.

## Licence

[MIT](LICENSE)
