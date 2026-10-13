// Autopilot: apply to one job end to end in a background tab.
//
//   open posting → reach the form → for each page: rules, AI for stuck
//   fields, answers (profile, saved, your answer bank, then AI drafts)
//   → Next until Submit → submit; if the site rejects fields, AI fixes
//   facts/formats once and resubmits.
//
// Submission rule: AI never writes text answers here. It fills forms
// (options, formats, matching your own written answers). Text questions with
// no answer of yours are left empty and the job stops as "needs-you".
//
// Returns { status, note, tabId?, tailored? }. Statuses:
//   applied    submitted and the site confirmed it (tab closed)
//   review     filled, but has AI-written answers → you review + submit
//   needs-you  blocker (CAPTCHA, login, missing required field, no confirmation)
//   manual     site needs an account (Workday etc.); not opened
//   ineligible your U.S. work status rules it out (eligibility.js); tab closed
//   notfit     the posting requires a degree program you're not in (fit.js)
//   stale      posted longer ago than Settings → Autopilot allows (default 7 days)
//   failed     error
import * as G from "./grad.js";
import { resolveStuck, fixInvalid, fixWithFeedback } from "./resolve.js";
import { resumeToText } from "./pdf.js";
import * as Page from "./page.js";
import { prepareJob, tailoredEntry } from "./tailor.js";

// Sites that usually need an account. Skipped by default; "Try again" on one
// (ctx.force) attempts it anyway and stops only at an actual sign-in page.
const ACCOUNT_SITES = /myworkdayjobs\.com|workday\.com|icims\.com|taleo\.net|successfactors|oraclecloud\.com|brassring|amazon\.jobs|careers\.microsoft\.com|google\.com\/about\/careers|careers\.google\.com/i;
import { sleep } from "./clock.js";
import { signInFlow } from "./accounts.js";

// A job that takes longer than this is stopped and left for you, so one
// stuck site can't hold up the queue.
const JOB_LIMIT_MS = 8 * 60 * 1000;
const MAX_PAGES = 6; // multi-page forms: Next/Continue up to this many times
const isTyped = (q) => q.kind === "short_text" || q.kind === "long_text";

