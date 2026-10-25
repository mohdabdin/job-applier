# Privacy policy

Job Applier is a browser extension that runs entirely on your computer. Its authors don't operate any server and
don't receive, collect or store any of your data.

## What the extension stores, and where

- **Settings and your AI provider API key:** in your browser's extension storage (`chrome.storage.local`). It is
  not synced to other devices and is only readable by this extension.
- **Your profile, answers, CVs, job tracker, saved job postings and application screenshots:** as files in a
  folder on your computer that you choose during setup. The extension can only access that folder, and only after
  you grant permission.
- **The folder's permission handle:** in the extension's IndexedDB, so you don't have to pick the folder again.

## What is sent, and to whom

Only to the AI provider you chose (Google's Gemini API or Anthropic's Claude API), using your own API key, and only
when you use a feature that needs it:

- **Fill this page:** the form's questions and options, the page's text, the job description if saved, your
  profile, your saved answers and the text of your CVs. If a question can't be read from the page's text, a
  screenshot of the visible part of the page (with that field outlined) is sent too, at most four per fill.
- **Saving an answer to memory:** the question, your answer and your saved answers.
- **Tailored CVs:** a CV's text, the job description, your profile and saved answers.
- **Discover:** the text of LinkedIn job listings it opens, with your profile and preferences.
- **Setup:** the CV PDFs you add, so they can be read into text.

Your provider's own terms and privacy policy apply to that data: [Google](https://ai.google.dev/gemini-api/terms),
[Anthropic](https://www.anthropic.com/legal/commercial-terms).

## What the extension does on web pages

- On a page where you press **Fill this page**, it reads the form and fills in fields. It never submits a form,
  never reads or fills password or payment card fields, and never clicks Submit.
- **Mark applied** takes a screenshot of the visible tab and saves it to your data folder.
- If you turn on **Discover**, it opens LinkedIn job searches in a tab, clicks job listings to read them, and never
  clicks Apply or Easy Apply.

## No tracking

No analytics, no telemetry, no advertising, no third-party scripts. The extension's code is open source in this
repository.

## Removing your data

Uninstall the extension to remove its settings and API key. Your data folder is yours: delete it whenever you like.

## Contact

Open an issue in this repository.
