# JobPilot

A Chrome extension that makes applying to internships fast:

1. **Upload your resume once.** Your selected AI provider turns it into editable boxes (sections, entries, bullets, skills).
2. **Browse jobs** in the side panel. The list is pulled from the SimplifyJobs Summer 2027 internship list, and you can mark jobs as applied.
3. **Tailor per job.** AI reads the posting and suggests rewording and reordering of your *existing* bullets and skills to match its keywords. You approve each change, and it never invents experience.
4. **Autofill.** On the application page it fills your name, contact info, school, links, work authorization, sponsorship and EEO answers, and attaches the tailored PDF, named like `Alex_Rivera_Resume_Stripe.pdf`.
5. **Answer the real questions.** AI drafts answers to "Why this company?" style questions. They're highlighted purple so you can review them before you click Submit.

Downloads go to `Downloads/Resumes/` and overwrite files with the same name, so you never end up with `Resume (100).pdf`.

## Resume format: Jake's Resume

Every PDF uses the style of [Jake's Resume](https://github.com/jakegut/resume) LaTeX template (MIT). `extension/lib/latex.js` turns the resume JSON into `.tex` deterministically: the same JSON always gives the same file.

- **Keeps your resume's layout.** When AI reads your PDF it also records how each section is laid out: organization or role on top, dates on the first or second line, one-line project headings with a GitHub link, single-line award rows, bold labels inside bullets, and the order of your contact line. You can change any of it under **Layout** on each section in the Resume tab. Resumes uploaded before this existed: click **Re-parse**.
- **Always one page.** If a tailored resume runs long, every font size and gap shrinks together (down to 85%) until it fits. Tailoring hides the least relevant bullets before it lets text get smaller than about 92%.

- **Exact LaTeX output:** if you use the Claude Code bridge and have a TeX engine installed (MacTeX on Mac, MiKTeX on Windows, TeX Live, or Tectonic), JobPilot compiles the `.tex` on your computer with `pdflatex`. Run `brew install --cask mactex-no-gui`, or `brew install tectonic` for something smaller.
- **No LaTeX installed:** JobPilot draws the same layout itself in Computer Modern (the LaTeX font), so it looks nearly identical.
- **Resume tab:** *Download .tex* gives you the source, and *Open in Overleaf* opens it as a new Overleaf project.

## Install (about 2 minutes)

1. Clone this repo: `git clone https://github.com/v1m08/Internships.git JobPilot`. (A clone lets JobPilot update itself. **Code → Download ZIP** also works, but then you update by hand.)
2. In Chrome, go to `chrome://extensions` and turn on **Developer mode** (top right).
3. Click **Load unpacked** and select the `extension` folder.
4. Pin the extension (puzzle icon → pin **JobPilot**). Click it, or press **Alt+J**, to open the side panel.

It also works in Brave, Edge and Arc (all Chromium-based).

## Set up

### 1. Connect AI (pick one)

**Option A: your Claude Pro/Max subscription, via Claude Code (no API key)**

JobPilot can't sign in with your Claude account directly; Anthropic only allows subscription logins inside Claude Code and claude.ai. Instead, a small bridge lets the extension ask **Claude Code on your computer** (`claude -p`) to do the AI work, so it uses your plan's normal usage limits.

1. Install [Claude Code](https://claude.com/claude-code) and [Node.js](https://nodejs.org) if you don't have them. Run `claude` once in a terminal and log in.
2. In a terminal, `cd` into this folder (the one containing `extension/` and `bridge/`) and run:
   ```
   node bridge/install.js
   ```
   Or just ask Claude Code: *"run node bridge/install.js"*.
3. Restart your browser. In JobPilot → **Settings → Connect AI**, choose **My Claude subscription** and click **Save & test**.

The installer copies the bridge to `~/.jobpilot/bridge` and registers it with Chrome, Brave, Edge, Arc and Chromium (on Windows, under the current user's registry). Only the JobPilot extension can talk to it. To remove it: `node bridge/install.js --uninstall`. If you install or move Claude Code later, re-run the installer.

**Option B: an Anthropic API key (pay-as-you-go)**

Choose **Anthropic API key** in Settings and paste a key from [console.anthropic.com → API Keys](https://console.anthropic.com/settings/keys) (add a few dollars of credit under Billing). Tailoring costs roughly 5–15¢ per job on Opus 5.5, about half that on Sonnet 5.5.

**Option C: OpenAI API key (ChatGPT models, pay-as-you-go)**

Choose **OpenAI API key (ChatGPT models)** under **Settings → Connect AI**. Create a key at [platform.openai.com → API keys](https://platform.openai.com/api-keys), enable API billing, paste the key, choose **GPT-5 mini** or **GPT-4.1**, and click **Save & test**. This option uses separate OpenAI API billing; it does not sign in to ChatGPT or use a ChatGPT subscription.

OpenAI supports the same workflows: PDF resume parsing, tailoring, draft answers, job targeting, feedback, and resolving stuck fields. It uses the [Responses API with structured outputs](https://developers.openai.com/api/docs/guides/structured-outputs) and [PDF file inputs](https://developers.openai.com/api/docs/guides/file-inputs). The existing checks on rewrites and Autopilot's rule against writing text answers apply to every provider. Keys and model choices are saved separately, so switching providers preserves your Claude setup. With OpenAI selected, PDFs use the built-in renderer; local LaTeX compilation still uses the Claude Code bridge option.

**Option D: your ChatGPT Plus/Pro plan (no API key)**

JobPilot supports OpenAI's [Sign in with ChatGPT flow for local open-source apps](https://developers.openai.com/siwc/token-sharing-open-source). Eligible accounts can authorize use of their ChatGPT plan or available credits; account/workspace eligibility and app usage limits still apply.

1. Install [Node.js](https://nodejs.org) **20 or newer**. Claude Code is optional for this option.
2. From the repo folder, run `node bridge/install.js` (run it again if you previously installed the bridge), then restart the browser and reload JobPilot in `chrome://extensions`.
3. Under **Settings → Connect AI**, choose **My ChatGPT subscription**, then **Continue with ChatGPT**. Keep the JobPilot panel open while you sign in and authorize plan usage in the new browser tab.
4. Choose a model from your account's live catalog and click **Save & test**. The first successful authorization shows a confirmation explaining plan usage.

**Add account** creates a separate account/workspace connection. The account picker keeps these registrations separate, including connections with the same email. **Continue with ChatGPT** reconnects the selected account, or lets you enable plan usage if you initially granted only identity access. **Manage usage** opens ChatGPT usage settings. **Sign out** attempts remote revocation, clears local tokens, and retains the registration so you can sign in again. If remote revocation cannot be confirmed, disconnect JobPilot in ChatGPT settings too.

The bridge stores OAuth credentials in `~/.jobpilot/chatgpt/accounts.json`, with owner-only directory/file permissions on Unix. Credentials are never stored in browser storage; the extension saves only the selected connection ID, model and permission status. Token refresh is serialized across bridge processes. Sign out before uninstalling the bridge if you want to end the session; uninstalling the bridge alone preserves its separate credentials directory. Resume PDFs are sent directly as file input to the public Responses API. Requests use `store: false` and `stream: true`, following the [preview request requirements](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations). Requests that hit subscription limits or lose permission stop and report the error; JobPilot does not switch to API billing automatically. With ChatGPT selected, PDFs use the built-in renderer.

### 2. Upload your resume

**Resume → Upload your resume (PDF).** Check the parsed boxes.

### 3. Check your profile

**Settings → Application profile / Standard answers.** These are pre-filled from your resume; check work authorization, sponsorship and the other standard answers.

**Flexible graduation date (optional).** If you could graduate any time in a range (say Dec 2028 by credits, May 2030 on the normal track), set *Earliest* and *Latest* under **Settings → Application profile → Flexible graduation date**. For each job, JobPilot reads who the posting is for ("graduating between Dec 2028 and Jun 2029", "class of 2029", "first-year students", "rising juniors"…) and picks the date in your range that fits, closest to your usual one. That date goes on that job's tailored resume (shown as a *Graduation* change you can untick) and into that application's graduation and class-year answers. Postings that don't say keep your usual date.

**Cover letter (optional).** In **Resume → Cover letter**, write an opening, a "why this company" paragraph, a closing, and a few short experience paragraphs, all in your own words. For each job, tailoring picks the experience paragraphs that best match the posting and fills in `{Company}` and `{Role}`. If you put `{Hook}` in your why paragraph, AI writes one sentence there about something specific in the posting, and may lightly reword your chosen paragraphs toward its terms. Those AI parts appear as *Cover letter* changes you can untick, and they're checked like resume rewrites (no new numbers, tools or skills). Autopilot leaves them out. The PDF uses your resume's header and fonts and is attached when a form has a cover letter field (Settings → Files & formatting).

### 4. Updates

JobPilot checks this repo for new commits every few hours and puts a **↑** badge on its icon when there's an update. Set it up in **Settings → Updates**:

- **Install automatically when the browser starts**, **Show a notice** (the default: an *Update now* button in the panel), or **Don't check**.
- **Repo / branch**: defaults to `v1m08/Internships` on `main`. If you fork JobPilot, point this at your fork.

One-click updates need a `git clone` and the Claude Code bridge installed from inside it (`node bridge/install.js`). The bridge runs `git pull --ff-only` in that folder, refreshes its own copy, and the extension reloads. Without the bridge, or with a ZIP download, JobPilot just tells you a newer version is out: run `git pull` (or re-download), then click reload on JobPilot in `chrome://extensions`.

If the folder Chrome loads JobPilot from already has newer files (you ran `git pull`, or edited the clone), JobPilot notices within a minute and restarts into them by itself when the panel and Autopilot aren't open; otherwise it shows *Restart now*.

Updates never touch your data. Your resume, profile and settings live in the browser, not in the repo folder.

## Autopilot (auto-apply)

**Jobs → Start Autopilot on the next N matching jobs.** It pulls jobs from every repo in **Settings → Job sources**, applies your **Filters**, and works through them in background tabs. By default it runs in a pinned JobPilot tab, so you can close the side panel; you get a notification when it's done.

For each job:

1. Opens the posting and clicks through to the application form.
2. On each page: fills what it can from your profile and saved answers (no AI), then one short AI pass for fields that got stuck. AI only *fills the form*: it picks the option that matches your profile (Degree "Bachelor's Degree"), chooses preference dropdowns, and fixes formats. It never writes answers.
3. Text questions are answered only with **your own words**: saved answers, or **Settings → Your answers**, a bank of answers to common questions you write once. AI recognizes when a differently-worded question asks the same thing ("What excites you about joining X?" ↔ "Why do you want to work at {Company}?") and uses your answer as written.
4. Tailors your resume (and cover letter, if you wrote one) and attaches them.
5. Clicks **Next/Continue** through multi-page forms (up to 6 pages), then **Submit**. If the site rejects a field ("enter a valid phone number"), AI fixes the fact or format once and resubmits.
6. Stops and leaves the tab for you when:
   - a question needs **your own words** and none of your answers fit (add one to *Your answers* and it's covered next time),
   - something is blocked (CAPTCHA, login, a missing required field),
   - or the site usually needs an account (Workday, iCIMS, Taleo, Amazon, Microsoft, Google): marked **Apply manually** (Try again attempts it anyway).

Every finished job except submitted ones has a **Try again** button (and **Try all again** for failed, blocked, not-eligible and apply-manually jobs): it closes the old tab and runs the job again right away, re-checking eligibility in case you changed your work status. On an *Apply manually* job it attempts the site anyway and only stops if it actually lands on a sign-in page.

**Running in the background.** Jobs open in their own unfocused *Autopilot* window (one per job at a time), as that window's visible tab, so Chrome doesn't throttle, freeze or unload them and you can keep using your own windows. Leave that window open, ideally not minimized. Autopilot's own waits run in a worker that Chrome doesn't slow down in hidden tabs, every step has a time limit, and a job that takes longer than 8 minutes is stopped and left as *Needs you* with the step it was on, so the queue keeps moving. The queue shows how long each running job has been on its current step.

Settings → Autopilot: auto-submit on/off, jobs at once, a randomized pause between applications, running in its own tab, and background checks for new jobs.

## Speed and consistency

- AI is only used for rewording bullets, essay answers and preference dropdowns, in one call per job. Everything else (keywords, ordering, page fit, standard answers) is plain code and gives the same result every time.
- AI results are cached by input, so re-running the same job reuses the earlier answer instantly.
- AI rewrites are checked in code: a rewrite is rejected if it changes a number or adds a tool or skill that isn't on your resume.
- "Save for next time" on an AI answer reuses it for the same question on later applications, with no AI call.
- Claude defaults to Sonnet; OpenAI defaults to GPT-5 mini. Choose the model for your selected provider in Settings.

## Telling AI what it got wrong

Wherever AI did something, there's a way to say what to change:

- **Apply tab → after Autofill → "Something's wrong? Tell AI"**: e.g. *"Start date should be August 2026, and pick Summer 2027 Internship instead of Both."* AI reads every field on the page with its current value and changes only the ones your note is about, showing *field: old → new*.
- **Tailored resume → "Redo with feedback"**: re-runs tailoring with your note (e.g. *"don't reword the Princeton bullets"*).
- **Autopilot queue**: *Fix with feedback* corrects a job whose tab is still open; *Try again with feedback* re-runs a failed job, and AI applies your note after filling.

Tick **Remember this for every application** and the note becomes a standing instruction (**Settings → Instructions for AI**) used on every job, including Autopilot runs. The no-AI-writing rule still holds: AI can change options and facts, or paste text you typed in the note, but it won't write an answer itself.

## Jobs that fit your resume

When your resume is parsed, AI reads it once and decides what you should be looking for: the categories (Software, AI/ML/Data, Quant, Product, Hardware), title words that mean a strong fit, title words that rule a role out (other engineering disciplines, unrelated functions), and the degree you're pursuing. It's in **Settings → What jobs to look for**, where you can change anything or have it re-read your resume.

Every listing is then scored against it without AI:

- **Not a fit** (hidden by **Filters → Only jobs that fit my resume**, on by default): the listing is only for Master's/PhD students (from Simplify's degree data or the title, e.g. "MS/PhD"), its term already started (a Fall 2026 co-op in October 2026), it's in a field you ruled out, or it's in a category you don't target.
- **★ Good fit**: your category and a strong title match. **~ Stretch**: another category, but clearly your kind of role (e.g. a software role filed under Hardware).

**Only fresh listings.** Autopilot never applies to a job posted more than 7 days ago (Settings → Autopilot → *Only apply to jobs posted in the last…*), or to one with no posting date. It checks when picking jobs and again right before each one, so older jobs already in the queue are marked *Too old* (Try again if you really want one). The job list also shows the last 7 days by default.

Good fits are listed first, so Autopilot starts with them. Autopilot also checks each posting's text and skips ones that require a graduate program as *Not a fit* (Try again if you want to apply anyway).

## Can you apply? (work authorization)

Set **Settings → Application profile → U.S. work status** (citizen, permanent resident, other authorization, student visa with CPT/OPT, or not authorized) and whether you hold a security clearance. JobPilot then marks every job:

- **✕ Can't apply**: something rules you out, e.g. U.S. citizenship or a clearance required, "must be authorized to work for any employer" (CPT/OPT doesn't count), "without sponsorship now or in the future", or no visa sponsorship when you need it.
- **? Check**: unclear or softer signals (e.g. the company usually doesn't sponsor H-1B).
- **✓ Can apply**: checked and nothing ruled you out.

Hover a badge to see why and the exact sentence. Where it looks:

- **Repo listings**: the 🛂 / 🇺🇸 flags and Simplify's sponsorship field (sparse: most listings say "Other").
- **Simplify's job pages**: for Simplify-sourced listings, JobPilot reads the page's data: H-1B sponsorship for the role and the company, and the posting's requirement sentences. Fetched a few at a time for the jobs you're looking at and cached for a week.
- **The posting itself**: on any job site, the Apply tab reads the page and shows the verdict under the job title.

**Jobs → Filters → Hide jobs I can't apply to** removes ✕ jobs from the list (on by default), and Autopilot checks each job again from its posting and skips it as *Not eligible* without filling anything. The keyword rules ignore equal-opportunity boilerplate ("without regard to … citizenship status") and handle negation ("we sponsor" vs "we do not sponsor").

## Saving jobs for later

Click **☆** on any job in the list (or **Save for later** on the Apply tab, for a job on any site, or on an Autopilot job) to keep it in **Jobs → ★ Saved** with a note, e.g. "needs a take-home project first". Autopilot skips saved jobs, since you've set them aside to do yourself.

## Daily flow

**Jobs** tab → click a job → **Apply** tab → **Tailor** → **Autofill this page** (click the site's *Apply* button first if the form is on another page) → **Draft answers** → review → Submit on the site → **Mark as applied**.

Colors on the page: **green** = filled, **amber** = needs you, **purple** = AI draft to review.

## What works where

| Site | Autofill | Resume attach |
|---|---|---|
| Greenhouse (classic and new boards, embedded iframes) | ✓ | ✓ |
| Lever | ✓ | ✓ |
| Ashby | ✓ | ✓ |
| Workday | Partial: one step at a time, so click Autofill on each page | Usually |
| Anything else | Best effort, label-based | Best effort |

Multi-page forms: click **Autofill this page** again on each step.

**When autofill gets stuck.** After filling what it can from your profile, JobPilot sends the leftover fields to one short AI call. Options that match your profile (Degree "Bachelor's Degree" for "Bachelor of Science") are filled green. Choices your profile doesn't state (which term, which team) are filled purple for you to check. Anything that needs your own words, or a fact AI doesn't have, is left empty and flagged amber. Searchable dropdowns built with react-select (new Greenhouse boards, Ashby and others) are filled through the component itself, so they work even while the side panel has focus.

## Privacy

Your resume, profile, API keys and applied list are stored in `chrome.storage.local` in your browser profile. AI requests send resume and application context to your selected provider: Anthropic through Claude Code or its API, or OpenAI through its API using your API key or authorized ChatGPT plan. Subscription OAuth tokens stay in the local bridge credential file described above. API keys are sent only to their respective provider for authentication. OpenAI requests set `store: false`; provider retention policies still apply. Job listings, eligibility lookups and update checks also contact the services described above.

## Development

```
extension/          the unpacked extension (no build step needed)
  sidepanel/        UI (vanilla JS modules)
  content/          autofill engine injected into job pages
  lib/              sources.js (GitHub repos), keywords.js + answers.js (deterministic),
                    tailor.js (per-job pipeline), autopilot.js, ai.js + openai.js (provider adapters), latex.js, pdf.js,
                    update.js (self-update from GitHub)
  fonts/            CMU Serif (Computer Modern, SIL OFL) for the built-in renderer
  vendor/           bundled @anthropic-ai/sdk and jsPDF
bridge/             native messaging host for Claude Code (`claude -p`), ChatGPT plan sign-in/inference, LaTeX and updates; plus its installer
```

Bump `version` in `extension/manifest.json` when you ship something, so people without the bridge get notified. People with the bridge see every new commit.

Nothing personal belongs in this repo: all user data stays in `chrome.storage.local`, and defaults live in `extension/lib/store.js`.

### Verify AI provider integration

Run `node --test tests/*.test.mjs` for mocked provider and subscription tests (no API key or billing required). These cover OpenAI PDF/JSON requests, Claude routing, OAuth callbacks and signed identity validation, permission checks, rotating-token refresh, model discovery, streaming failures, sign-out, and bridge packaging. The subscription tests bind only to localhost and use temporary credential files; all OpenAI responses are mocked. For a live check, load the extension, choose a provider under **Settings → Connect AI**, click **Save & test**, and upload a resume.