// ctx: { settings, profile, base, savedAnswers, tailoredFor(job), saveTailored(job, entry),
//        resumeFileFor(job, tailored) → Promise<{name, base64}>, step(text) }
export async function runJob(job, ctx) {
  const step = ctx.step || (() => {});
  // Never apply to old listings (or ones with no posting date).
  const maxDays = ctx.settings.autopilot.maxAgeDays ?? 7;
  const posted = job.posted || ctx.postedFor?.(job) || 0;
  if (maxDays > 0 && !ctx.force && !isFresh(posted, maxDays)) {
    return { status: "stale", note: posted ? `Posted ${Math.floor((Date.now() / 1000 - posted) / 86400)} days ago; Autopilot only applies to jobs from the last ${maxDays} days.` : "No posting date, so it can't be confirmed as recent." };
  }
  // With sign-in turned on, account sites are attempted like any other.
  if (ACCOUNT_SITES.test(job.url) && !ctx.force && !ctx.settings.accounts?.enabled) return { status: "manual", note: "This site usually needs an account. Try again to attempt it anyway, or open it and click Autofill on each page." };

  step("Opening");
  let tab = await openJobTab(job.url, ctx.slot);
  ctx.onTab?.(tab.id);
  try {
    let size = await Page.waitForForm(tab);
    let posting = null;
    try {
      posting = await Page.readJobPosting(await chrome.tabs.get(tab.id));
    } catch {}

    // Reach the application form (click "Apply" up to twice).
    for (let i = 0; i < 2 && size.controls < 3; i++) {
      const hit = (await Page.callAll(tab, "clickApply")).find((c) => c.clicked);
      if (!hit) break;
      step("Opening application form");
      await sleep(600);
      size = await Page.waitForForm(tab);
    }
    tab = await chrome.tabs.get(tab.id);

    // A sign-in wall instead of the form (or a sign-in form that looks like
    // one): sign in / create an account if you turned that on, then go on.
    const acct = (await Page.callAll(tab, "accountPage").catch(() => [])).find((p) => p.kind !== "none") || { kind: "none" };
    const wall = acct.kind !== "none" || (size.controls < 3 && (await Page.callAll(tab, "signInWall").catch(() => [])).some(Boolean));
    if (wall) {
      const r = await signInFlow(tab, { settings: ctx.settings, profile: ctx.profile, job, step });
      if (!r.ok) return { status: ctx.settings.accounts?.enabled ? "needs-you" : "manual", note: r.note, tabId: tab.id };
      step(r.note || "Signed in");
      tab = await chrome.tabs.get(tab.id);
      size = await Page.waitForForm(tab);
      // Many sites land back on the posting after signing in.
      for (let i = 0; i < 2 && size.controls < 3; i++) {
        if (!(await Page.callAll(tab, "clickApply")).find((c) => c.clicked)) break;
        await sleep(600);
        size = await Page.waitForForm(tab);
      }
      tab = await chrome.tabs.get(tab.id);
    }
    if (size.controls < 3) return { status: "needs-you", note: "Couldn't find the application form (unusual Apply button?).", tabId: tab.id };

    if (!posting) posting = await Page.readJobPosting(tab).catch(() => ({ text: "" }));

    // A fit at all? Postings that require a graduate program are skipped.
    if (ctx.fit && !ctx.force) {
      const f = ctx.fit(job, posting?.text || "");
      if (f?.level === "no") {
        await chrome.tabs.remove(tab.id).catch(() => {});
        return { status: "notfit", note: `${f.reasons[0]}. Try again if you want to apply anyway.` };
      }
    }

    // Can you apply at all? Don't fill applications your status rules out.
    if (ctx.eligibility) {
      const v = await ctx.eligibility(job, posting?.text || "");
      if (v.level === "no") {
        await chrome.tabs.remove(tab.id).catch(() => {});
        return { status: "ineligible", note: `${v.reasons[0].text}: "${v.reasons[0].evidence.slice(0, 120)}"` };
      }
    }
    if (!job.company || !job.title) {
      const meta = (await Page.callAll(tab, "jobMeta")).find((m) => m.company || m.role) || {};
      job = { ...job, company: job.company || meta.company, title: job.title || meta.role };
    }

    // This job's graduation date (flexible window).
    const existing = ctx.tailoredFor(job);
    const profile = G.profileWithGrad(ctx.profile, existing ? existing.grad : G.gradForJob(ctx.profile, posting?.text, job.title)?.date);
    const resumeText = resumeToText(ctx.base);
    const unstick = { settings: ctx.settings, profile, resumeText, posting: posting?.text || "", instructions: ctx.settings.instructions || "" };

    let tailored = existing;
    let files = null; // { file, coverFile } once the resume is ready
    let filledCount = 0;
    let aiUsed = false;
    let attachedResume = false;
    const aiTyped = [];

    // One page of the form: rules, then AI for stuck fields, then the
    // real questions (your saved/bank answers first, AI drafts the rest).
    for (let page = 0; page < MAX_PAGES; page++) {
      const where = page ? `Page ${page + 1}: ` : "";
      step(`${where}Filling`);
      const first = await Page.autofill(tab, { profile, resumeFile: files?.file || null, coverFile: files?.coverFile || null, coverOnlyIfRequired: ctx.coverOnlyIfRequired });
      try {
        const r = await resolveStuck(tab, unstick);
        filledCount += r.filled.length + r.drafted.length;
      } catch {}
      const questions = await Page.collectQuestions(tab);

      step(`${where}${questions.length ? `Preparing ${files ? "" : "resume + "}${questions.length} answer${questions.length === 1 ? "" : "s"}` : files ? "Checking" : "Preparing resume"}`);
      const prep = await prepareJob({
        settings: ctx.settings,
        base: ctx.base,
        posting,
        job,
        profile: ctx.profile,
        savedAnswers: ctx.savedAnswers,
        questions,
        useAI: true,
        autopilot: true,
        cover: ctx.cover,
        bank: ctx.bank || [],
        answersOnly: !!files,
        instructions: ctx.settings.instructions || "",
        feedback: ctx.feedback || "",
      });
      aiUsed = aiUsed || prep.aiUsed;
      if (!files) {
        if (!tailored && ctx.settings.autopilot.tailor) {
          tailored = tailoredEntry(ctx.base, prep, job.url);
          await ctx.saveTailored(job, tailored);
        }
        files = {
          file: await ctx.resumeFileFor(job, tailored),
          coverFile: ctx.coverFileFor ? await ctx.coverFileFor(job, tailored).catch(() => null) : null,
        };
      }

      // Attach (and catch fields that appeared late), then the answers.
      const report = await Page.autofill(tab, { profile: G.profileWithGrad(ctx.profile, tailored ? tailored.grad : prep.grad), resumeFile: files.file, coverFile: files.coverFile, coverOnlyIfRequired: ctx.coverOnlyIfRequired });
      const toFill = prep.answers.filter((a) => a.answer);
      if (toFill.length) await Page.fillAnswers(tab, toFill);
      const attested = (await Page.callAll(tab, "checkAttestations")).reduce((a, b) => a + b, 0);
      filledCount += first.filled.length + toFill.length + attested;
      // Your feedback from the last attempt: AI corrects those fields.
      if (ctx.feedback) {
        step(`${where}Applying your feedback`);
        await fixWithFeedback(tab, unstick, ctx.feedback).catch(() => {});
      }
      aiTyped.push(...prep.answers.filter((a) => isTyped(a) && a.source === "ai"));

      const needsWords = prep.answers.filter((a) => a.required && !a.answer && a.source === "needs-words");
      const unanswered = prep.answers.filter((a) => a.required && !a.answer && a.source !== "needs-words");
      const missing = (await Page.callAll(tab, "missingRequired")).flat();
      const captcha = (await Page.callAll(tab, "detectCaptcha")).some(Boolean);
      attachedResume = attachedResume || !!(report.attached || first.attached);
      const pageHasUpload = (await Page.callAll(tab, "formStats")).some((f) => f.fileInputs);
      const blockers = [];
      if (pageHasUpload && !attachedResume) blockers.push("resume upload");
      if (needsWords.length) blockers.push(`your own words for: ${needsWords.slice(0, 3).map((q) => `"${q.question.slice(0, 50)}"`).join("; ")} (add answers in Settings → Your answers to cover these next time)`);
      if (unanswered.length) blockers.push(`unanswered: ${unanswered.slice(0, 3).map((q) => q.question.slice(0, 40)).join("; ")}`);
      else if (!needsWords.length && missing.length) blockers.push(`required: ${missing.slice(0, 3).join(", ")}${missing.length > 3 ? "…" : ""}`);
      if (captcha) blockers.push("CAPTCHA");
      if (blockers.length) return { status: "needs-you", note: `${where}Filled ${filledCount}. Needs you: ${blockers.join("; ")}.`, tabId: tab.id, tailored };

      // Safety net: Autopilot doesn't ask AI for text answers, but if any
      // AI-written text is on the page, it waits for you.
      if (aiTyped.length || !ctx.settings.autopilot.autoSubmit) {
        return {
          status: "review",
          note: aiTyped.length ? `${where}Filled ${filledCount}; ${aiTyped.length} AI-written answer${aiTyped.length === 1 ? "" : "s"} (purple) to review, then continue.` : `Filled ${filledCount}. Auto-submit is off: review and Submit.`,
          tabId: tab.id,
          tailored,
        };
      }

      // Next page, or on to Submit.
      const nav = (await Page.callAll(tab, "pageNav")).reduce((a, b) => ({ submit: a.submit || b.submit, next: a.next || b.next }), { submit: false, next: false });
      if (nav.submit || !nav.next) break;
      step(`${where}Next page`);
      const before = (await Page.callAll(tab, "formStats")).map((f) => f.url).join();
      (await Page.callAll(tab, "clickNext")).find((c) => c.clicked);
      await sleep(900);
      size = await Page.waitForForm(tab);
      const after = (await Page.callAll(tab, "formStats")).map((f) => f.url).join();
      if (page === MAX_PAGES - 1 || (after === before && !size.controls)) return { status: "needs-you", note: `Filled ${filledCount} across ${page + 1} pages but couldn't reach Submit.`, tabId: tab.id, tailored };
    }

    // Submit, wait for the site's confirmation; if it rejects fields, let
    // AI fix facts/formats once and resubmit.
    for (let attempt = 0; attempt < 2; attempt++) {
      step(attempt ? "Fixing errors and resubmitting" : "Submitting");
      const clicked = (await Page.callAll(tab, "submit")).find((c) => c.clicked);
      if (!clicked) return { status: "needs-you", note: "Filled everything but couldn't find the Submit button.", tabId: tab.id, tailored };
      let errors = [];
      for (let i = 0; i < 20; i++) {
        await sleep(750);
        let states;
        try {
          states = await Page.callAll(tab, "submissionState");
        } catch {
          continue; // page navigating
        }
        if (states.some((s) => s.confirmed)) {
          await chrome.tabs.remove(tab.id).catch(() => {});
          return { status: "applied", note: `Submitted (${filledCount} fields${aiUsed ? ", AI-matched options" : ""}${attempt ? ", fixed after an error" : ""}).`, tailored };
        }
        errors = states.flatMap((s) => s.errors);
        if (i >= 4 && errors.length) break;
      }
      if (!errors.length) return { status: "needs-you", note: "Clicked Submit but saw no confirmation. Check the tab.", tabId: tab.id, tailored };
      const fixed = attempt === 0 ? await fixInvalid(tab, unstick).catch(() => 0) : 0;
      if (!fixed) return { status: "needs-you", note: `Submit showed: ${errors.slice(0, 2).join(" / ")}`, tabId: tab.id, tailored };
    }
    return { status: "needs-you", note: "The site still showed errors after a fix. Check the tab.", tabId: tab.id, tailored };
  } catch (e) {
    return { status: "failed", note: e.message || String(e), tabId: tab.id };
  }
}

// posted: epoch seconds (0 = unknown, which doesn't count as fresh).
export function isFresh(posted, maxDays) {
  return !!posted && Date.now() / 1000 - posted <= maxDays * 86400;
}

// Each worker gets its own unfocused Autopilot window and opens jobs as that
// window's visible tab. Background tabs get their timers throttled and can
// be frozen or unloaded by Chrome; the visible tab of a window doesn't, and
// you can keep using your own windows meanwhile.
async function openJobTab(url, slot) {
  let tab = null;
  if (slot?.windowId) {
    try {
      tab = await chrome.tabs.create({ windowId: slot.windowId, url, active: true });
    } catch {
      slot.windowId = null; // you closed it
    }
  }
  if (!tab) {
    try {
      const win = await chrome.windows.create({ url, focused: false, state: "normal", width: 1100, height: 900 });
      if (slot) slot.windowId = win.id;
      tab = win.tabs[0];
    } catch {
      tab = await chrome.tabs.create({ url, active: false });
    }
  }
  chrome.tabs.update(tab.id, { autoDiscardable: false }).catch(() => {});
  return tab;
}

// Run a queue with limited concurrency. items: [{ job, status }]
// onUpdate(item) after each change; shouldStop() checked between jobs.
export async function runQueue(items, ctx, { concurrency = 2, onUpdate, shouldStop, pauseSec = 0 }) {
  let next = 0;
  let started = 0;
  const worker = async (slotIndex) => {
    const slot = { index: slotIndex, windowId: null };
    while (next < items.length && !shouldStop()) {
      const item = items[next++];
      if (item.status !== "queued") continue;
      // Randomized pause between applications (50%–150% of the setting).
      if (started++ >= concurrency && pauseSec > 0) {
        await sleep(pauseSec * 1000 * (0.5 + Math.random()));
        if (shouldStop()) break;
      }
      item.status = "running";
      item.note = "";
      onUpdate(item);
      // Watchdog: past the time limit, stop at the next step and move on.
      let cancelled = false;
      let tabId = null;
      const jobCtx = {
        ...ctx,
        slot,
        feedback: item.feedback || "",
        force: !!item.force,
        onTab: (id) => (tabId = id),
        step: (s) => {
          if (cancelled) throw new Error("stopped");
          item.note = s;
          item.stepAt = Date.now();
          onUpdate(item);
        },
      };
      const res = await Promise.race([
        runJob(item.job, jobCtx),
        sleep(JOB_LIMIT_MS).then(() => {
          cancelled = true;
          return { status: "needs-you", note: `Stopped after ${JOB_LIMIT_MS / 60000} min at "${item.note || "starting"}". The tab is left open; Try again or finish it yourself.`, tabId };
        }),
      ]);
      Object.assign(item, res, { finishedAt: Date.now(), stepAt: null });
      onUpdate(item);
    }
  };
  await Promise.all(Array.from({ length: concurrency }, (_, i) => worker(i)));
}
