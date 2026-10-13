import * as store from "../lib/store.js";
import * as R from "../lib/resume.js";
import * as AI from "../lib/ai.js";
import { renderResume, resumeToText, loadFonts } from "../lib/pdf.js";
import { buildResumePdf, latexStatus, resetLatexStatus, texFor, buildCoverPdf } from "../lib/render.js";
import * as Jobs from "../lib/jobs.js";
import * as Page from "../lib/page.js";
import * as Update from "../lib/update.js";
import * as L from "../lib/layout.js";
import * as G from "../lib/grad.js";
import { resolveStuck, fixWithFeedback } from "../lib/resolve.js";
import * as C from "../lib/cover.js";
import * as E from "../lib/eligibility.js";
import * as Fit from "../lib/fit.js";
import * as Accounts from "../lib/accounts.js";
import { gmailAccount, testGmail } from "../lib/gmail.js";
import * as Sources from "../lib/sources.js";
import * as Autopilot from "../lib/autopilot.js";
import * as Ans from "../lib/answers.js";
import * as K from "../lib/keywords.js";
import { prepareJob, tailoredEntry, gradIfAccepted } from "../lib/tailor.js";

// ------------------------------------------------------------------ state

const S = {
  settings: null,
  chatgptSession: null,
  chatgptModels: [],
  chatgptError: "",
  chatgptLoading: false,
  chatgptSigningIn: false,
  profile: null,
  base: null, // resume model
  resumePdf: null, // { name, base64 } originally uploaded file
  tailored: {}, // jobKey -> { company, role, url, resume, changeCount, keywords, missing, createdAt }
  applied: {}, // jobKey -> { company, title, url, date }
  cover: null, // your cover letter template (lib/cover.js)
  bank: [], // your answer bank (lib/cover.js DEFAULT_BANK)
  eligStore: {}, // jobId -> { signals, at }: Simplify job data, cached a week
  eligSignals: {}, // jobId -> signals (fresh entries of eligStore)
  eligPage: {}, // jobKey -> signals read from the open posting
  fb: {}, // open feedback boxes: key -> { open, text, remember }
  saved: {}, // jobKey -> { key, company, title, url, locations, note, savedAt }: jobs you saved for later
  accounts: {}, // siteKey -> { email, password, createdAt, company, verified }: accounts JobPilot made
  showSaved: false, // Jobs tab: show your saved jobs instead of the list
  fixResult: null, // last "fix with my feedback" result on the Apply tab
  jobsCache: { fetchedAt: 0, items: [] },
  tab: null,
  job: null, // { key, company, title, url, listingId? }
  posting: {}, // jobKey -> posting text, cached for the session
  pending: null, // tailoring review in progress
  report: null,
  answers: null,
  busy: {},
  taskErrors: {}, // task name -> last error message
  editing: "base",
  jobsQuery: "",
  jobsCategory: "",
  hideApplied: true,
  jobsShown: 50,
  activeTab: "apply",
  queue: [], // autopilot items
  autopilotRunning: false,
  jobsByKey: new Map(),
};

// ---------------------------------------------------------------- helpers

// Every write to storage goes through persist(), so the storage listener can
// tell our own writes from changes made in another JobPilot page (the pinned
// Autopilot tab, the background worker) and apply only those.
const lastWritten = new Map();
function persist(key, value) {
  try {
    lastWritten.set(key, JSON.stringify(value));
  } catch {}
  return store.set(key, value);
}

// One re-render of whatever tab you're on, after the current burst of state
// changes. Tasks and storage updates call this instead of re-rendering a
// fixed tab.
let renderQueued = false;
function invalidate() {
  if (renderQueued) return;
  renderQueued = true;
  queueMicrotask(() => {
    renderQueued = false;
    render();
  });
}

const $ = (sel) => document.querySelector(sel);

// el.append(a, cond ? b : null) should skip empty values like h() does,
// not print "null"/"false" into the panel.
const nativeAppend = Element.prototype.append;
Element.prototype.append = function (...nodes) {
  return nativeAppend.apply(this, nodes.filter((n) => n !== null && n !== undefined && n !== false));
};

function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === "class") el.className = v;
    else if (k === "style" && typeof v === "object") Object.assign(el.style, v);
    else if (k === "value") el.value = v;
    else if (k === "checked") el.checked = !!v;
    else if (k === "html") el.innerHTML = v;
    else el.setAttribute(k, v === true ? "" : v);
  }
  for (const c of children.flat(Infinity)) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

let toastTimer;
function toast(msg, isError = false) {
  const t = $("#toast");
  t.textContent = msg;
  t.className = `toast show${isError ? " error" : ""}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.className = "toast"), isError ? 6000 : 3000);
}

function debounce(fn, ms) {
  let t;
  return (...a) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...a), ms);
  };
}

// Run one task on its own: it shows as busy wherever its button is, never
// blocks other tasks, and when it ends the tab you're on refreshes (even if
// you switched tabs meanwhile). Its last error stays in S.taskErrors[name].
async function withBusy(name, fn) {
  if (S.busy[name]) return;
  S.busy[name] = true;
  S.taskErrors[name] = null;
  invalidate();
  try {
    await fn();
  } catch (e) {
    console.error(e);
    S.taskErrors[name] = e.message || String(e);
    toast(e.message || String(e), true);
  } finally {
    S.busy[name] = false;
    invalidate();
  }
}

const spinner = () => h("span", { class: "spinner" });

// AI is usable via an API key or the Claude Code bridge.
const aiReady = () => AI.isConfigured(S.settings);

function hasContent(r) {
  return !!(r && (r.basics?.name || r.sections?.length));
}

function autoGrow(el) {
  el.style.height = "auto";
  el.style.height = `${el.scrollHeight + 2}px`;
}

function textarea(attrs) {
  const el = h("textarea", { rows: 1, ...attrs });
  el.addEventListener("input", () => autoGrow(el));
  requestAnimationFrame(() => autoGrow(el));
  return el;
}

const saveBase = debounce(() => persist("resume", S.base), 400);
const saveTailored = debounce(() => persist("tailored", S.tailored), 400);
const saveProfile = debounce(() => persist("profile", S.profile), 400);
const saveSettings = debounce(() => persist("settings", S.settings), 400);

function downloadBase64(base64, filename, mime = "application/pdf") {
  return chrome.downloads.download({
    url: `data:${mime};base64,${base64}`,
    filename: `Resumes/${filename}`,
    conflictAction: "overwrite",
    saveAs: false,
  });
}

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(String(fr.result).split(",")[1]);
    fr.onerror = () => reject(fr.error);
    fr.readAsDataURL(file);
  });
}

function switchTab(name) {
  S.activeTab = name;
  document.querySelectorAll(".tabs button").forEach((b) => b.classList.toggle("active", b.dataset.tab === name));
  document.querySelectorAll(".panel").forEach((p) => p.classList.toggle("active", p.id === `tab-${name}`));
  render();
}

function render() {
  if (S.activeTab === "apply") renderApply();
  if (S.activeTab === "jobs") renderJobs();
  if (S.activeTab === "resume") renderResumeTab();
  if (S.activeTab === "settings") renderSettings();
}

// Re-rendering replaces a tab's elements; put your cursor, selection and
// scroll back so live updates don't interrupt typing.
function pathIn(root, el) {
  const path = [];
  for (let n = el; n && n !== root; n = n.parentElement) path.unshift([...n.parentElement.children].indexOf(n));
  return path;
}
function keepFocus(fn) {
  return (...args) => {
    const panel = document.querySelector(".panel.active");
    const a = document.activeElement;
    let saved = null;
    if (panel && a && a !== document.body && panel.contains(a)) {
      saved = { path: pathIn(panel, a), tag: a.tagName, sel: typeof a.selectionStart === "number" ? [a.selectionStart, a.selectionEnd] : null };
    }
    const scroll = document.scrollingElement?.scrollTop || 0;
    const out = fn(...args);
    if (saved && panel?.isConnected) {
      let el = panel;
      for (const i of saved.path) el = el?.children[i];
      if (el && el.tagName === saved.tag && el !== document.activeElement) {
        el.focus({ preventScroll: true });
        if (saved.sel) {
          try {
            el.setSelectionRange(...saved.sel);
          } catch {}
        }
      }
    }
    if (document.scrollingElement) document.scrollingElement.scrollTop = scroll;
    return out;
  };
}

// --------------------------------------------------------- job context

function jobFromListing(l) {
  return { key: Jobs.jobKeyForUrl(l.url), listingId: l.id, company: l.company, title: l.title, url: l.url, locations: l.locations, posted: l.posted || 0 };
}

async function refreshContext() {
  const tab = await Page.activeTab();
  S.tab = tab;
  let job = tab ? await store.getTabJob(tab.id) : null;
  if (!job && tab?.url && /^https?:/.test(tab.url)) {
    const key = Jobs.jobKeyForUrl(tab.url);
    const hit = S.jobsByKey.get(key);
    job = hit ? jobFromListing(hit) : { key, company: "", title: "", url: tab.url, adhoc: true };
  }
  if (!job || !tab || !/^https?:/.test(tab.url || "")) job = null;
  if (job?.key !== S.job?.key) {
    S.pending = null;
    S.report = null;
    S.answers = null;
  }
  S.job = job;
  if (S.activeTab === "apply") renderApply();
  // Can you apply? Read the posting on this page (and Simplify's data).
  if (job && !S.eligPage[job.key]) {
    const listing = S.jobsByKey.get(job.key);
    if (listing) enrichEligibility([listing]);
    Page.readJobPosting(tab)
      .then((p) => {
        S.eligPage[job.key] = E.signalsFromText(p.text);
        S.posting[job.key] ||= p;
        if (S.job?.key === job.key && S.activeTab === "apply") renderApply();
      })
      .catch(() => {});
  }
}

// "Not a fit" note on the Apply tab (listing data, then the posting text).
function fitNotice() {
  const listing = S.jobsByKey.get(S.job.key);
  const f = (listing && Fit.fitOf(listing, S.settings.target).level === "no" && Fit.fitOf(listing, S.settings.target)) || Fit.fitFromPosting(S.posting[S.job.key]?.text || "", S.settings.target);
  if (!f || f.level !== "no") return null;
  return h("div", { class: "notice warn", style: { marginTop: "8px" } }, h("strong", {}, "Probably not a fit: "), f.reasons[0]);
}

// Can-you-apply box under the job title on the Apply tab.
function eligNotice() {
  const listing = S.jobsByKey.get(S.job.key);
  const read = S.eligPage[S.job.key] !== undefined;
  const v = E.verdict(signalsForJob(listing, S.job.key), S.profile);
  if (v.level === "yes") return read ? h("div", { class: "small", style: { marginTop: "6px", color: "var(--good)" } }, "✓ Can apply: no work-authorization restrictions found on this page" + (listing && S.eligSignals[listing.id] ? " or in Simplify's data" : "")) : null;
  return h(
    "div",
    { class: `notice ${v.level === "no" ? "bad" : "warn"}`, style: { marginTop: "8px" } },
    h("strong", {}, v.level === "no" ? "✕ You can't apply to this one" : "? Check before applying"),
    h("ul", { class: "report-list", style: { margin: "4px 0 0" } }, v.reasons.slice(0, 3).map((r) => h("li", {}, r.text, h("div", { class: "muted small" }, `"${r.evidence}"`))))
  );
}

function currentTailored() {
  return S.job ? S.tailored[S.job.key] : null;
}

// Your profile for the current job: with that job's graduation date if its
// tailored resume shifted it (see grad.js).
function profileForJob() {
  return G.profileWithGrad(S.profile, currentTailored()?.grad);
}

function jobLabel() {
  const t = currentTailored();
  const company = t?.company || S.job?.company || "";
  const role = t?.role || S.job?.title || "";
  return { company, role };
}

// File name for the current job's resume.
function resumeNameForJob() {
  const t = currentTailored();
  const { company, role } = jobLabel();
  return R.fileNameFor(S.settings.fileNamePattern, t?.resume || S.base, S.profile, company, role);
}

// The PDF that gets attached/downloaded for the current job.
async function resumeFileForJob() {
  const t = currentTailored();
  const name = resumeNameForJob();
  if (t) return { name, ...(await buildResumePdf(t.resume, S.settings)), kind: "tailored" };
  if (S.settings.attachWhenUntailored === "original" && S.resumePdf) return { name, base64: S.resumePdf.base64, kind: "original" };
  if (hasContent(S.base)) return { name, ...(await buildResumePdf(S.base, S.settings)), kind: "base" };
  if (S.resumePdf) return { name, base64: S.resumePdf.base64, kind: "original" };
  return null;
}

// This job's cover letter as a file, or null (none written, not tailored
// with it, or turned off in Settings).
async function coverFileForJob() {
  const t = currentTailored();
  if (!t?.cover || S.settings.coverAttach === "off") return null;
  const name = resumeNameForJob().replace(/Resume/i, "Cover_Letter").replace(/^(?!.*Cover_Letter)(.*)\.pdf$/, "$1_Cover_Letter.pdf");
  return { name, ...(await buildCoverPdf(S.base.basics, t.cover, S.settings)) };
}

function base64ToBlobUrl(base64, type = "application/pdf") {
  const bin = atob(base64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return URL.createObjectURL(new Blob([bytes], { type }));
}

async function previewResume(resume) {
  const pdf = await buildResumePdf(resume, S.settings);
  chrome.tabs.create({ url: base64ToBlobUrl(pdf.base64) });
}

async function downloadTex(resume, pdfName) {
  const tex = await texFor(resume);
  const b64 = btoa(unescape(encodeURIComponent(tex)));
  return chrome.downloads.download({ url: `data:text/x-tex;base64,${b64}`, filename: `Resumes/${pdfName.replace(/\.pdf$/, ".tex")}`, conflictAction: "overwrite", saveAs: false });
}

// Opens the .tex as a new Overleaf project (Overleaf's documented /docs endpoint).
async function openInOverleaf(resume) {
  const tex = await texFor(resume);
  const form = h("form", { method: "POST", action: "https://www.overleaf.com/docs", target: "_blank", style: { display: "none" } }, h("input", { type: "hidden", name: "encoded_snip", value: encodeURIComponent(tex) }), h("input", { type: "hidden", name: "snip_name", value: "resume.tex" }), h("input", { type: "hidden", name: "engine", value: "pdflatex" }));
  document.body.append(form);
  form.submit();
  form.remove();
}

// ------------------------------------------------------------- APPLY tab

function renderApply() {
  const el = $("#tab-apply");
  const parts = [];
  const hasKey = aiReady();
  const hasResume = hasContent(S.base) || !!S.resumePdf;

  const guide = setupGuide();
  if (guide) parts.push(guide);

  if (!S.job) {
    parts.push(
      h(
        "div",
        { class: "card" },
        h("h3", {}, "No job page open"),
        h("p", { class: "muted" }, "Open a job posting or application page in this tab, or pick one from the Jobs tab."),
        h("button", { class: "btn primary", onclick: () => switchTab("jobs") }, "Browse jobs")
      )
    );
    el.replaceChildren(...parts);
    return;
  }

  const { company, role } = jobLabel();
  const applied = S.applied[S.job.key];
  let host = "";
  try {
    host = new URL(S.tab.url).hostname;
  } catch {}
  parts.push(
    h(
      "div",
      { class: "card" },
      h("div", { class: "row" }, h("strong", { style: { fontSize: "14px" } }, company || "This page"), h("span", { class: "spacer" }), applied && h("span", { class: "pill good" }, "Applied"), starButton({ ...S.job, company: company || S.job.company, title: role || S.job.title || S.tab.title }, renderApply, true)),
      h("div", {}, role || S.tab.title || ""),
      h("div", { class: "muted small" }, host),
      S.saved[S.job.key]
        ? textarea({ rows: 1, value: S.saved[S.job.key].note, placeholder: "Note for later (e.g. needs a take-home project first)", style: { marginTop: "6px" }, oninput: (e) => ((S.saved[S.job.key].note = e.target.value), saveSaved()) })
        : null,
      eligNotice(),
      fitNotice()
    )
  );

  parts.push(tailorCard(hasKey, hasResume));
  parts.push(fillCard(hasResume));
  parts.push(questionsCard(hasKey));
  parts.push(finishCard(applied));
  el.replaceChildren(...parts);
}

function tailorCard(hasKey) {
  const t = currentTailored();
  const card = h("div", { class: "card" }, h("h3", {}, h("span", { class: "step" }, "1"), "Tailor your resume"));

  if (S.busy.tailor) {
    card.append(h("p", {}, spinner(), " Reading the posting and tailoring your resume… (20–60s)"));
    return card;
  }

  if (S.pending) {
    const p = S.pending;
    const accepted = p.changes.filter((c) => c.accepted).length;
    card.append(
      h("div", { class: "grid2" }, h("label", { class: "field" }, h("span", {}, "Company"), h("input", { type: "text", value: p.company, oninput: (e) => (p.company = e.target.value) })), h("label", { class: "field" }, h("span", {}, "Role"), h("input", { type: "text", value: p.role, oninput: (e) => (p.role = e.target.value) }))),
      p.keywords?.length ? h("div", { class: "small muted" }, "Keywords in this posting") : null,
      h("div", { class: "chips" }, (p.keywords || []).map((k) => h("span", { class: "pill good" }, k))),
      p.missing?.length ? h("div", { class: "small muted", style: { marginTop: "6px" } }, "Not on your resume. Add only if you really have them:") : null,
      h("div", { class: "chips" }, (p.missing || []).map((k) => h("span", { class: "pill warn" }, k))),
      h("div", { class: "small muted", style: { marginTop: "8px" } }, p.changes.length ? `${p.changes.length} suggested changes. Untick any you don't want:` : "Your resume already matches this posting well. No changes suggested."),
      p.gradNote ? h("div", { class: "notice warn", style: { marginTop: "6px" } }, p.gradNote) : null
    );
    for (const c of p.changes) {
      card.append(
        h(
          "div",
          { class: `change${c.accepted ? "" : " off"}` },
          h(
            "label",
            {},
            h("input", {
              type: "checkbox",
              checked: c.accepted,
              onchange: (e) => {
                c.accepted = e.target.checked;
                renderApply();
              },
            }),
            h(
              "div",
              {},
              h("div", { class: "where" }, { bullet: "Bullet", line: "Skills", hide: "Hide bullet", order: "Reorder", summary: "Summary", grad: "Graduation", cover: "Cover letter" }[c.type], " · ", c.where),
              h("div", { class: "before" }, c.before),
              h("div", { class: "after" }, c.after),
              c.reason && h("div", { class: "reason" }, c.reason)
            )
          )
        )
      );
    }
    card.append(
      h(
        "div",
        { class: "row end", style: { marginTop: "10px" } },
        h("button", { class: "btn ghost", onclick: () => ((S.pending = null), renderApply()) }, "Cancel"),
        h("button", { class: "btn primary", onclick: acceptTailoring }, accepted ? `Use ${accepted} change${accepted === 1 ? "" : "s"}` : "Use resume as is")
      ),
      hasKey
        ? feedbackBox({
            key: `tailor:${S.job.key}`,
            button: "Redo with feedback",
            placeholder: "e.g. Don't reword the Princeton bullets; keep my skills order.",
            rerender: renderApply,
            run: (text) => startTailor(text),
          })
        : null
    );
    return card;
  }

  if (t) {
    card.append(
      h("div", { class: "notice good" }, `Tailored for ${t.company || "this job"}${t.role ? ` (${t.role})` : ""}: ${t.changeCount} change${t.changeCount === 1 ? "" : "s"}${t.cover ? ", with a cover letter" : ""}.`),
      t.cover
        ? h(
            "div",
            { class: "row", style: { marginTop: "6px" } },
            h("button", { class: "btn ghost", onclick: () => withBusy("coverPreview", async () => { const f = await coverFileForJob(); if (f) chrome.tabs.create({ url: base64ToBlobUrl(f.base64) }); }) }, "Preview cover letter"),
            h("button", { class: "btn ghost", onclick: () => withBusy("coverDl", async () => { const f = await coverFileForJob(); if (!f) return toast("Cover letters are off in Settings.", true); await downloadBase64(f.base64, f.name); toast(`Saved Downloads/Resumes/${f.name}`); }) }, "Download cover letter")
          )
        : null,
      h(
        "div",
        { class: "row", style: { marginTop: "8px" } },
        h("button", { class: "btn", onclick: previewCurrent }, "Preview"),
        h(
          "button",
          {
            class: "btn",
            onclick: () => {
              S.editing = S.job.key;
              switchTab("resume");
            },
          },
          "Edit"
        ),
        h("button", { class: "btn", onclick: () => startTailor(), disabled: !hasKey }, "Re-tailor"),
        h(
          "button",
          {
            class: "btn ghost danger",
            onclick: () => {
              delete S.tailored[S.job.key];
              saveTailored();
              renderApply();
            },
          },
          "Remove"
        )
      ),
      hasKey
        ? feedbackBox({
            key: `tailor:${S.job.key}`,
            button: "Redo with feedback",
            placeholder: "e.g. Don't reword the Princeton bullets; leave the cover letter's why paragraph as I wrote it.",
            rerender: renderApply,
            run: (text) => startTailor(text),
          })
        : null
    );
    return card;
  }

  card.append(
    h("p", { class: "muted small" }, "AI reads this posting and rewords and reorders your existing bullets and skills to match its keywords. You review every change first, and it never makes up experience."),
    h("button", { class: "btn primary block", onclick: startTailor, disabled: !hasKey || !hasContent(S.base) }, "Tailor my resume to this job"),
    !hasKey ? h("div", { class: "small muted", style: { marginTop: "6px" } }, "Connect AI in Settings to enable tailoring.") : !hasContent(S.base) ? h("div", { class: "small muted", style: { marginTop: "6px" } }, "Upload your resume (Resume tab) first.") : null
  );
  return card;
}

async function startTailor(feedback = "") {
  await withBusy("tailor", async () => {
    const posting = await Page.readJobPosting(S.tab);
    S.posting[S.job.key] = posting;
    let job = { company: S.job.company, title: S.job.title };
    if (!job.company || !job.title) {
      const meta = (await Page.callAll(S.tab, "jobMeta")).find((m) => m.company || m.role) || {};
      job = { company: job.company || meta.company || "", title: job.title || meta.role || "" };
    }
    const prep = await prepareJob({ settings: S.settings, base: S.base, posting, job, profile: S.profile, useAI: aiReady(), cover: S.cover, instructions: S.settings.instructions || "", feedback });
    S.pending = { company: prep.company, role: prep.role, keywords: prep.keywords, missing: prep.missing, changes: prep.changes, grad: prep.grad, gradNote: prep.gradNote, coverTemplate: prep.coverTemplate };
  });
}

function acceptTailoring() {
  const p = S.pending;
  const accepted = p.changes.filter((c) => c.accepted);
  S.tailored[S.job.key] = {
    company: p.company,
    role: p.role,
    url: S.job.url,
    resume: R.applyChanges(S.base, accepted),
    changeCount: accepted.length,
    keywords: p.keywords,
    missing: p.missing,
    grad: gradIfAccepted(p, accepted),
    cover: p.coverTemplate ? C.letterFromChanges(p.coverTemplate, accepted, { company: p.company, role: p.role }) : null,
    createdAt: Date.now(),
  };
  // Keep the 40 most recent tailored versions.
  const keys = Object.keys(S.tailored).sort((a, b) => S.tailored[b].createdAt - S.tailored[a].createdAt);
  for (const k of keys.slice(40)) delete S.tailored[k];
  S.pending = null;
  persist("tailored", S.tailored);
  const { pages } = renderResume(S.tailored[S.job.key].resume);
  toast(pages > 1 ? "Saved, but it runs over one page. Hide a bullet or two in Edit." : "Tailored resume saved for this job.");
  renderApply();
}

function fillCard(hasResume) {
  const card = h("div", { class: "card" }, h("h3", {}, h("span", { class: "step" }, "2"), "Fill the application"));
  const file = hasResume ? { name: resumeNameForJob() } : null;
  card.append(
    h("p", { class: "muted small" }, "Fills in your name, contact details, school, links and standard questions, and attaches ", file ? h("strong", {}, file.name) : "your resume", ". If it gets stuck on a field, AI picks the matching option from your profile; anything that needs your own words is left for you. Already-filled fields are left alone."),
    h("button", { class: "btn primary block", onclick: doAutofill, disabled: S.busy.fill }, S.busy.fill ? [spinner(), " Filling…"] : "Autofill this page")
  );
  const r = S.report;
  if (r) {
    const summary = [];
    summary.push(h("div", { class: `notice ${r.filled.length || r.attached ? "good" : "warn"}`, style: { marginTop: "8px" } }, r.filled.length || r.attached ? `Filled ${r.filled.length} field${r.filled.length === 1 ? "" : "s"}${r.attached ? `, attached ${r.attached}` : ""}.` : r.controls ? "Didn't recognize any fields here. If this is a job description, click Apply on the page first." : "No form fields found on this page. Click the site's Apply button, then try again."));
    if (!r.attached && r.controls) summary.push(h("div", { class: "notice warn", style: { marginTop: "6px" } }, "Couldn't find the resume upload field. Use Download below and upload it yourself."));
    if (r.review.length)
      summary.push(
        h("details", { style: { marginTop: "8px" }, open: true }, h("summary", { class: "small" }, `${r.review.length} need your attention (amber on the page)`), h("ul", { class: "report-list" }, r.review.map((x) => h("li", {}, h("strong", {}, x.label), ": ", x.reason))))
      );
    if (r.filled.length) summary.push(h("details", { style: { marginTop: "6px" } }, h("summary", { class: "small" }, "What was filled (green on the page)"), h("ul", { class: "report-list" }, r.filled.map((x) => h("li", {}, h("strong", {}, x.label), ": ", x.value)))));
    card.append(...summary);
    // Tell AI what's wrong on the page; it changes only those fields.
    const fx = S.fixResult;
    if (fx) {
      card.append(
        h(
          "div",
          { class: `notice ${fx.changed.length ? "good" : "warn"}`, style: { marginTop: "8px" } },
          fx.changed.length ? `Changed ${fx.changed.length} field${fx.changed.length === 1 ? "" : "s"} from your feedback.` : "Nothing changed.",
          fx.changed.length ? h("ul", { class: "report-list" }, fx.changed.map((c) => h("li", {}, h("strong", {}, c.label), `: ${c.from} → ${c.to}`))) : null,
          fx.note ? h("div", { class: "small", style: { marginTop: "4px" } }, fx.note) : null
        )
      );
    }
    card.append(
      h(
        "div",
        { style: { marginTop: "8px" } },
        feedbackBox({
          key: `fill:${S.job.key}`,
          button: "Something's wrong? Tell AI",
          placeholder: "e.g. Start date should be August 2026, and pick Summer 2027 Internship instead of Both.",
          rerender: renderApply,
          run: async (text) => {
            S.fixResult = await fixWithFeedback(
              S.tab,
              { settings: S.settings, profile: profileForJob(), resumeText: resumeToText(currentTailored()?.resume || S.base), posting: S.posting[S.job.key]?.text || "", instructions: S.settings.instructions || "" },
              text
            );
          },
        })
      )
    );
  }
  return card;
}

async function doAutofill() {
  await withBusy("fill", async () => {
    const file = await resumeFileForJob();
    const profile = profileForJob();
    const coverFile = await coverFileForJob().catch(() => null);
    const report = await Page.autofill(S.tab, { profile, resumeFile: file, coverFile, coverOnlyIfRequired: S.settings.coverAttach === "required" });
    // Then one short AI pass for whatever the rules couldn't fill.
    if (aiReady() && report.controls) {
      try {
        const posting = S.posting[S.job?.key]?.text || "";
        const r = await resolveStuck(S.tab, { settings: S.settings, profile, resumeText: resumeToText(currentTailored()?.resume || S.base), posting, instructions: S.settings.instructions || "" });
        const done = new Set([...r.filled, ...r.drafted].map((x) => x.label));
        report.review = report.review.filter((x) => !done.has(x.label));
        report.filled.push(...r.filled.map((x) => ({ ...x, value: `${x.value} (matched by AI)` })), ...r.drafted.map((x) => ({ ...x, value: `${x.value} (AI's pick, purple)` })));
        for (const x of r.skipped) if (!report.review.some((y) => y.label === x.label)) report.review.push(x);
      } catch (e) {
        report.review.push({ label: "AI", reason: `Couldn't finish the stuck fields: ${e.message}` });
      }
    }
    S.report = report;
    S.fixResult = null;
  });
}

function questionsCard(hasKey) {
  const card = h("div", { class: "card" }, h("h3", {}, h("span", { class: "step" }, "3"), "Answer the real questions"));
  card.append(
    h("p", { class: "muted small" }, "AI drafts answers to the remaining questions (\"Why this company?\", dropdowns, and so on) from your resume and this posting. Drafts show up purple on the page. Read and edit them before you submit."),
    h("button", { class: "btn block", onclick: doDraftAnswers, disabled: !hasKey || S.busy.answers }, S.busy.answers ? [spinner(), " Drafting answers…"] : "Draft answers to open questions")
  );
  if (S.answers) {
    const list = S.answers.filter((a) => a.answer);
    card.append(h("div", { class: "small muted", style: { marginTop: "8px" } }, `${list.length} of ${S.answers.length} questions drafted. Copy any that didn't paste in:`));
    for (const a of S.answers) {
      card.append(
        h(
          "div",
          { class: "change" },
          h("div", { class: "where" }, a.question, " ", h("span", { class: "pill" }, { rule: "profile", saved: "saved", ai: "AI draft", none: "needs you" }[a.source] || "")),
          h("div", { class: "after" }, a.answer || h("span", { class: "muted" }, "(left for you: not enough info to answer truthfully)")),
          a.answer &&
            h(
              "div",
              { class: "row end" },
              h(
                "button",
                {
                  class: "btn ghost small",
                  onclick: async () => {
                    await navigator.clipboard.writeText(a.answer);
                    toast("Copied");
                  },
                },
                "Copy"
              ),
              a.source === "ai" &&
                !Ans.isCompanySpecific(a.question, jobLabel().company) &&
                h(
                  "button",
                  {
                    class: "btn ghost small",
                    title: "Reuse this answer (no AI) when another application asks the same question",
                    onclick: async (e) => {
                      const saved = await store.get("savedAnswers", {});
                      saved[Ans.savedKey(a.question)] = a.answer;
                      await persist("savedAnswers", saved);
                      e.target.textContent = "Saved ✓";
                    },
                  },
                  "Save for next time"
                )
            )
        )
      );
    }
  }
  return card;
}

async function doDraftAnswers() {
  await withBusy("answers", async () => {
    const questions = await Page.collectQuestions(S.tab);
    if (!questions.length) {
      S.answers = [];
      toast("No unanswered questions found on this page.");
      return;
    }
    const saved = await store.get("savedAnswers", {});
    const results = [];
    const pending = [];
    for (const q of questions) {
      const det = Ans.answerDeterministically(q, profileForJob(), saved);
      if (det) results.push({ ...q, answer: det.answer, source: det.source });
      else pending.push(q);
    }
    if (pending.length && aiReady()) {
      let posting = S.posting[S.job.key];
      if (!posting) posting = await Page.readJobPosting(S.tab).catch(() => ({ text: "" }));
      const t = currentTailored();
      const out = await AI.rewriteAndAnswer(S.settings, {
        bullets: [],
        keywords: [],
        posting: K.trimPosting(posting.text),
        questions: pending,
        resumeText: resumeToText(t?.resume || S.base),
        profile: profileForJob(),
        company: jobLabel().company,
        role: jobLabel().role,
        bank: S.bank.filter((b) => b.text.trim()),
      });
      const byId = Object.fromEntries((out.answers || []).map((a) => [a.qid, a.answer]));
      const bankById = Object.fromEntries(S.bank.map((b) => [b.id, b]));
      const banked = Object.fromEntries((out.bank_matches || []).filter((m) => bankById[m.bank_id]?.text.trim()).map((m) => [m.qid, C.fillVars(bankById[m.bank_id].text, jobLabel())]));
      for (const q of pending) {
        if (banked[q.qid] && /text/.test(q.kind)) {
          results.push({ ...q, answer: banked[q.qid], source: "bank", mark: "filled", note: "your answer from Settings → Your answers" });
          continue;
        }
        let ans = (byId[q.qid] || "").trim();
        if (q.options?.length) ans = Ans.matchOption(q.options, ans) || "";
        results.push({ ...q, answer: ans, source: ans ? "ai" : "none" });
      }
    } else for (const q of pending) results.push({ ...q, answer: "", source: "none" });
    S.answers = results;
    const n = await Page.fillAnswers(S.tab, results.filter((a) => a.answer));
    const fromRules = results.filter((a) => a.answer && a.source !== "ai").length;
    toast(`Filled ${n} answer${n === 1 ? "" : "s"} (${fromRules} from your profile, saved answers or Your answers). Review AI drafts (purple) before submitting.`);
  });
}

function finishCard(applied) {
  return h(
    "div",
    { class: "card" },
    h("h3", {}, h("span", { class: "step" }, "4"), "Submit"),
    h("p", { class: "muted small" }, "Look over the page, click the site's Submit button, then mark it applied here."),
    h(
      "div",
      { class: "row" },
      h("button", { class: "btn", onclick: downloadCurrent }, "Download PDF"),
      h("span", { class: "spacer" }),
      h(
        "button",
        {
          class: `btn ${applied ? "" : "primary"}`,
          onclick: () => {
            if (applied) delete S.applied[S.job.key];
            else S.applied[S.job.key] = { company: jobLabel().company, title: jobLabel().role, url: S.job.url, date: Date.now() };
            persist("applied", S.applied);
            renderApply();
          },
        },
        applied ? "Applied ✓ (undo)" : "Mark as applied"
      )
    )
  );
}

async function previewCurrent() {
  const t = currentTailored();
  const src = t?.resume || S.base;
  if (!hasContent(src)) return toast("Upload your resume first.", true);
  await previewResume(src);
}

async function downloadCurrent() {
  try {
    const f = await resumeFileForJob();
    if (!f) return toast("Upload your resume first.", true);
    await downloadBase64(f.base64, f.name);
    toast(`Saved Downloads/Resumes/${f.name}`);
  } catch (e) {
    toast(e.message, true);
  }
}

// -------------------------------------------------------------- JOBS tab

const CATEGORIES = ["Software", "AI/ML/Data", "Quant", "Product", "Hardware"];

// Job keys are computed once per list load (URL parsing 5k items per keystroke is slow).
function withKeys(cache) {
  for (const j of cache.items) if (!j.key) j.key = Jobs.jobKeyForUrl(j.url);
  S.jobsByKey = new Map(cache.items.map((j) => [j.key, j]));
  return cache;
}

// Best fits first (then newest), so Autopilot also starts with them.
function filteredJobs() {
  const terms = S.jobsQuery.toLowerCase().trim().split(/\s+/).filter(Boolean);
  const f = S.settings.filters;
  const target = S.settings.target;
  const list = S.jobsCache.items.filter((j) => {
    if (S.hideApplied && S.applied[j.key]) return false;
    if (!Sources.matchesFilters(j, f, S.profile, S.eligSignals, target)) return false;
    if (!terms.length) return true;
    const hay = `${j.company} ${j.title} ${j.locations.join(" ")}`.toLowerCase();
    return terms.every((t) => hay.includes(t));
  });
  if (!target.categories?.length) return list;
  const rank = new Map(list.map((j) => [j, Fit.FIT_RANK[Fit.fitOf(j, target).level]]));
  return list.sort((a, b) => rank.get(a) - rank.get(b) || b.posted - a.posted);
}

function renderJobs() {
  const el = $("#tab-jobs");
  const cache = S.jobsCache;
  if (S.jobsLoaded && !cache.items.length && !S.busy.jobs && !S.jobsTried) {
    S.jobsTried = true;
    refreshJobList();
  }
  const listWrap = h("div", { class: "joblist-wrap" });
  const countEl = h("span", {});
  const update = () => {
    S.jobsShown = 50;
    const list = filteredJobs();
    countEl.textContent = `${list.length} match`;
    renderJobList(listWrap, list);
  };

  const search = h("input", {
    type: "search",
    placeholder: "Search company, role, location…",
    value: S.jobsQuery,
    oninput: debounce((e) => {
      S.jobsQuery = e.target.value;
      update();
    }, 150),
  });

  const f = S.settings.filters;
  const setF = (k, v) => {
    f[k] = v;
    saveSettings();
    update();
  };
  const filterInput = (k, label, ph) => h("label", { class: "field" }, h("span", {}, label), h("input", { type: "text", value: f[k] || "", placeholder: ph, oninput: debounce((e) => setF(k, e.target.value), 250) }));
  const filters = h(
    "details",
    { class: "small", style: { marginTop: "8px" }, open: S.filtersOpen },
    h("summary", { onclick: () => (S.filtersOpen = !S.filtersOpen) }, "Filters · ", countEl),
    h(
      "div",
      { style: { marginTop: "8px" } },
      filterInput("include", "Role must include one of", "software, data, machine learning"),
      filterInput("exclude", "Skip if it mentions", "phd, senior, master"),
      filterInput("locations", "Locations (any of)", "NY, remote, CA"),
      h(
        "div",
        { class: "chips", style: { marginBottom: "8px" } },
        CATEGORIES.map((c) =>
          h(
            "button",
            {
              class: `pill${f.categories.includes(c) ? " good" : ""}`,
              style: { cursor: "pointer" },
              onclick: () => {
                setF("categories", f.categories.includes(c) ? f.categories.filter((x) => x !== c) : [...f.categories, c]);
                renderJobs();
              },
            },
            c
          )
        )
      ),
      h(
        "div",
        { class: "row" },
        h("select", { style: { width: "auto" }, onchange: (e) => setF("maxAgeDays", Number(e.target.value)) }, [7, 14, 30, 90, 0].map((d) => h("option", { value: d, selected: f.maxAgeDays === d }, d ? `Posted in last ${d} days` : "Any age"))),
        h("label", { class: "row" }, h("input", { type: "checkbox", checked: f.hideIneligible ?? f.respectSponsorship, onchange: (e) => setF("hideIneligible", e.target.checked) }), "Hide jobs I can't apply to (from my U.S. work status)"),
        h("label", { class: "row" }, h("input", { type: "checkbox", checked: f.fitOnly ?? true, onchange: (e) => setF("fitOnly", e.target.checked) }), "Only jobs that fit my resume (Settings → What jobs to look for)")
      )
    )
  );

  const appliedCount = Object.keys(S.applied).length;
  const savedCount = Object.keys(S.saved).length;
  const viewSwitch = h(
    "div",
    { class: "row", style: { marginBottom: "8px" } },
    h("button", { class: `btn small${S.showSaved ? " ghost" : " primary"}`, onclick: () => ((S.showSaved = false), renderJobs()) }, "All jobs"),
    h("button", { class: `btn small${S.showSaved ? " primary" : " ghost"}`, onclick: () => ((S.showSaved = true), renderJobs()) }, `★ Saved (${savedCount})`)
  );
  if (S.showSaved) {
    el.replaceChildren(...[setupGuide(), viewSwitch, savedList()].filter(Boolean));
    return;
  }
  el.replaceChildren(
    ...[setupGuide()].filter(Boolean),
    viewSwitch,
    autopilotCard(),
    h(
      "div",
      { class: "card" },
      search,
      filters,
      h(
        "div",
        { class: "row", style: { marginTop: "8px" } },
        h("label", { class: "row small" }, h("input", { type: "checkbox", checked: S.hideApplied, onchange: (e) => ((S.hideApplied = e.target.checked), update()) }), "Hide applied"),
        h("span", { class: "spacer" }),
        h("span", { class: "small muted" }, cache.fetchedAt ? `${cache.items.length} jobs from ${S.settings.sources.filter((s) => s.enabled).length} repos · ${timeAgo(cache.fetchedAt)} · ${appliedCount} applied` : S.busy.jobs ? "Loading jobs…" : ""),
        h("button", { class: "btn ghost", onclick: refreshJobList, disabled: S.busy.jobs, title: "Refresh from GitHub" }, S.busy.jobs ? spinner() : "↻")
      ),
      cache.errors?.length ? h("div", { class: "notice warn small", style: { marginTop: "6px" } }, `Some sources failed: ${cache.errors.join("; ")}`) : null
    ),
    listWrap
  );
  update();
}

// ------------------------------------------------------- onboarding

// The setup steps, each with what to do, where, and whether it's done.
function setupSteps() {
  const p = S.profile;
  const tg = S.settings.target;
  return [
    {
      id: "ai",
      title: "Connect AI",
      what: "Settings → Connect AI: pick your Claude or ChatGPT subscription (no API key needed), or paste an Anthropic or OpenAI API key, then Save & test.",
      done: S.settings.aiVerified || (S.settings.provider !== "claude-code" && aiReady()),
      go: ["settings", "card-ai"],
    },
    {
      id: "resume",
      title: "Upload your resume",
      what: "Resume tab → drop in your resume as a PDF. Claude turns it into editable boxes and keeps your layout.",
      done: !!S.resumePdf || hasContent(S.base),
      go: ["resume", "card-upload"],
    },
    {
      id: "profile",
      title: "Check your profile",
      what: "Settings → Application profile: your contact info, school and graduation date, and your U.S. work status (it decides which jobs you can apply to).",
      done: !!(p.email && p.firstName && p.gradYear && p.workStatus),
      go: ["settings", "card-profile"],
    },
    {
      id: "target",
      title: "Confirm what jobs to look for",
      what: "Settings → What jobs to look for: Claude reads your resume and picks the fields and degree level. Fix anything it got wrong.",
      done: !!tg?.builtAt && !!S.settings.onboarding?.targetSeen,
      go: ["settings", "card-target"],
      onGo: () => {
        S.settings.onboarding = { ...(S.settings.onboarding || {}), targetSeen: true };
        saveSettings();
      },
    },
    {
      id: "answers",
      title: "Write your answers (optional)",
      what: "Settings → Your answers: answer common questions (\"Why this company?\") once in your own words, so Autopilot can submit them. Resume → Cover letter works the same way.",
      done: S.bank.some((b) => b.text.trim()) || C.coverReady(S.cover) || !!S.settings.onboarding?.answersSkipped,
      go: ["settings", "card-bank"],
      skip: () => {
        S.settings.onboarding = { ...(S.settings.onboarding || {}), answersSkipped: true };
        saveSettings();
      },
    },
    {
      id: "apply",
      title: "Apply to your first job",
      what: "Jobs tab: open a ★ Good fit job and use the Apply tab (Tailor → Autofill), or start Autopilot on a batch.",
      done: Object.keys(S.applied).length > 0 || Object.keys(S.tailored).length > 0 || S.queue.length > 0,
      go: ["jobs", null],
    },
  ];
}

// Switch tabs and briefly highlight the card a step points to.
function goToStep(step) {
  step.onGo?.();
  const [tab, cardId] = step.go;
  switchTab(tab);
  if (!cardId) return;
  queueMicrotask(() => {
    const el = document.getElementById(cardId);
    if (!el) return;
    if (el.tagName === "DETAILS") el.open = true;
    el.scrollIntoView({ behavior: "smooth", block: "start" });
    el.classList.remove("spotlight");
    void el.offsetWidth;
    el.classList.add("spotlight");
  });
}

// Shown at the top of every tab until setup is done or you hide it.
function setupGuide() {
  if (S.settings.onboarding?.hidden) return null;
  const steps = setupSteps();
  const done = steps.filter((x) => x.done).length;
  if (done === steps.length) return null;
  const next = steps.find((x) => !x.done);
  const fresh = done === 0;
  return h(
    "details",
    { class: "card setup", open: S.setupOpen ?? true, ontoggle: (e) => (S.setupOpen = e.target.open) },
    h("summary", {}, h("strong", {}, fresh ? "Welcome to JobPilot" : "Finish setting up"), h("span", { class: "small muted" }, ` · ${done} of ${steps.length} done`)),
    fresh ? h("p", { class: "small muted", style: { margin: "6px 0" } }, "A few minutes of setup, then JobPilot finds jobs that fit your resume, tailors it per job, and fills applications. Start with step 1.") : null,
    h(
      "ol",
      { class: "setup-steps" },
      steps.map((x) =>
        h(
          "li",
          { class: x.done ? "done" : x === next ? "next" : "" },
          h("div", { class: "row" }, h("span", { class: "step-check" }, x.done ? "✓" : ""), h("strong", { class: "small" }, x.title), h("span", { class: "spacer" }), !x.done && x.skip ? h("button", { class: "btn ghost small", onclick: () => (x.skip(), invalidate()) }, "Skip") : null, !x.done ? h("button", { class: `btn small${x === next ? " primary" : " ghost"}`, onclick: () => goToStep(x) }, "Go") : null),
          x === next ? h("div", { class: "small muted", style: { margin: "2px 0 0 26px" } }, x.what) : null
        )
      )
    ),
    h("div", { class: "row end" }, h("button", { class: "btn ghost small", onclick: () => ((S.settings.onboarding = { ...(S.settings.onboarding || {}), hidden: true }), saveSettings(), invalidate()) }, "Hide this guide"))
  );
}

// --------------------------------------------- what jobs to look for

// One AI call: your resume -> the kinds of roles that fit (fit.js).
async function buildTargetFromResume({ quiet = false } = {}) {
  if (!aiReady() || !hasContent(S.base)) return;
  const t = await AI.buildTarget(S.settings, { resumeText: resumeToText(S.base), profile: S.profile });
  S.settings.target = { ...Fit.DEFAULT_TARGET, ...t, builtAt: Date.now() };
  await persist("settings", S.settings);
  if (!quiet) toast("Updated what jobs to look for from your resume.");
  if (S.activeTab === "jobs") renderJobs();
  if (S.activeTab === "settings") renderSettings();
}

// ------------------------------------------------------- saved jobs

const saveSaved = debounce(() => persist("saved", S.saved), 300);

function toggleSaved(job) {
  if (S.saved[job.key]) delete S.saved[job.key];
  else S.saved[job.key] = { key: job.key, company: job.company || "", title: job.title || "", url: job.url, locations: job.locations || [], note: "", savedAt: Date.now() };
  saveSaved();
}

// ☆ / ★ toggle. rerender() redraws whatever it's on.
function starButton(job, rerender, withLabel = false) {
  const on = !!S.saved[job.key];
  return h(
    "button",
    {
      class: `btn ghost small${on ? " starred" : ""}`,
      title: on ? "Saved for later (click to unsave)" : "Save for later",
      onclick: (e) => {
        e.stopPropagation();
        toggleSaved(job);
        toast(S.saved[job.key] ? "Saved for later (Jobs → Saved)" : "Removed from saved");
        rerender();
      },
    },
    on ? "★" : "☆",
    withLabel ? (on ? " Saved" : " Save for later") : null
  );
}

// Jobs tab → Saved: everything you've set aside, with your notes.
function savedList() {
  const items = Object.values(S.saved).sort((a, b) => b.savedAt - a.savedAt);
  if (!items.length) return h("p", { class: "muted" }, "Nothing saved yet. Click ☆ on a job (or Save for later on the Apply tab) to keep it here, e.g. ones with a project to do first.");
  return h(
    "div",
    { class: "stack" },
    items.map((j) =>
      h(
        "div",
        { class: "card" },
        h(
          "div",
          { class: "row" },
          h("strong", {}, j.company || "Saved job"),
          h("span", { class: "spacer" }),
          S.applied[j.key] ? h("span", { class: "pill good" }, "Applied") : null,
          h("span", { class: "small muted" }, `saved ${timeAgo(j.savedAt)}`)
        ),
        h("div", {}, j.title || j.url),
        j.locations?.length ? h("div", { class: "small muted" }, j.locations.join(" · ")) : null,
        textarea({ rows: 1, value: j.note, placeholder: "Note (e.g. take-home project due Friday, ask about referral)", style: { marginTop: "6px" }, oninput: (e) => ((j.note = e.target.value), saveSaved()) }),
        h(
          "div",
          { class: "row", style: { marginTop: "6px" } },
          h("button", { class: "btn small", onclick: () => openJob(j) }, "Open"),
          !S.applied[j.key] &&
            h(
              "button",
              {
                class: "btn ghost small",
                onclick: () => {
                  S.applied[j.key] = { company: j.company, title: j.title, url: j.url, date: Date.now() };
                  persist("applied", S.applied);
                  renderJobs();
                },
              },
              "I applied"
            ),
          h("button", { class: "btn ghost small", onclick: () => (toggleSaved(j), renderJobs()) }, "Unsave")
        )
      )
    )
  );
}

// ---------------------------------------------------- can you apply?

const ELIG_TTL = 7 * 86400000;
const saveElig = debounce(() => persist("eligCache", S.eligStore), 1500);
const rerenderJobsSoon = debounce(() => S.activeTab === "jobs" && renderJobs(), 600);
const eligQueue = [];
const eligQueued = new Set();
let eligRunning = 0;

// Fetch Simplify's job data (sponsorship, requirements) for these jobs, a
// few at a time, and re-render as verdicts come in.
function enrichEligibility(jobs) {
  for (const j of jobs) {
    if (!E.hasSimplifyPage(j) || S.eligSignals[j.id] || eligQueued.has(j.id)) continue;
    eligQueued.add(j.id);
    eligQueue.push(j);
  }
  pumpEligibility();
}

function pumpEligibility() {
  while (eligRunning < 3 && eligQueue.length) {
    const j = eligQueue.shift();
    eligRunning++;
    E.fetchSimplify(j.simplifyId)
      .then((signals) => {
        S.eligSignals[j.id] = signals;
        S.eligStore[j.id] = { signals, at: Date.now() };
        saveElig();
        rerenderJobsSoon();
        if (S.job?.listingId === j.id && S.activeTab === "apply") renderApply();
      })
      .catch(() => {})
      .finally(() => {
        eligRunning--;
        setTimeout(pumpEligibility, 250);
      });
  }
}

function eligPill(v, checked) {
  const tip = v.reasons.map((r) => `${r.text}\n  "${r.evidence}"`).join("\n") || "No work-authorization restrictions found";
  if (v.level === "no") return h("span", { class: "pill bad", title: tip }, "✕ Can't apply");
  if (v.level === "maybe") return h("span", { class: "pill warn", title: tip }, "? Check");
  return checked ? h("span", { class: "pill good", title: tip }, "✓ Can apply") : null;
}

// Listing flags + Simplify data (+ the posting, when it's the open page).
function signalsForJob(listing, jobKey) {
  return [...(listing ? E.signalsFromListing(listing) : []), ...((listing && S.eligSignals[listing.id]) || []), ...((jobKey && S.eligPage[jobKey]) || [])];
}

function renderJobList(wrap, filtered) {
  enrichEligibility(filtered.slice(0, S.jobsShown));
  const rows = filtered.slice(0, S.jobsShown).map((j) => {
    const applied = !!S.applied[j.key];
    const tailored = !!S.tailored[j.key];
    const sig = signalsForJob(j);
    const elig = eligPill(E.verdict(sig, S.profile), sig.length > 0 || S.eligSignals[j.id] !== undefined);
    const fit = Fit.fitOf(j, S.settings.target);
    const fitPill = Fit.FIT_LABEL[fit.level] ? h("span", { class: `pill ${fit.level === "good" ? "good" : fit.level === "no" ? "bad" : "warn"}`, title: fit.reasons.join("\n") || "Matches what you're looking for" }, Fit.FIT_LABEL[fit.level]) : null;
    return h(
      "div",
      { class: `job${applied ? " applied" : ""}`, onclick: () => openJob(j), title: `${j.url}\n${(j.sources || []).join(", ")}` },
      starButton(j, () => renderJobList(wrap, filtered)),
      h("div", { class: "meta" }, h("div", { class: "company" }, j.company), h("div", { class: "title" }, j.title), h("div", { class: "loc" }, j.locations.join(" · "))),
      h("div", { style: { textAlign: "right" } }, h("div", { class: "small muted" }, Jobs.ageLabel(j.posted)), applied ? h("span", { class: "pill good" }, "Applied") : tailored ? h("span", { class: "pill" }, "Tailored") : [elig, fitPill])
    );
  });
  const more =
    filtered.length > S.jobsShown
      ? h(
          "button",
          {
            class: "btn block",
            style: { marginTop: "8px" },
            onclick: () => {
              S.jobsShown += 50;
              renderJobList(wrap, filtered);
            },
          },
          `Show more (${filtered.length - S.jobsShown} left)`
        )
      : null;
  wrap.replaceChildren(rows.length ? h("div", { class: "joblist" }, rows) : h("p", { class: "muted" }, S.jobsCache.items.length ? "No jobs match." : ""), more);
}

function timeAgo(ms) {
  const m = Math.floor((Date.now() - ms) / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const hrs = Math.floor(m / 60);
  return hrs < 24 ? `${hrs}h ago` : `${Math.floor(hrs / 24)}d ago`;
}

async function refreshJobList() {
  await withBusy(
    "jobs",
    async () => {
      S.jobsCache = withKeys(await Jobs.refreshJobs(S.settings.sources));
    },
    () => S.activeTab === "jobs" && renderJobs()
  );
}

// ------------------------------------------------------------- AUTOPILOT

const STATUS_PILL = { queued: "", running: "", applied: "good", review: "info", "needs-you": "warn", manual: "", failed: "bad", ineligible: "bad", notfit: "", stale: "" };
const STATUS_LABEL = { queued: "Queued", running: "Working", applied: "Applied", review: "Review & submit", "needs-you": "Needs you", manual: "Apply manually", failed: "Failed", ineligible: "Not eligible", notfit: "Not a fit", stale: "Too old" };
// Saved right away: debounce timers get throttled while the run tab is hidden.
const saveQueue = () => persist("autopilotQueue", S.queue);

function autopilotCard() {
  const ap = S.settings.autopilot;
  const counts = S.queue.reduce((m, i) => ((m[i.status] = (m[i.status] || 0) + 1), m), {});
  const card = h(
    "div",
    { class: "card" },
    h("h3", {}, "Autopilot", h("span", { class: "spacer" }), S.autopilotRunning ? h("span", { class: "pill info" }, spinner(), " running") : null),
    h(
      "p",
      { class: "small muted" },
      `Prepares ${ap.concurrency} applications at a time in background tabs: tailored resume, filled form, answers. `,
      ap.autoSubmit ? "Submits when every answer came from your profile or your own saved answers. AI only fills forms (options, formats, matching your answers); it never writes answers here, so questions that need your words wait for you." : "Auto-submit is off: every application waits for you to submit."
    )
  );

  if (!S.autopilotRunning) {
    const batch = h("select", { style: { width: "auto" } }, [5, 10, 20, 40].map((n) => h("option", { value: n, selected: n === (S.batchSize || 10) }, `next ${n}`)));
    batch.onchange = (e) => (S.batchSize = Number(e.target.value));
    card.append(
      h(
        "div",
        { class: "row" },
        h("button", { class: "btn primary", onclick: () => startAutopilot(S.batchSize || 10), disabled: !hasContent(S.base) || !aiReady() }, "Start Autopilot"),
        h("span", { class: "small" }, "on the"),
        batch,
        h("span", { class: "small" }, "matching jobs")
      ),
      !hasContent(S.base) ? h("div", { class: "small muted", style: { marginTop: "6px" } }, "Upload your resume first.") : null
    );
  } else {
    card.append(h("button", { class: "btn", onclick: () => ((S.stopAutopilot = true), toast("Stopping after the current jobs…")) }, "Stop"));
  }
  // Running in the pinned JobPilot tab: this panel only shows progress.
  if (!S.autopilotRunning && S.queue.some((i) => i.status === "running")) {
    card.append(
      h(
        "div",
        { class: "row", style: { marginTop: "6px" } },
        h("span", { class: "pill info" }, spinner(), " running in the JobPilot tab"),
        h("button", { class: "btn ghost small", onclick: () => (persist("autopilotStop", true), toast("Stopping after the current jobs…")) }, "Stop")
      )
    );
  }

  if (S.queue.length) {
    card.append(
      h(
        "div",
        { class: "row small", style: { margin: "8px 0 4px" } },
        Object.entries(counts).map(([k, n]) => h("span", { class: `pill ${STATUS_PILL[k] || ""}` }, `${STATUS_LABEL[k]} ${n}`)),
        h("span", { class: "spacer" }),
        S.queue.some((i) => BULK_RETRY.includes(i.status)) && h("button", { class: "btn ghost small", disabled: runningElsewhere(), onclick: () => tryAgain(S.queue.filter((i) => BULK_RETRY.includes(i.status))) }, "Try all again"),
        !S.autopilotRunning && h("button", { class: "btn ghost small", onclick: () => ((S.queue = S.queue.filter((i) => !["applied", "manual", "failed", "ineligible", "notfit", "stale"].includes(i.status))), saveQueue(), renderJobs()) }, "Clear finished")
      )
    );
    const order = { running: 0, review: 1, "needs-you": 2, queued: 3, failed: 4, manual: 5, ineligible: 6, notfit: 7, stale: 8, applied: 9 };
    for (const it of [...S.queue].sort((a, b) => order[a.status] - order[b.status])) card.append(queueRow(it));
  }
  return card;
}

// Every finished job except submitted ones (retrying those would apply twice).
const RETRYABLE = ["failed", "needs-you", "ineligible", "manual", "review", "notfit", "stale"];
// "Try all again" leaves filled tabs that are waiting for your review alone.
const BULK_RETRY = ["failed", "needs-you", "ineligible", "manual"];
const runningElsewhere = () => !S.autopilotRunning && S.queue.some((i) => i.status === "running");

// Put jobs back in the queue and run them now (no new jobs are added).
async function tryAgain(items) {
  if (runningElsewhere()) return toast("Autopilot is running in its JobPilot tab. Try again when it finishes.", true);
  for (const it of items) {
    if (it.tabId) chrome.tabs.remove(it.tabId).catch(() => {});
    // "Apply manually" sites get attempted this time instead of skipped.
    // "Apply manually" sites get attempted this time; "Not a fit" means you disagreed.
    Object.assign(it, { status: "queued", note: "", tabId: null, finishedAt: null, force: it.force || ["manual", "notfit", "stale"].includes(it.status) });
    // Move to the end so a run already in progress here picks it up.
    S.queue = S.queue.filter((x) => x !== it);
    S.queue.push(it);
  }
  await persist("autopilotQueue", S.queue); // saved before a run tab loads it
  renderJobs();
  if (!S.autopilotRunning) await startAutopilot(0);
}

const timeOnStep = (at) => {
  const s = Math.max(0, Math.round((Date.now() - at) / 1000));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
};
// Keep "time on this step" ticking (just the text, so typing isn't interrupted).
setInterval(() => {
  for (const el of document.querySelectorAll(".elapsed[data-at]")) el.textContent = ` · ${timeOnStep(Number(el.dataset.at))}`;
}, 5000);

function queueRow(it) {
  const open = async () => {
    if (it.tabId) {
      try {
        const t = await chrome.tabs.update(it.tabId, { active: true });
        await chrome.windows.update(t.windowId, { focused: true });
        return;
      } catch {}
    }
    const t = await chrome.tabs.create({ url: it.job.url });
    await store.setTabJob(t.id, it.job);
  };
  const markApplied = () => {
    it.status = "applied";
    it.note = "Marked applied by you";
    S.applied[it.job.key] = { company: it.job.company, title: it.job.title, url: it.job.url, date: Date.now() };
    persist("applied", S.applied);
    saveQueue();
    renderJobs();
  };
  return h(
    "div",
    { class: "change", style: { padding: "6px 8px" } },
    h(
      "div",
      { class: "row" },
      h("strong", { class: "small" }, it.job.company),
      h("span", { class: "small muted", style: { flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } }, it.job.title),
      h("span", { class: `pill ${STATUS_PILL[it.status] || ""}` }, it.status === "running" ? [spinner(), " "] : null, STATUS_LABEL[it.status])
    ),
    it.note ? h("div", { class: "small muted", style: { marginTop: "2px" } }, it.note, it.status === "running" && it.stepAt ? h("span", { class: "elapsed", "data-at": it.stepAt }, ` · ${timeOnStep(it.stepAt)}`) : null) : null,
    ["review", "needs-you", "manual", "failed", "ineligible", "notfit", "stale"].includes(it.status)
      ? h(
          "div",
          { class: "row", style: { marginTop: "4px" } },
          RETRYABLE.includes(it.status) &&
            h(
              "button",
              {
                class: "btn small",
                disabled: runningElsewhere(),
                onclick: () => {
                  if (it.status === "review" && !confirm("Close the filled-in tab and start this application over?")) return;
                  tryAgain([it]);
                },
              },
              it.feedback ? "Try again (with your feedback)" : "Try again"
            ),
          h("button", { class: "btn ghost small", onclick: open }, it.tabId ? "Go to tab" : "Open"),
          !["failed", "ineligible"].includes(it.status) && h("button", { class: "btn ghost small", onclick: markApplied }, "I submitted it"),
          starButton(it.job, renderJobs, true),
          h(
            "button",
            {
              class: "btn ghost small",
              onclick: () => {
                if (it.tabId && it.status !== "review") chrome.tabs.remove(it.tabId).catch(() => {});
                S.queue = S.queue.filter((x) => x !== it);
                saveQueue();
                renderJobs();
              },
            },
            "Remove"
          )
        )
      : null,
    queueFeedback(it)
  );
}

// Feedback on an Autopilot job: fix its open tab now, or re-run it with
// your note (AI also applies the note after filling).
function queueFeedback(it) {
  const hasTab = it.tabId && ["review", "needs-you"].includes(it.status);
  if (!hasTab && !["failed", "needs-you", "manual"].includes(it.status)) return null;
  return feedbackBox({
    key: `q:${it.id}`,
    button: hasTab ? "Fix with feedback" : "Try again with feedback",
    placeholder: hasTab ? "What's wrong on that page? e.g. Graduation should be May 2029." : "What should it do differently? e.g. Pick Summer Internship; my start date is August 2026.",
    rerender: renderJobs,
    run: async (text) => {
      it.feedback = [it.feedback, text].filter(Boolean).join(" ");
      if (hasTab) {
        const tab = await chrome.tabs.get(it.tabId);
        const r = await fixWithFeedback(tab, { settings: S.settings, profile: S.profile, resumeText: resumeToText(S.tailored[it.job.key]?.resume || S.base), instructions: S.settings.instructions || "" }, text);
        it.note = r.changed.length ? `Changed ${r.changed.map((c) => `${c.label}: ${c.to}`).join("; ").slice(0, 200)}${r.note ? `. ${r.note}` : ""}` : `Nothing changed. ${r.note}`;
        saveQueue();
      } else await tryAgain([it]);
    },
  });
}

// Inside the side panel: hand the run to a pinned JobPilot tab (setting), so
// closing the panel doesn't stop it. The panel follows along via storage.
const RUN_PARAM = new URLSearchParams(location.search).get("run");

async function startAutopilot(n) {
  if (S.settings.autopilot.ownTab && !RUN_PARAM) {
    const url = chrome.runtime.getURL(`sidepanel/index.html?run=${n}`);
    const [open] = await chrome.tabs.query({ url: chrome.runtime.getURL("sidepanel/index.html*") });
    if (open && runningElsewhere()) return toast("Autopilot is already running in its JobPilot tab.");
    // Reuse a finished run's tab, or open one.
    if (open) await chrome.tabs.update(open.id, { url });
    else await chrome.tabs.create({ url, pinned: true, active: false });
    return toast("Autopilot started in a pinned JobPilot tab. You can close this panel.");
  }
  const inQueue = new Set(S.queue.map((i) => i.job.key));
  const picks = filteredJobs()
    .filter((j) => !S.applied[j.key] && !inQueue.has(j.key) && !S.saved[j.key]) // saved = you'll do it yourself
    .filter((j) => !(S.settings.autopilot.maxAgeDays ?? 7) || Autopilot.isFresh(j.posted, S.settings.autopilot.maxAgeDays ?? 7))
    .slice(0, n)
    .map((j) => ({ id: j.key, job: jobFromListing(j), status: "queued", note: "" }));
  S.queue.push(...picks);
  if (!S.queue.some((i) => i.status === "queued")) return toast(n ? "No new matching jobs to queue." : "Nothing to run.");
  S.autopilotRunning = true;
  S.stopAutopilot = false;
  saveQueue();
  renderJobs();
  const savedAnswers = await store.get("savedAnswers", {});
  const ctx = {
    settings: S.settings,
    profile: S.profile,
    base: S.base,
    savedAnswers,
    tailoredFor: (job) => S.tailored[job.key],
    saveTailored: async (job, entry) => {
      S.tailored[job.key] = entry;
      await persist("tailored", S.tailored);
    },
    resumeFileFor: async (job, t) => {
      const name = R.fileNameFor(S.settings.fileNamePattern, t?.resume || S.base, S.profile, t?.company || job.company, t?.role || job.title);
      const pdf = await buildResumePdf(t?.resume || S.base, S.settings);
      return { name, base64: pdf.base64 };
    },
    // Autopilot letters are only your own paragraphs (no AI sentence).
    cover: S.cover,
    bank: S.bank,
    coverFileFor: async (job, t) => {
      if (!t?.cover || S.settings.coverAttach === "off") return null;
      const name = R.fileNameFor(S.settings.fileNamePattern, t.resume || S.base, S.profile, t.company || job.company, t.role || job.title).replace(/Resume/i, "Cover_Letter");
      const pdf = await buildCoverPdf(S.base.basics, t.cover, S.settings);
      return { name: /Cover_Letter/.test(name) ? name : name.replace(/\.pdf$/, "_Cover_Letter.pdf"), base64: pdf.base64 };
    },
    coverOnlyIfRequired: S.settings.coverAttach === "required",
    // Posting date for queue items saved before jobs carried one.
    postedFor: (job) => S.jobsByKey.get(job.key)?.posted || 0,
    // Is it a fit? The posting's own degree requirements (title/listing were
    // already used to pick it).
    fit: (job, postingText) => Fit.fitFromPosting(postingText, S.settings.target),
    // Can you apply? Listing flags + Simplify data + the posting itself.
    eligibility: async (job, postingText) => {
      const listing = S.jobsByKey.get(job.key);
      if (listing && E.hasSimplifyPage(listing) && !S.eligSignals[listing.id]) {
        try {
          const signals = await E.fetchSimplify(listing.simplifyId);
          S.eligSignals[listing.id] = signals;
          S.eligStore[listing.id] = { signals, at: Date.now() };
          saveElig();
        } catch {}
      }
      return E.verdict([...signalsForJob(listing), ...E.signalsFromText(postingText || "")], S.profile);
    },
  };
  const rerender = debounce(() => S.activeTab === "jobs" && renderJobs(), 150);
  try {
    await Autopilot.runQueue(S.queue, ctx, {
      concurrency: S.settings.autopilot.concurrency,
      pauseSec: S.settings.autopilot.pauseSec ?? 30,
      shouldStop: () => S.stopAutopilot,
      onUpdate: (item) => {
        if (item.status === "applied" && !S.applied[item.job.key]) {
          S.applied[item.job.key] = { company: item.job.company, title: item.job.title, url: item.job.url, date: Date.now(), auto: true };
          persist("applied", S.applied);
        }
        saveQueue();
        rerender();
      },
    });
  } finally {
    S.autopilotRunning = false;
    await persist("autopilotQueue", S.queue);
    renderJobs();
    const c = S.queue.reduce((m, i) => ((m[i.status] = (m[i.status] || 0) + 1), m), {});
    const summary = `${c.applied || 0} submitted, ${c.review || 0} to review, ${c["needs-you"] || 0} need you.`;
    toast(`Autopilot done: ${summary}`);
    chrome.notifications?.create(`autopilot-${Date.now()}`, { type: "basic", iconUrl: "../icons/icon128.png", title: "JobPilot Autopilot finished", message: summary, priority: 1 });
  }
}

async function openJob(j) {
  const tab = await chrome.tabs.create({ url: j.url, active: true });
  await store.setTabJob(tab.id, jobFromListing(j));
  S.activeTab = "apply";
  switchTab("apply");
  await refreshContext();
}

// ------------------------------------------------------------ RESUME tab

function editingResume() {
  if (S.editing !== "base" && S.tailored[S.editing]) return S.tailored[S.editing].resume;
  S.editing = "base";
  return S.base;
}

function saveEditing() {
  if (S.editing === "base") saveBase();
  else saveTailored();
  updateFit();
}

const updateFit = debounce(async () => {
  await loadFonts();
  const el = document.getElementById("fit-info");
  if (!el) return;
  const r = editingResume();
  if (!hasContent(r)) return (el.textContent = "");
  try {
    const { pages, scale } = renderResume(r);
    el.className = `pill ${pages > 1 ? "warn" : "good"}`;
    el.textContent = pages > 1 ? `${pages} pages: hide or trim some bullets` : scale < 1 ? `Fits on 1 page (text at ${Math.round(scale * 100)}%)` : "Fits on 1 page";
  } catch (e) {
    el.textContent = "";
  }
}, 600);

async function handleUpload(file) {
  if (!file) return;
  if (file.type !== "application/pdf" && !file.name.toLowerCase().endsWith(".pdf")) return toast("Please upload a PDF.", true);
  if (file.size > 20 * 1024 * 1024) return toast("That PDF is over 20 MB.", true);
  const base64 = await fileToBase64(file);
  S.resumePdf = { name: file.name, base64 };
  await persist("resumePdf", S.resumePdf);
  if (!aiReady()) {
    toast("Saved your PDF. Connect AI in Settings to turn it into editable boxes.");
    renderResumeTab();
    return;
  }
  await parseUploaded();
}

async function parseUploaded() {
  await withBusy(
    "parse",
    async () => {
      const parsed = await AI.parseResume(S.settings, S.resumePdf.base64);
      S.base = R.fromParsed(parsed);
      S.editing = "base";
      await persist("resume", S.base);
      if (parsed.profile) {
        S.profile = R.mergeProfile(S.profile, parsed.profile);
        await persist("profile", S.profile);
      }
      toast("Resume parsed. Check the boxes below.");
      buildTargetFromResume({ quiet: true }).catch(() => {});
    },
    renderResumeTab
  );
}

function renderResumeTab() {
  const el = $("#tab-resume");
  const parts = [];

  // Upload / status.
  const fileInput = h("input", { type: "file", accept: "application/pdf,.pdf", style: { display: "none" }, onchange: (e) => handleUpload(e.target.files[0]) });
  const drop = h(
    "div",
    {
      class: "dropzone",
      onclick: () => fileInput.click(),
      ondragover: (e) => {
        e.preventDefault();
        drop.classList.add("drag");
      },
      ondragleave: () => drop.classList.remove("drag"),
      ondrop: (e) => {
        e.preventDefault();
        drop.classList.remove("drag");
        handleUpload(e.dataTransfer.files[0]);
      },
    },
    S.busy.parse
      ? [spinner(), " Reading your resume with AI… (15–40s)"]
      : [h("strong", {}, S.resumePdf ? "Upload a new resume PDF" : "Upload your resume (PDF)"), h("div", { class: "small muted" }, "Click or drop a file here. AI turns it into editable boxes.")],
    fileInput
  );
  const uploadCard = h("div", { class: "card", id: "card-upload" }, drop);
  if (S.resumePdf) {
    uploadCard.append(
      h(
        "div",
        { class: "row small", style: { marginTop: "8px" } },
        h("span", { class: "muted" }, `Uploaded: ${S.resumePdf.name}`),
        h("span", { class: "spacer" }),
        aiReady() && !S.busy.parse && h("button", { class: "btn ghost", onclick: parseUploaded }, hasContent(S.base) ? "Re-parse" : "Parse with AI")
      )
    );
  }
  if (!hasContent(S.base) && !S.busy.parse) {
    uploadCard.append(
      h(
        "div",
        { class: "row small", style: { marginTop: "6px" } },
        h(
          "button",
          {
            class: "btn ghost",
            onclick: () => {
              S.base = R.emptyResume();
              S.base.sections = [R.newSection("entries", "Education"), R.newSection("entries", "Experience"), R.newSection("entries", "Projects"), R.newSection("lines", "Technical Skills")];
              saveBase();
              renderResumeTab();
            },
          },
          "Or start from a blank template"
        )
      )
    );
  }
  const guide = setupGuide();
  if (guide) parts.push(guide);
  parts.push(uploadCard);

  if (!hasContent(S.base)) {
    el.replaceChildren(...parts);
    return;
  }

  const r = editingResume();

  // Version picker + actions.
  const versions = Object.entries(S.tailored).sort((a, b) => b[1].createdAt - a[1].createdAt);
  parts.push(
    h(
      "div",
      { class: "card" },
      versions.length
        ? h(
            "label",
            { class: "field" },
            h("span", {}, "Editing"),
            h(
              "select",
              {
                onchange: (e) => {
                  S.editing = e.target.value;
                  renderResumeTab();
                },
              },
              h("option", { value: "base", selected: S.editing === "base" }, "Base resume (used for tailoring)"),
              versions.map(([k, v]) => h("option", { value: k, selected: S.editing === k }, `Tailored: ${v.company || k}${v.role ? ` (${v.role})` : ""}`))
            )
          )
        : null,
      h(
        "div",
        { class: "row" },
        h("button", { class: "btn", onclick: () => previewResume(r).catch((e) => toast(e.message, true)) }, "Preview PDF"),
        h(
          "button",
          {
            class: "btn",
            onclick: async () => {
              const t = S.editing !== "base" ? S.tailored[S.editing] : null;
              const name = R.fileNameFor(S.settings.fileNamePattern, r, S.profile, t?.company, t?.role);
              const pdf = await buildResumePdf(r, S.settings);
              await downloadBase64(pdf.base64, name);
              toast(`Saved Downloads/Resumes/${name}${pdf.engine === "built-in" ? "" : ` (compiled with ${pdf.engine})`}`);
            },
          },
          "Download"
        ),
        h("span", { class: "spacer" }),
        h("span", { id: "fit-info", class: "pill" }, "")
      ),
      h(
        "div",
        { class: "row small", style: { marginTop: "8px" } },
        h("span", { class: "muted" }, "Jake's Resume (LaTeX):"),
        h(
          "button",
          {
            class: "btn ghost",
            onclick: () => {
              const t = S.editing !== "base" ? S.tailored[S.editing] : null;
              downloadTex(r, R.fileNameFor(S.settings.fileNamePattern, r, S.profile, t?.company, t?.role));
              toast("Saved the .tex to Downloads/Resumes/");
            },
          },
          "Download .tex"
        ),
        h("button", { class: "btn ghost", onclick: () => openInOverleaf(r) }, "Open in Overleaf")
      ),
      h("div", { class: "small muted", style: { marginTop: "4px" } }, latexStatus() ? "PDFs use the built-in Computer Modern renderer (no LaTeX found on your computer)." : S.settings.provider === "claude-code" && S.settings.renderer !== "built-in" ? "PDFs are compiled with LaTeX on your computer when available." : "PDFs use the built-in Computer Modern renderer.")
    )
  );
  parts.push(basicsCard(r));
  parts.push(
    h(
      "div",
      { class: "card" },
      h("h3", {}, "Summary ", h("span", { class: "muted small" }, "(optional)")),
      textarea({
        value: r.summary,
        placeholder: "Leave blank if your resume has no summary",
        oninput: (e) => {
          r.summary = e.target.value;
          saveEditing();
        },
      })
    )
  );
  r.sections.forEach((s, i) => parts.push(sectionCard(r, s, i)));
  parts.push(
    h(
      "div",
      { class: "row", style: { marginBottom: "10px" } },
      h("span", { class: "small muted" }, "Add section:"),
      h("button", { class: "btn", onclick: () => addSection(r, "entries", "New Section") }, "+ Entries"),
      h("button", { class: "btn", onclick: () => addSection(r, "lines", "Skills") }, "+ Skills list"),
      h("button", { class: "btn", onclick: () => addSection(r, "text", "Section") }, "+ Text")
    )
  );
  parts.push(
    h(
      "details",
      { class: "card" },
      h("summary", {}, "Backup / restore"),
      h(
        "div",
        { class: "row", style: { marginTop: "8px" } },
        h(
          "button",
          {
            class: "btn",
            onclick: async () => {
              const b64 = btoa(unescape(encodeURIComponent(JSON.stringify(r, null, 2))));
              await chrome.downloads.download({ url: `data:application/json;base64,${b64}`, filename: "Resumes/resume.json", conflictAction: "overwrite" });
            },
          },
          "Export JSON"
        ),
        h(
          "button",
          {
            class: "btn",
            onclick: () => {
              const inp = h("input", {
                type: "file",
                accept: ".json,application/json",
                onchange: async (e) => {
                  try {
                    const data = JSON.parse(await e.target.files[0].text());
                    if (!data.basics || !Array.isArray(data.sections)) throw new Error("Not a JobPilot resume file.");
                    S.base = data;
                    S.editing = "base";
                    await persist("resume", S.base);
                    renderResumeTab();
                    toast("Imported.");
                  } catch (err) {
                    toast(err.message, true);
                  }
                },
              });
              inp.click();
            },
          },
          "Import JSON"
        )
      )
    )
  );
  if (S.editing === "base") parts.push(coverCard());
  el.replaceChildren(...parts);
  updateFit();
}

function addSection(r, kind, title) {
  const s = R.newSection(kind, title);
  if (kind === "entries") s.entries.push(R.newEntry());
  if (kind === "lines") s.lines.push(R.newLine());
  r.sections.push(s);
  saveEditing();
  renderResumeTab();
}

function input(obj, key, placeholder, extra = {}) {
  return h("input", {
    type: "text",
    value: obj[key] || "",
    placeholder,
    oninput: (e) => {
      obj[key] = e.target.value;
      saveEditing();
    },
    ...extra,
  });
}

function move(arr, i, d) {
  const j = i + d;
  if (j < 0 || j >= arr.length) return;
  [arr[i], arr[j]] = [arr[j], arr[i]];
}

function structural(fn) {
  return () => {
    fn();
    saveEditing();
    renderResumeTab();
  };
}

function basicsCard(r) {
  const b = r.basics;
  return h(
    "div",
    { class: "card" },
    h("h3", {}, "Header"),
    h("label", { class: "field" }, h("span", {}, "Name"), input(b, "name", "Full name")),
    h("div", { class: "grid2" }, h("label", { class: "field" }, h("span", {}, "Email"), input(b, "email", "you@school.edu")), h("label", { class: "field" }, h("span", {}, "Phone"), input(b, "phone", "(555) 555-5555"))),
    h("label", { class: "field" }, h("span", {}, "Location"), input(b, "location", "City, ST (optional)")),
    h("span", { class: "small muted" }, "Links"),
    b.links.map((l, i) =>
      h(
        "div",
        { class: "lineitem" },
        input(l, "label", "Label", { class: "label" }),
        input(l, "url", "https://…"),
        h("button", { class: "icon", title: "Remove", onclick: structural(() => b.links.splice(i, 1)) }, "✕")
      )
    ),
    h("button", { class: "btn ghost small", onclick: structural(() => b.links.push({ label: "", url: "" })) }, "+ Add link")
  );
}

function sectionCard(r, s, si) {
  const card = h(
    "div",
    { class: "card section-card" },
    h(
      "div",
      { class: "head" },
      input(s, "title", "Section title"),
      h("button", { class: "icon", title: "Move up", onclick: structural(() => move(r.sections, si, -1)) }, "↑"),
      h("button", { class: "icon", title: "Move down", onclick: structural(() => move(r.sections, si, 1)) }, "↓"),
      h(
        "button",
        {
          class: "icon",
          title: "Delete section",
          onclick: () => {
            if (confirm(`Delete the "${s.title}" section?`)) structural(() => r.sections.splice(si, 1))();
          },
        },
        "🗑"
      )
    )
  );

  if (s.kind === "entries") {
    // How this section is typeset (filled in from the uploaded resume).
    const look = L.sectionLayout(s);
    const pick = (key, options) =>
      h(
        "select",
        { onchange: (ev) => structural(() => (s[key] = ev.target.value))() },
        options.map(([v, t]) => h("option", { value: v, selected: look[key] === v }, t))
      );
    card.append(
      h(
        "details",
        { class: "small", style: { margin: "4px 0 8px" } },
        h("summary", {}, "Layout"),
        h("div", { class: "stack", style: { marginTop: "6px" } }, pick("layout", L.LAYOUTS), look.layout === "heading" ? [pick("order", L.ORDERS), pick("datesOn", L.DATES_ON)] : null)
      )
    );
    s.entries.forEach((e, ei) => {
      const entry = h(
        "div",
        { class: `entry${e.hidden ? " hidden-item" : ""}` },
        h(
          "div",
          { class: "head" },
          input(e, "title", "Organization / school / project"),
          h("button", { class: "icon", title: e.hidden ? "Show on resume" : "Hide from resume", onclick: structural(() => (e.hidden = !e.hidden)) }, e.hidden ? "◌" : "●"),
          h("button", { class: "icon", title: "Move up", onclick: structural(() => move(s.entries, ei, -1)) }, "↑"),
          h("button", { class: "icon", title: "Move down", onclick: structural(() => move(s.entries, ei, 1)) }, "↓"),
          h("button", { class: "icon", title: "Delete", onclick: structural(() => s.entries.splice(ei, 1)) }, "✕")
        ),
        h("div", { class: "grid2" }, input(e, "subtitle", "Role / degree"), input(e, "dates", "Dates (e.g. May 2025 – Aug 2025)")),
        h("div", { style: { margin: "6px 0" } }, input(e, "location", "Location (optional)")),
        look.layout !== "row" ? h("div", { class: "grid2", style: { marginBottom: "6px" } }, input(e, "linkLabel", "Link text (e.g. GitHub)"), input(e, "url", "Link URL (optional)")) : null,
        e.bullets.map((b, bi) =>
          h(
            "div",
            { class: `bullet${b.hidden ? " hidden-item" : ""}` },
            h("span", { class: "dot" }, "•"),
            textarea({
              value: b.text,
              title: "Wrap text in **double asterisks** to make it bold",
              oninput: (ev) => {
                b.text = ev.target.value;
                saveEditing();
              },
            }),
            h(
              "div",
              { class: "tools" },
              h("button", { class: "icon", title: b.hidden ? "Show" : "Hide", onclick: structural(() => (b.hidden = !b.hidden)) }, b.hidden ? "◌" : "●"),
              h("button", { class: "icon", title: "Move up", onclick: structural(() => move(e.bullets, bi, -1)) }, "↑"),
              h("button", { class: "icon", title: "Delete", onclick: structural(() => e.bullets.splice(bi, 1)) }, "✕")
            )
          )
        ),
        h("button", { class: "btn ghost small", onclick: structural(() => e.bullets.push(R.newBullet())) }, "+ Bullet")
      );
      card.append(entry);
    });
    card.append(h("button", { class: "btn small", onclick: structural(() => s.entries.push(R.newEntry())) }, "+ Add entry"));
  } else if (s.kind === "lines") {
    s.lines.forEach((l, li) =>
      card.append(
        h(
          "div",
          { class: `lineitem${l.hidden ? " hidden-item" : ""}` },
          input(l, "label", "Label", { class: "label" }),
          textarea({
            value: l.text,
            placeholder: "Python, Java, React…",
            oninput: (ev) => {
              l.text = ev.target.value;
              saveEditing();
            },
          }),
          h(
            "div",
            { class: "tools" },
            h("button", { class: "icon", title: l.hidden ? "Show" : "Hide", onclick: structural(() => (l.hidden = !l.hidden)) }, l.hidden ? "◌" : "●"),
            h("button", { class: "icon", title: "Delete", onclick: structural(() => s.lines.splice(li, 1)) }, "✕")
          )
        )
      )
    );
    card.append(h("button", { class: "btn ghost small", onclick: structural(() => s.lines.push(R.newLine())) }, "+ Add row"));
  } else {
    card.append(
      textarea({
        value: s.text,
        oninput: (ev) => {
          s.text = ev.target.value;
          saveEditing();
        },
      })
    );
  }
  return card;
}

// ------------------------------------------------------- cover letter

const saveCover = debounce(() => persist("coverLetter", S.cover), 400);

function coverCard() {
  const c = S.cover;
  const field = (key, label, placeholder, rows = 3) =>
    h(
      "label",
      { class: "field" },
      h("span", {}, label),
      textarea({
        rows,
        value: c[key] || "",
        placeholder,
        oninput: (e) => {
          c[key] = e.target.value;
          saveCover();
          status();
        },
      })
    );
  const line = (key, label, placeholder) =>
    h("label", { class: "field" }, h("span", {}, label), h("input", { type: "text", value: c[key] || "", placeholder, oninput: (e) => ((c[key] = e.target.value), saveCover()) }));
  const rerender = () => (saveCover(), renderResumeTab());

  const state = h("div", { class: "small", style: { margin: "6px 0" } });
  const status = () =>
    state.replaceChildren(
      C.coverReady(c)
        ? h("span", { class: "pill good" }, "Ready: tailoring will build a letter for each job")
        : h("span", { class: "pill warn", style: { whiteSpace: "normal" } }, "Add an opening, a closing and at least one experience paragraph to turn it on")
    );
  status();

  const stories = c.stories.map((st, i) =>
    h(
      "div",
      { class: "entry" },
      h(
        "div",
        { class: "head" },
        h("input", { type: "text", value: st.title, placeholder: "Short name (e.g. ML research at Princeton)", oninput: (e) => ((st.title = e.target.value), saveCover()) }),
        h("button", { class: "icon", title: "Move up", onclick: () => (move(c.stories, i, -1), rerender()) }, "↑"),
        h("button", { class: "icon", title: "Delete", onclick: () => (c.stories.splice(i, 1), rerender()) }, "✕")
      ),
      textarea({
        rows: 3,
        value: st.text,
        placeholder: "2–3 sentences in your own words: what you did, how, and the result. Concrete beats impressive.",
        oninput: (e) => {
          st.text = e.target.value;
          saveCover();
          status();
        },
      })
    )
  );

  // Empty paragraphs named after your experience and projects (you write them).
  const fromResume = () => {
    const have = new Set(c.stories.map((x) => x.title.toLowerCase()));
    for (const sec of S.base?.sections || []) {
      if (sec.kind !== "entries" || !/experience|project|research|leadership/i.test(sec.title)) continue;
      for (const e of sec.entries) {
        const title = [e.subtitle, e.title].filter(Boolean).join(" at ").slice(0, 80);
        if (title && !have.has(title.toLowerCase())) c.stories.push({ id: R.uid("st"), title, text: "" });
      }
    }
    rerender();
  };

  const preview = async () => {
    const picks = C.pickStories(c, "").map((p) => p.s.id);
    const letter = C.buildLetter(c, { company: "Acme Robotics", role: "Software Engineering Intern", picks });
    const pdf = await buildCoverPdf(S.base.basics, letter, S.settings);
    chrome.tabs.create({ url: base64ToBlobUrl(pdf.base64) });
  };

  return h(
    "details",
    { class: "card", id: "card-cover", open: S.coverOpen ?? false, ontoggle: (e) => (S.coverOpen = e.target.open) },
    h("summary", {}, h("strong", {}, "Cover letter"), h("span", { class: "small muted" }, " (optional)")),
    h(
      "p",
      { class: "small muted" },
      "Write it once, in your own words. For each job, JobPilot keeps your opening, \"why\" and closing, picks the experience paragraphs that best match the posting, and fills in {Company} and {Role}. Hiring managers mark down generic or AI-sounding letters, so AI only adds one sentence about the posting where you put {Hook}, and lightly rewords your paragraphs toward its terms. You approve both, and Autopilot leaves them out."
    ),
    h(
      "ul",
      { class: "small muted", style: { paddingLeft: "18px", margin: "4px 0 8px" } },
      h("li", {}, "Under a page: an opening, 1–2 experience paragraphs, why this company, a short close."),
      h("li", {}, "Tie each paragraph to something you actually did, with a concrete detail or number."),
      h("li", {}, "Skip flowery lines (\"I am passionate about…\"). Plain and specific reads as you.")
    ),
    state,
    line("greeting", "Greeting", "Dear Hiring Manager,"),
    field("opening", "Opening", "I'm a first-year Computer Science student at Georgia Tech applying for the {Role} position at {Company}. Say in a sentence what you'd bring or why this kind of work."),
    h("div", { class: "small", style: { fontWeight: 600, margin: "10px 0 4px" } }, "Experience paragraphs"),
    stories,
    h(
      "div",
      { class: "row", style: { margin: "6px 0 10px" } },
      h("button", { class: "btn small", onclick: () => (c.stories.push({ id: R.uid("st"), title: "", text: "" }), rerender()) }, "+ Paragraph"),
      h("button", { class: "btn ghost small", onclick: fromResume }, "Add one per resume entry"),
      h(
        "label",
        { class: "small" },
        "Use ",
        h("select", { onchange: (e) => ((c.perLetter = Number(e.target.value)), saveCover()) }, [1, 2, 3].map((v) => h("option", { value: v, selected: (c.perLetter || 2) === v }, v))),
        " per letter"
      )
    ),
    field("why", "Why this company", "What draws me to {Company}: {Hook} Then a sentence or two of your own on why this kind of work matters to you."),
    line("hookFallback", "If AI has nothing specific for {Hook}, use", "you build things people actually use."),
    field("closing", "Closing", "Thank you for your time. I'd welcome the chance to talk about how I could contribute this summer.", 2),
    line("signoff", "Sign-off", "Sincerely,"),
    h("div", { class: "row", style: { marginTop: "8px" } }, h("button", { class: "btn", onclick: () => withBusy("coverPreview", preview, renderResumeTab), disabled: !C.coverReady(c) }, "Preview with a sample company"))
  );
}

// ----------------------------------------------------- feedback to AI

// Standing instructions: what you've asked AI to always do.
function rememberInstruction(text) {
  const lines = (S.settings.instructions || "").split("\n").map((l) => l.trim()).filter(Boolean);
  if (!lines.includes(text)) lines.push(text);
  S.settings.instructions = lines.join("\n");
  saveSettings();
}

// "Tell AI what it got wrong": a button that opens a box. run(text)
// does the work; rerender() redraws the tab it lives on.
function feedbackBox({ key, button, placeholder, run, rerender, primary = false }) {
  const st = (S.fb[key] ||= { open: false, text: "", remember: false });
  if (!st.open) return h("button", { class: `btn ${primary ? "" : "ghost "}small`, onclick: () => ((st.open = true), rerender()) }, button);
  const go = async (e) => {
    const text = st.text.trim();
    if (!text) return toast("Say what to change first.", true);
    e.target.disabled = true;
    e.target.replaceChildren(spinner(), " Working…");
    try {
      if (st.remember) rememberInstruction(text);
      await run(text);
      S.fb[key] = { open: false, text: "", remember: false };
    } catch (err) {
      toast(err.message, true);
    }
    rerender();
  };
  return h(
    "div",
    { class: "change", style: { marginTop: "6px" } },
    textarea({ rows: 2, value: st.text, placeholder, oninput: (e) => (st.text = e.target.value) }),
    h("label", { class: "row small", style: { margin: "4px 0" } }, h("input", { type: "checkbox", checked: st.remember, onchange: (e) => (st.remember = e.target.checked) }), "Remember this for every application"),
    h("div", { class: "row end" }, h("button", { class: "btn ghost small", onclick: () => ((S.fb[key].open = false), rerender()) }, "Cancel"), h("button", { class: "btn primary small", onclick: go }, "Send to AI"))
  );
}

// --------------------------------------------- accounts & sign-in

const acctUi = { reveal: {}, gmail: null }; // passwords shown; Gmail status

function accountsCard() {
  const a = S.settings.accounts;
  const set = (k, v) => ((a[k] = v), saveSettings(), renderSettings());
  const toggle = (k, label, note) =>
    h("label", { class: "row small", style: { margin: "6px 0", alignItems: "flex-start" } }, h("input", { type: "checkbox", checked: !!a[k], onchange: (e) => set(k, e.target.checked) }), h("div", {}, label, note ? h("div", { class: "muted" }, note) : null));

  const card = h("div", { class: "card", id: "card-accounts" }, h("h3", {}, "Accounts & sign-in"));
  if (!a.enabled) {
    card.append(
      h("p", { class: "small muted" }, "Some sites (Workday and others) want an account before you can apply. JobPilot can sign in for you with \"Sign in with Google\", or make an account with your email, and read the verification codes they email you. Off until you turn it on."),
      h(
        "div",
        { class: "notice warn small" },
        h("strong", {}, "Before you turn this on"),
        h(
          "ul",
          { class: "report-list", style: { margin: "4px 0 0" } },
          h("li", {}, "You sign in to Google yourself, once, in this browser. JobPilot never sees or types your Google password, and stops if Google asks for it or wants to verify it's you."),
          h("li", {}, "With Sign in with Google, JobPilot picks your account and clicks Continue on Google's \"share your name and email\" screen for each job site. It stops if a site asks for more than that."),
          h("li", {}, "It reads verification codes from your Gmail inbox in this browser (unread emails only, nothing is sent)."),
          h("li", {}, "If you allow new accounts, JobPilot accepts each site's terms for you and keeps the generated passwords in this browser's extension storage, which isn't encrypted."),
          h("li", {}, "Google and job sites may flag automated sign-ins. Google's pages aren't an official interface, so this can stop working.")
        )
      ),
      h("button", { class: "btn primary", style: { marginTop: "8px" }, onclick: () => ((a.enabled = true), (a.agreedAt = Date.now()), saveSettings(), renderSettings()) }, "I understand, turn it on")
    );
    return card;
  }

  // Gmail status (checked once per panel open).
  if (acctUi.gmail === null) {
    acctUi.gmail = "…";
    gmailAccount(S.profile.email)
      .then((who) => ((acctUi.gmail = who || ""), renderSettings()))
      .catch(() => ((acctUi.gmail = ""), renderSettings()));
  }
  const gm = acctUi.gmail;
  card.append(
    toggle("google", "Use \"Sign in with Google\" when a site offers it", "Make sure you're signed in to Google in this browser with " + (S.profile.email || "your profile email") + "."),
    toggle("createAccounts", "Create an account with my email when there's no Google option", "Uses a generated password per site, saved below. JobPilot accepts the site's terms for you."),
    toggle("readGmail", "Read verification codes from my Gmail", gm === "…" ? "Checking Gmail…" : gm ? `Gmail inbox: ${gm}` : "Not signed in to Gmail in this browser: open gmail.com and sign in."),
    S.profile.email && gm && gm !== "…" && gm.includes("@") && gm.toLowerCase() !== S.profile.email.toLowerCase()
      ? h("div", { class: "notice warn small" }, `Your profile email (${S.profile.email}) isn't the Gmail inbox above, so codes sent to it won't be found.`)
      : null
  );

  // Accounts JobPilot made.
  const accts = S.accounts || {};
  const keys = Object.keys(accts).sort((x, y) => (accts[y].createdAt || 0) - (accts[x].createdAt || 0));
  card.append(h("div", { class: "small", style: { fontWeight: 600, margin: "10px 0 4px" } }, `Accounts JobPilot made (${keys.length})`));
  if (!keys.length) card.append(h("div", { class: "small muted" }, "None yet."));
  for (const k of keys) {
    const x = accts[k];
    card.append(
      h(
        "div",
        { class: "change", style: { padding: "6px 8px" } },
        h("div", { class: "row small" }, h("strong", {}, x.company || k), h("span", { class: "muted" }, k), h("span", { class: "spacer" }), x.verified ? null : h("span", { class: "pill warn" }, "not confirmed")),
        h(
          "div",
          { class: "row small", style: { marginTop: "4px" } },
          h("span", {}, x.email),
          h("code", {}, acctUi.reveal[k] ? x.password : "••••••••••"),
          h("button", { class: "btn ghost small", onclick: () => ((acctUi.reveal[k] = !acctUi.reveal[k]), renderSettings()) }, acctUi.reveal[k] ? "Hide" : "Show"),
          h("button", { class: "btn ghost small", onclick: async () => (await navigator.clipboard.writeText(x.password), toast("Password copied")) }, "Copy"),
          h(
            "button",
            {
              class: "btn ghost small",
              onclick: async () => {
                if (!confirm(`Forget the saved password for ${k}? (The account on the site stays.)`)) return;
                delete accts[k];
                await persist("accounts", accts);
                renderSettings();
              },
            },
            "Forget"
          )
        )
      )
    );
  }
  card.append(
    h(
      "div",
      { class: "row", style: { marginTop: "8px" } },
      // Shows whose inbox JobPilot reads and how many unread emails it sees; no email content.
      h(
        "button",
        {
          class: "btn small",
          disabled: S.busy.gmailTest,
          onclick: () =>
            withBusy("gmailTest", async () => {
              const r = await testGmail(S.profile.email);
              acctUi.gmail = r.owner || "";
              acctUi.test = r;
            }),
        },
        S.busy.gmailTest ? [spinner(), " Testing…"] : "Test Gmail"
      ),
      acctUi.test ? h("span", { class: `pill ${acctUi.test.ok ? "good" : "warn"}`, style: { whiteSpace: "normal" } }, acctUi.test.note) : null,
      h("span", { class: "spacer" }),
      h("button", { class: "btn ghost small", onclick: () => ((a.enabled = false), saveSettings(), renderSettings()) }, "Turn off")
    )
  );
  return card;
}

// ------------------------------------------------------- answer bank

const saveBank = debounce(() => persist("answerBank", S.bank), 400);

function bankCard() {
  const written = S.bank.filter((b) => b.text.trim()).length;
  const rerender = () => (saveBank(), renderSettings());
  return h(
    "details",
    { class: "card", id: "card-bank", open: S.bankOpen ?? false, ontoggle: (e) => (S.bankOpen = e.target.open) },
    h("summary", {}, h("strong", {}, "Your answers"), h("span", { class: "small muted" }, ` (${written} written)`)),
    h(
      "p",
      { class: "small muted" },
      "Answer the questions applications ask most, once, in your own words. When a form asks the same thing, even worded differently, AI matches it and your answer is used as written ({Company} and {Role} filled in). These count as your words, so Autopilot can submit them; questions nobody answered here wait for your review."
    ),
    S.bank.map((b, i) =>
      h(
        "div",
        { class: "entry" },
        h(
          "div",
          { class: "head" },
          h("input", { type: "text", value: b.prompt, placeholder: "Question", oninput: (e) => ((b.prompt = e.target.value), saveBank()) }),
          h("button", { class: "icon", title: "Delete", onclick: () => (S.bank.splice(i, 1), rerender()) }, "✕")
        ),
        textarea({ rows: 3, value: b.text, placeholder: "Your answer, 3–6 sentences. Specific beats polished.", oninput: (e) => ((b.text = e.target.value), saveBank()) })
      )
    ),
    h("button", { class: "btn small", style: { marginTop: "6px" }, onclick: () => (S.bank.push({ id: R.uid("bank"), prompt: "", text: "" }), rerender()) }, "+ Question")
  );
}

// ---------------------------------------------------------- SETTINGS tab

const YES_NO = [
  ["yes", "Yes"],
  ["no", "No"],
];
const EEO = {
  gender: ["Decline to self-identify", "Male", "Female", "Non-binary"],
  race: ["Decline to self-identify", "Asian", "Black or African American", "Hispanic or Latino", "White", "Two or More Races", "Native Hawaiian or Other Pacific Islander", "American Indian or Alaska Native"],
  hispanic: ["Decline to self-identify", "Yes", "No"],
  veteran: ["Decline to self-identify", "I am not a protected veteran", "I identify as one or more of the classifications of protected veteran"],
  disability: ["Decline to self-identify", "No, I do not have a disability", "Yes, I have a disability"],
};

async function refreshChatGPT() {
  if (S.chatgptLoading) return;
  S.chatgptLoading = true;
  S.chatgptError = "";
  try {
    const session = await AI.chatGPTStatus();
    S.chatgptSession = session;
    const st = S.settings;
    if (!st.chatgptAccountId) st.chatgptAccountId = session.active || "";
    const account = session.accounts.find((a) => a.id === st.chatgptAccountId);
    st.chatgptPlanEnabled = !!account?.planEnabled;
    S.chatgptModels = st.chatgptPlanEnabled ? await AI.chatGPTModels(st.chatgptAccountId) : [];
    if (!S.chatgptModels.some((m) => m.id === st.chatgptModel)) st.chatgptModel = S.chatgptModels[0]?.id || "";
    await store.set("settings", st);
  } catch (error) {
    S.chatgptError = error.message;
    S.settings.chatgptPlanEnabled = false;
    S.chatgptModels = [];
    await store.set("settings", S.settings);
  } finally {
    S.chatgptLoading = false;
    if (S.activeTab === "settings") renderSettings();
  }
}

function chatGPTWelcome() {
  if (S.settings.chatgptWelcomeSeen) return;
  const dialog = h("dialog", { style: { maxWidth: "360px", padding: "20px", borderRadius: "12px", border: "1px solid var(--border)", background: "var(--bg)", color: "var(--text)" } },
    h("h3", {}, "You’re using your ChatGPT plan"),
    h("p", {}, "Eligible AI requests in JobPilot use your ChatGPT plan or available credits. You can manage app access and usage in ChatGPT settings."),
    h("p", {}, h("a", { href: "https://chatgpt.com/settings/usage", target: "_blank" }, "Manage usage")),
    h("button", { class: "btn primary", onclick: () => dialog.close() }, "Got it")
  );
  dialog.addEventListener("close", () => { S.settings.chatgptWelcomeSeen = true; saveSettings(); dialog.remove(); });
  document.body.append(dialog);
  dialog.showModal();
}

async function connectChatGPT(newAccount = false) {
  if (S.chatgptSigningIn) return;
  S.chatgptSigningIn = true;
  S.chatgptError = "";
  renderSettings();
  try {
    const accountId = newAccount ? undefined : S.settings.chatgptAccountId || undefined;
    const current = S.chatgptSession?.accounts.find((a) => a.id === accountId);
    const session = await AI.signInChatGPT(accountId, !!current?.connected && !current.planEnabled);
    S.chatgptSession = session;
    S.settings.chatgptAccountId = session.active || "";
    S.settings.aiVerified = false;
    await refreshChatGPT();
    if (S.settings.chatgptPlanEnabled) chatGPTWelcome();
  } catch (error) { S.chatgptError = error.message; }
  finally { S.chatgptSigningIn = false; renderSettings(); }
}

function chatGPTSettingsBody() {
  const st = S.settings;
  const accounts = S.chatgptSession?.accounts || [];
  const account = accounts.find((a) => a.id === st.chatgptAccountId);
  const changeAccount = async (id) => {
    try {
      st.chatgptAccountId = id;
      st.chatgptModel = "";
      st.chatgptPlanEnabled = false;
      st.aiVerified = false;
      S.chatgptModels = [];
      S.chatgptSession = await AI.selectChatGPTAccount(id);
      await refreshChatGPT();
    } catch (error) { S.chatgptError = error.message; renderSettings(); }
  };
  return [
    h("p", { class: "small muted" }, "Install Node.js 20 or newer, run node bridge/install.js from this repo, then restart your browser. Claude Code is optional. Continue with ChatGPT opens sign-in in a browser tab; keep this JobPilot panel open until it finishes."),
    S.chatgptError && h("p", { class: "pill bad", style: { whiteSpace: "normal" } }, S.chatgptError),
    S.chatgptLoading && h("p", {}, spinner(), " Loading ChatGPT connection…"),
    accounts.length > 0 && h("label", { class: "field" }, h("span", {}, "ChatGPT account / workspace"),
      h("select", { disabled: S.chatgptSigningIn || S.chatgptLoading, onchange: (e) => changeAccount(e.target.value) },
        h("option", { value: "", selected: !account, disabled: true }, "Choose an account"),
        accounts.map((a, i) => h("option", { value: a.id, selected: st.chatgptAccountId === a.id }, `${a.email || "ChatGPT account"} · Connection ${i + 1}${a.connected ? "" : " (signed out)"}`))
      )
    ),
    account?.connected && h("p", { class: "small" }, account.planEnabled ? "Using ChatGPT plan" : "Signed in. ChatGPT plan usage is not enabled."),
    h("div", { class: "row" },
      h("button", { class: "btn primary", disabled: S.chatgptSigningIn || S.chatgptLoading, onclick: () => connectChatGPT() }, "Continue with ChatGPT"),
      h("button", { class: "btn ghost", disabled: S.chatgptSigningIn || S.chatgptLoading, onclick: () => connectChatGPT(true) }, "Add account"),
      S.chatgptSigningIn && h("button", { class: "btn ghost", onclick: AI.cancelChatGPTSignIn }, "Cancel sign-in")
    ),
    S.chatgptSigningIn && h("p", { class: "small muted" }, spinner(), " Complete sign-in in the browser tab…"),
    S.chatgptModels.length > 0 && h("label", { class: "field" }, h("span", {}, "Model · Using ChatGPT plan"),
      h("select", { onchange: (e) => { st.chatgptModel = e.target.value; st.aiVerified = false; saveSettings(); } }, S.chatgptModels.map((m) => h("option", { value: m.id, selected: st.chatgptModel === m.id }, m.label)))
    ),
    h("div", { class: "row" },
      h("a", { href: "https://chatgpt.com/settings/usage", target: "_blank" }, "Manage usage"),
      h("button", { class: "btn ghost", disabled: S.chatgptLoading || S.chatgptSigningIn, onclick: refreshChatGPT }, "Refresh connection"),
      account?.connected && h("button", { class: "btn ghost", disabled: S.chatgptLoading || S.chatgptSigningIn, onclick: async () => {
        try {
          const session = await AI.signOutChatGPT(st.chatgptAccountId);
          S.chatgptSession = session;
          st.chatgptPlanEnabled = false;
          st.aiVerified = false;
          S.chatgptModels = [];
          await store.set("settings", st);
          toast(session.revoked ? "Signed out of ChatGPT." : "Signed out locally. Remote revocation wasn't confirmed; disconnect JobPilot in ChatGPT settings.", !session.revoked);
        } catch (error) { S.chatgptError = error.message; }
        renderSettings();
      } }, "Sign out")
    )
  ];
}

function renderSettings() {
  const el = $("#tab-settings");
  const st = S.settings;
  const p = S.profile;

  const status = h("span", { class: "small" });
  const usingCC = st.provider === "claude-code";
  const usingOpenAI = st.provider === "openai";
  const usingChatGPT = st.provider === "chatgpt";
  if (usingChatGPT && !S.chatgptSession && !S.chatgptLoading && !S.chatgptError) refreshChatGPT();

  const testButton = h(
    "button",
    {
      class: "btn primary",
      disabled: usingChatGPT && (!st.chatgptPlanEnabled || !st.chatgptModel || S.chatgptLoading || S.chatgptSigningIn),
      onclick: async (e) => {
        e.target.disabled = true;
        status.replaceChildren(spinner(), usingCC ? " Asking Claude Code… (can take ~10s)" : " Testing…");
        try {
          await persist("settings", st);
          const r = await AI.testConnection(st);
          st.aiVerified = true;
          await persist("settings", st);
          resetLatexStatus();
          status.replaceChildren(h("span", { class: "pill good" }, usingCC ? `Connected ✓ ${r.split(" · ").slice(1).join(" · ")}` : "Connected ✓"));
        } catch (err) {
          status.replaceChildren(h("span", { class: "pill bad", style: { whiteSpace: "normal" } }, err.message));
        } finally {
          e.target.disabled = false;
        }
      },
    },
    "Save & test"
  );

  const providerPick = h(
    "div",
    { class: "stack", style: { marginBottom: "10px" } },
    [
      ["claude-code", "My Claude subscription (via Claude Code)", "Uses your Pro/Max plan's limits. No API key needed. Needs Claude Code and Node.js on this computer."],
      ["chatgpt", "My ChatGPT subscription", "Eligible Plus/Pro plan or credits through Sign in with ChatGPT. No API key. Needs Node.js and the JobPilot bridge."],
      ["openai", "OpenAI API key (ChatGPT models)", "Pay-as-you-go API billing. Your ChatGPT subscription does not cover these API calls."],
      ["api", "Anthropic API key", "Pay-as-you-go, about 5–15¢ per tailored resume on Opus 5.5. Works on any computer."],
    ].map(([v, title, sub]) =>
      h(
        "label",
        { class: "change", style: { display: "flex", gap: "8px", cursor: "pointer", borderColor: st.provider === v ? "var(--accent)" : "" } },
        h("input", {
          type: "radio",
          name: "provider",
          checked: st.provider === v,
          onchange: () => {
            st.provider = v;
            st.aiVerified = false;
            saveSettings();
            renderSettings();
          },
        }),
        h("div", {}, h("div", { style: { fontWeight: 600 } }, title), h("div", { class: "small muted" }, sub))
      )
    )
  );

  let body;
  if (usingChatGPT) {
    body = chatGPTSettingsBody();
  } else if (usingCC) {
    const cmd = "node bridge/install.js";
    body = [
      h("div", { class: "small", style: { fontWeight: 600 } }, "One-time setup"),
      h(
        "ol",
        { class: "small", style: { paddingLeft: "18px", margin: "6px 0 10px" } },
        h("li", {}, "Make sure Claude Code is logged in: open a terminal, run ", h("code", {}, "claude"), ", and sign in with your Claude account if asked."),
        h(
          "li",
          {},
          "In a terminal, ",
          h("code", {}, "cd"),
          " into the JobPilot folder (the one containing ",
          h("code", {}, "extension"),
          " and ",
          h("code", {}, "bridge"),
          ") and run:",
          h(
            "div",
            { class: "row", style: { marginTop: "4px", flexWrap: "nowrap" } },
            h("code", { style: { flex: 1, padding: "6px 8px", background: "var(--bg)", borderRadius: "6px", border: "1px solid var(--border)" } }, cmd),
            h(
              "button",
              {
                class: "btn ghost",
                onclick: async () => {
                  await navigator.clipboard.writeText(cmd);
                  toast("Copied");
                },
              },
              "Copy"
            )
          ),
          h("div", { class: "muted", style: { marginTop: "4px" } }, "Needs Node.js (nodejs.org). Or just ask Claude Code to run that command for you.")
        ),
        h("li", {}, "Restart the browser, then click Save & test.")
      ),
      h(
        "label",
        { class: "field" },
        h("span", {}, "Model"),
        h("select", { onchange: (e) => ((st.ccModel = e.target.value), saveSettings()) }, AI.CC_MODELS.map((m) => h("option", { value: m.id, selected: (st.ccModel || "default") === m.id }, m.label)))
      ),
    ];
  } else {
    const keyField = usingOpenAI ? "openaiApiKey" : "apiKey";
    const modelField = usingOpenAI ? "openaiModel" : "model";
    const models = usingOpenAI ? AI.OPENAI_MODELS : AI.MODELS;
    const keysUrl = usingOpenAI ? "https://platform.openai.com/api-keys" : "https://console.anthropic.com/settings/keys";
    const keyInput = h("input", { type: "password", value: st[keyField], placeholder: usingOpenAI ? "sk-…" : "sk-ant-…", autocomplete: "off", oninput: (e) => {
      st[keyField] = e.target.value.trim();
      st.aiVerified = false;
      saveSettings();
    } });
    body = [
      h(
        "ol",
        { class: "small", style: { paddingLeft: "18px", margin: "0 0 10px" } },
        h("li", {}, "Go to ", h("a", { href: keysUrl, target: "_blank" }, usingOpenAI ? "platform.openai.com → API keys" : "console.anthropic.com → API Keys"), " and create a key."),
        h("li", {}, "Add a few dollars of credit under Billing."),
        h("li", {}, "Paste the key below and click Save & test.")
      ),
      h(
        "label",
        { class: "field" },
        h("span", {}, "API key (stored only in this browser)"),
        h(
          "div",
          { class: "row", style: { flexWrap: "nowrap" } },
          keyInput,
          h("button", { class: "btn ghost", onclick: () => (keyInput.type = keyInput.type === "password" ? "text" : "password") }, "Show")
        )
      ),
      h(
        "label",
        { class: "field" },
        h("span", {}, "Model"),
        h("select", { onchange: (e) => { st[modelField] = e.target.value; st.aiVerified = false; saveSettings(); } }, models.map((m) => h("option", { value: m.id, selected: st[modelField] === m.id }, m.label)))
      ),
    ];
  }

  const aiCard = h("div", { class: "card", id: "card-ai" }, h("h3", {}, "Connect AI"), providerPick, body, h("div", { class: "row" }, testButton, status));

  const pf = (key, label, placeholder = "") =>
    h("label", { class: "field" }, h("span", {}, label), h("input", { type: "text", value: p[key] || "", placeholder, oninput: (e) => ((p[key] = e.target.value), saveProfile()) }));
  const sel = (key, label, options) =>
    h("label", { class: "field" }, h("span", {}, label), h("select", { onchange: (e) => ((p[key] = e.target.value), saveProfile()) }, options.map(([v, t]) => h("option", { value: v, selected: p[key] === v }, t))));
  const eeo = (key, label) => {
    const listId = `dl-${key}`;
    return h(
      "label",
      { class: "field" },
      h("span", {}, label),
      h("input", { type: "text", list: listId, value: p[key] || "", oninput: (e) => ((p[key] = e.target.value), saveProfile()) }),
      h("datalist", { id: listId }, EEO[key].map((o) => h("option", { value: o })))
    );
  };

  const profileCard = h(
    "div",
    { class: "card", id: "card-profile" },
    h("h3", {}, "Application profile"),
    h("p", { class: "small muted" }, "Used to autofill forms. Filled in automatically when your resume is parsed, so check it over."),
    h("div", { class: "grid2" }, pf("firstName", "First name"), pf("lastName", "Last name")),
    h("div", { class: "grid2" }, pf("preferredName", "Preferred name"), pf("pronouns", "Pronouns", "optional")),
    h("div", { class: "grid2" }, pf("email", "Email"), pf("phone", "Phone")),
    pf("linkedin", "LinkedIn URL", "https://linkedin.com/in/…"),
    h("div", { class: "grid2" }, pf("github", "GitHub URL"), pf("website", "Portfolio / website")),
    pf("address", "Street address", "optional"),
    h("div", { class: "grid2" }, pf("city", "City"), pf("state", "State")),
    h("div", { class: "grid2" }, pf("zip", "ZIP"), pf("country", "Country")),
    hr(),
    pf("school", "School"),
    h("div", { class: "grid2" }, pf("degree", "Degree", "Bachelor of Science"), pf("major", "Major")),
    h("div", { class: "grid2" }, pf("gradMonth", "Graduation month", "May"), pf("gradYear", "Graduation year", "2028")),
    h(
      "details",
      { open: !!(p.gradEarliest || p.gradLatest) },
      h("summary", { class: "small" }, "Flexible graduation date"),
      h("p", { class: "small muted", style: { margin: "6px 0" } }, "If you could graduate any time in a range (e.g. by credits, Dec 2028, or on the normal track, May 2030), set it here. For each job, tailoring picks the date in this range that the posting asks for, puts it on that resume's Education line, and uses it for that application's graduation questions. Jobs that don't say keep the date above."),
      h("div", { class: "grid2" }, pf("gradEarliest", "Earliest", "December 2028"), pf("gradLatest", "Latest", "May 2030"))
    ),
    h("div", { class: "grid2" }, pf("gpa", "GPA", "optional"), pf("availableStart", "Available to start", "May 2027")),
    h("div", { class: "grid2" }, pf("schoolStart", "Started school", "August 2026"), h("div")),
    h("div", { class: "grid2" }, pf("currentCompany", "Current company", "defaults to school"), pf("currentTitle", "Current title"))
  );

  const answersCard = h(
    "div",
    { class: "card" },
    h("h3", {}, "Standard answers"),
    h(
      "label",
      { class: "field" },
      h("span", {}, "U.S. work status (decides which jobs you can apply to)"),
      h(
        "select",
        {
          onchange: (e) => {
            p.workStatus = e.target.value;
            Object.assign(p, E.authAnswersFor(p.workStatus) || {});
            saveProfile();
            renderSettings();
          },
        },
        E.WORK_STATUSES.map(([v, t]) => h("option", { value: v, selected: (p.workStatus || "") === v }, t))
      ),
      !p.workStatus ? h("div", { class: "small muted" }, "Set this so JobPilot can mark jobs that require citizenship, work authorization or no sponsorship.") : null
    ),
    h("div", { class: "grid2" }, sel("workAuthorized", "Authorized to work in the US?", YES_NO), sel("needsSponsorship", "Need visa sponsorship?", YES_NO)),
    sel("clearance", "Active U.S. security clearance?", YES_NO),
    h("div", { class: "grid2" }, sel("over18", "18 or older?", YES_NO), sel("willingToRelocate", "Willing to relocate?", YES_NO)),
    pf("howHeard", "How did you hear about us?", "Job board"),
    pf("salaryExpectation", "Pay expectation (blank = you'll be asked)", "e.g. $40/hr or Open to discussion"),
    h("details", {}, h("summary", { class: "small" }, "Voluntary self-identification (EEO)"), h("div", { style: { marginTop: "8px" } }, eeo("gender", "Gender"), eeo("race", "Race / ethnicity"), eeo("hispanic", "Hispanic or Latino?"), eeo("veteran", "Veteran status"), eeo("disability", "Disability status")))
  );

  const preview = h("div", { class: "small muted" });
  const updatePreview = () => (preview.textContent = `e.g. ${R.fileNameFor(st.fileNamePattern, S.base, p, "Stripe", "Software Engineer Intern")}`);
  updatePreview();
  const filesCard = h(
    "div",
    { class: "card" },
    h("h3", {}, "Files & formatting"),
    h(
      "label",
      { class: "field" },
      h("span", {}, "PDF file name ({First} {Last} {Company} {Role})"),
      h("input", {
        type: "text",
        value: st.fileNamePattern,
        oninput: (e) => {
          st.fileNamePattern = e.target.value;
          saveSettings();
          updatePreview();
        },
      }),
      preview
    ),
    h(
      "label",
      { class: "field" },
      h("span", {}, "Resume PDF (Jake's Resume template)"),
      h(
        "select",
        {
          onchange: (e) => {
            st.renderer = e.target.value;
            resetLatexStatus();
            saveSettings();
          },
        },
        [
          ["latex", "Compile with LaTeX on my computer when available (exact)"],
          ["built-in", "Always use the built-in renderer (faster)"],
        ].map(([v, t]) => h("option", { value: v, selected: (st.renderer || "latex") === v }, t))
      ),
      h("div", { class: "small muted" }, "LaTeX compiling needs the Claude Code bridge plus a TeX install (MacTeX, MiKTeX, TeX Live or Tectonic). Without it, JobPilot draws the same layout itself in Computer Modern.")
    ),
    h(
      "label",
      { class: "field" },
      h("span", {}, "When a job isn't tailored, attach"),
      h(
        "select",
        { onchange: (e) => ((st.attachWhenUntailored = e.target.value), saveSettings()) },
        [
          ["generated", "PDF generated from my edited boxes"],
          ["original", "My original uploaded PDF"],
        ].map(([v, t]) => h("option", { value: v, selected: st.attachWhenUntailored === v }, t))
      )
    ),
    h(
      "label",
      { class: "field" },
      h("span", {}, "Cover letter (written in Resume → Cover letter)"),
      h(
        "select",
        { onchange: (e) => ((st.coverAttach = e.target.value), saveSettings()) },
        [
          ["any", "Attach it whenever the form has a cover letter field"],
          ["required", "Only when the cover letter is required"],
          ["off", "Never attach"],
        ].map(([v, t]) => h("option", { value: v, selected: (st.coverAttach || "any") === v }, t))
      )
    ),
    h("div", { class: "small muted" }, "Downloads go to Downloads/Resumes/ and replace older files with the same name, so you won't end up with \"Resume (100).pdf\".")
  );

  const newSrc = h("input", { type: "text", placeholder: "owner/repo or GitHub URL" });
  const sourceCard = h(
    "div",
    { class: "card" },
    h("h3", {}, "Job sources (GitHub repos)"),
    h("p", { class: "small muted" }, "Any internship list repo works: SimplifyJobs-style listings.json or a README table. Jobs are merged and de-duplicated."),
    st.sources.map((src) =>
      h(
        "div",
        { class: "row small", style: { margin: "4px 0" } },
        h("input", {
          type: "checkbox",
          checked: src.enabled,
          onchange: (e) => {
            src.enabled = e.target.checked;
            saveSettings();
          },
        }),
        h("span", { style: { flex: 1 } }, src.label),
        h(
          "button",
          {
            class: "icon",
            title: "Remove",
            onclick: () => {
              st.sources = st.sources.filter((x) => x !== src);
              saveSettings();
              renderSettings();
            },
          },
          "✕"
        )
      )
    ),
    h(
      "div",
      { class: "row", style: { marginTop: "6px", flexWrap: "nowrap" } },
      newSrc,
      h(
        "button",
        {
          class: "btn",
          onclick: async (e) => {
            const input = newSrc.value.trim();
            if (!Sources.describeSource(input)) return toast("Enter owner/repo or a GitHub URL.", true);
            e.target.disabled = true;
            try {
              const items = await Sources.fetchSource({ input });
              st.sources.push({ id: `src-${Date.now()}`, label: input.replace(/^https?:\/\/(www\.)?github\.com\//, ""), input, enabled: true });
              await persist("settings", st);
              toast(`Added: ${items.length} open jobs found.`);
              renderSettings();
              refreshJobList();
            } catch (err) {
              toast(`Couldn't read that repo: ${err.message}`, true);
            } finally {
              e.target.disabled = false;
            }
          },
        },
        "Add"
      )
    )
  );

  const ap = st.autopilot;
  const apNum = (k, label, opts) => h("label", { class: "field" }, h("span", {}, label), h("select", { onchange: (e) => ((ap[k] = Number(e.target.value)), saveSettings()) }, opts.map(([v, t]) => h("option", { value: v, selected: ap[k] === v }, t))));
  const apBool = (k, label) => h("label", { class: "row small", style: { margin: "6px 0" } }, h("input", { type: "checkbox", checked: ap[k], onchange: (e) => ((ap[k] = e.target.checked), saveSettings()) }), label);
  const autopilotCard = h(
    "div",
    { class: "card" },
    h("h3", {}, "Autopilot"),
    apBool("autoSubmit", "Submit automatically when every answer came from my profile or my own saved answers"),
    apBool("tailor", "Tailor the resume for each job"),
    apBool("notify", "Notify me about new matching jobs"),
    apNum("concurrency", "Jobs at once", [1, 2, 3, 4].map((n) => [n, String(n)])),
    apNum("maxAgeDays", "Only apply to jobs posted in the last", [
      [3, "3 days"],
      [7, "7 days"],
      [14, "14 days"],
      [30, "30 days"],
    ]),
    apNum("pauseSec", "Pause between applications (randomized)", [
      [0, "None"],
      [15, "About 15 seconds"],
      [30, "About 30 seconds"],
      [60, "About a minute"],
      [180, "About 3 minutes"],
    ]),
    apBool("ownTab", "Run in a pinned JobPilot tab, so I can close the side panel"),
    apNum("refreshHours", "Check repos for new jobs", [
      [0, "Off"],
      [1, "Every hour"],
      [3, "Every 3 hours"],
      [6, "Every 6 hours"],
      [12, "Every 12 hours"],
    ])
  );

  const updateStatus = h("span", { class: "small" });
  const updatesCard = h(
    "div",
    { class: "card" },
    h("h3", {}, "Updates"),
    h(
      "p",
      { class: "small muted" },
      "JobPilot updates from a GitHub repo. One-click updates need a ",
      h("code", {}, "git clone"),
      " of the repo plus the Claude Code bridge installed from inside it; otherwise you'll get a notice with instructions."
    ),
    h(
      "div",
      { class: "grid2" },
      h("label", { class: "field" }, h("span", {}, "Repo (owner/name)"), h("input", { type: "text", value: st.updateRepo, oninput: (e) => ((st.updateRepo = e.target.value.trim()), saveSettings()) })),
      h("label", { class: "field" }, h("span", {}, "Branch"), h("input", { type: "text", value: st.updateBranch, oninput: (e) => ((st.updateBranch = e.target.value.trim()), saveSettings()) }))
    ),
    h(
      "label",
      { class: "field" },
      h("span", {}, "When there's an update"),
      h(
        "select",
        { onchange: (e) => ((st.autoUpdate = e.target.value), saveSettings()) },
        [
          ["auto", "Install it automatically when the browser starts"],
          ["ask", "Show a notice and let me click Update"],
          ["off", "Don't check"],
        ].map(([v, t]) => h("option", { value: v, selected: st.autoUpdate === v }, t))
      )
    ),
    h(
      "div",
      { class: "row" },
      h(
        "button",
        {
          class: "btn",
          onclick: async (e) => {
            e.target.disabled = true;
            updateStatus.replaceChildren(spinner(), " Checking…");
            try {
              await persist("settings", st);
              const r = await Update.checkForUpdate(st);
              updateStatus.replaceChildren(h("span", { class: `pill ${r.available ? "warn" : "good"}` }, r.detail));
              renderUpdateBanner(r);
            } catch (err) {
              updateStatus.replaceChildren(h("span", { class: "pill bad", style: { whiteSpace: "normal" } }, err.message));
            } finally {
              e.target.disabled = false;
            }
          },
        },
        "Check now"
      ),
      h("span", { class: "small muted" }, `v${chrome.runtime.getManifest().version}`),
      updateStatus
    )
  );

  const dataCard = h(
    "div",
    { class: "card" },
    h("h3", {}, "Your data"),
    h("p", { class: "small muted" }, "Everything (resume, profile, API key, applied list) is stored locally in this Chrome profile. It's sent only to Anthropic when you use an AI feature."),
    h(
      "button",
      {
        class: "btn danger",
        onclick: async () => {
          if (!confirm("Delete your resume, profile, API key, tailored versions and applied list from this browser?")) return;
          await chrome.storage.local.clear();
          location.reload();
        },
      },
      "Erase all data"
    )
  );

  const instructionsCard = h(
    "div",
    { class: "card" },
    h("h3", {}, "Instructions for AI"),
    h("p", { class: "small muted" }, "Things AI should always do when filling applications and tailoring, one per line. Feedback you mark \"Remember\" lands here."),
    textarea({ rows: 3, value: st.instructions || "", placeholder: "e.g. For internship vs co-op questions, pick the summer internship.", oninput: (e) => ((st.instructions = e.target.value), saveSettings()) })
  );

  const tg = st.target;
  const list = (key) =>
    textarea({
      rows: 2,
      value: (tg[key] || []).join(", "),
      oninput: debounce((e) => {
        tg[key] = e.target.value.split(",").map((x) => x.trim().toLowerCase()).filter(Boolean);
        saveSettings();
      }, 300),
    });
  const targetCard = h(
    "div",
    { class: "card", id: "card-target" },
    h("h3", {}, "What jobs to look for"),
    h("p", { class: "small muted" }, tg.summary || "AI reads your resume and decides which roles fit: the fields, the degree level, and what to rule out. Every listing is then scored against this without AI."),
    h(
      "div",
      { class: "chips", style: { margin: "6px 0" } },
      Fit.CATEGORIES.map((c) =>
        h(
          "button",
          {
            class: `pill${tg.categories.includes(c) ? " good" : ""}`,
            style: { cursor: "pointer" },
            onclick: () => {
              tg.categories = tg.categories.includes(c) ? tg.categories.filter((x) => x !== c) : [...tg.categories, c];
              saveSettings();
              renderSettings();
            },
          },
          c
        )
      )
    ),
    h("label", { class: "field" }, h("span", {}, "Good fit if the title mentions"), list("include")),
    h("label", { class: "field" }, h("span", {}, "Not a fit if the title mentions"), list("exclude")),
    h(
      "label",
      { class: "field" },
      h("span", {}, "Degree you're pursuing (roles only for other degrees are hidden)"),
      h("select", { onchange: (e) => ((tg.degree = e.target.value), saveSettings()) }, ["Bachelor's", "Master's", "PhD"].map((d) => h("option", { value: d, selected: tg.degree === d }, d)))
    ),
    h("div", { class: "small muted", style: { marginBottom: "6px" } }, "Terms that have already started (e.g. a Fall 2026 co-op in October 2026) are hidden too."),
    h(
      "button",
      { class: "btn", disabled: !aiReady() || !hasContent(S.base), onclick: () => withBusy("target", () => buildTargetFromResume(), renderSettings) },
      S.busy.target ? [spinner(), " Reading your resume…"] : tg.builtAt ? "Re-read my resume" : "Read my resume"
    )
  );

  el.replaceChildren(...[setupGuide()].filter(Boolean), aiCard, profileCard, targetCard, accountsCard(), answersCard, bankCard(), instructionsCard, autopilotCard, sourceCard, filesCard, updatesCard, dataCard);
}

function hr() {
  return h("hr");
}

// --------------------------------------------------------------- updates

function renderUpdateBanner(status) {
  document.querySelector("#update-banner")?.remove();
  if (!status?.available || S.settings.autoUpdate === "off") return;
  const banner = h(
    "div",
    { id: "update-banner", class: "card", style: { margin: "8px 12px 0", borderColor: "var(--accent)" } },
    h("div", { class: "small", style: { fontWeight: 600 } }, status.restartOnly ? `JobPilot was updated · ${status.detail}` : `JobPilot update available · ${status.detail}`),
    status.canAutoUpdate
      ? h(
          "div",
          { class: "row", style: { marginTop: "6px" } },
          h(
            "button",
            {
              class: "btn primary",
              onclick: async (e) => {
                e.target.disabled = true;
                e.target.textContent = "Updating…";
                try {
                  await Update.applyUpdate(S.settings); // reloads the extension
                } catch (err) {
                  toast(err.message, true);
                  e.target.disabled = false;
                  e.target.textContent = "Update now";
                }
              },
            },
            status.restartOnly ? "Restart now" : "Update now"
          ),
          h("span", { class: "small muted" }, "The panel will close; reopen it after.")
        )
      : h(
          "div",
          { class: "small muted", style: { marginTop: "4px" } },
          "Run ",
          h("code", {}, "git pull"),
          " in your JobPilot folder (or download the ZIP again from ",
          h("a", { href: Update.repoUrl(S.settings), target: "_blank" }, S.settings.updateRepo),
          "), then click reload on JobPilot in chrome://extensions."
        )
  );
  document.querySelector("main").before(banner);
}

renderApply = keepFocus(renderApply);
renderJobs = keepFocus(renderJobs);
renderResumeTab = keepFocus(renderResumeTab);
renderSettings = keepFocus(renderSettings);

// ------------------------------------------------------------------ init

async function init() {
  // The 5k-job cache is big: show the panel first, load it right after.
  const jobsPromise = Jobs.getJobs();
  const [settings, profile, base, resumePdf, tailored, applied, cover, bank, eligStore, saved, accounts] = await Promise.all([
    store.getSettings(),
    store.getProfile(),
    store.get("resume", null),
    store.get("resumePdf", null),
    store.get("tailored", {}),
    store.get("applied", {}),
    store.get("coverLetter", null),
    store.get("answerBank", null),
    store.get("eligCache", {}),
    store.get("saved", {}),
    store.get("accounts", {}),
  ]).then((r) => ((r[6] = { ...C.DEFAULT_COVER, ...(r[6] || {}) }), (r[7] = r[7] || C.DEFAULT_BANK.map((b) => ({ ...b }))), r));
  Object.assign(S, { settings, profile, base, resumePdf, tailored, applied, cover, bank, saved, accounts });
  // Simplify eligibility data younger than a week.
  for (const [id, e] of Object.entries(eligStore || {})) if (Date.now() - e.at < ELIG_TTL) (S.eligStore[id] = e), (S.eligSignals[id] = e.signals);
  jobsPromise.then((jobsCache) => {
    S.jobsLoaded = true;
    if (!S.jobsCache.fetchedAt || jobsCache.fetchedAt > S.jobsCache.fetchedAt) S.jobsCache = withKeys(jobsCache);
    refreshContext();
    if (S.activeTab === "jobs") renderJobs();
    // Refresh in the background if it's stale (>6h).
    if (Date.now() - jobsCache.fetchedAt > 6 * 3600 * 1000) {
      Jobs.refreshJobs(settings.sources)
        .then((c) => {
          S.jobsCache = withKeys(c);
          if (S.activeTab === "jobs") renderJobs();
        })
        .catch(() => {});
    }
  });
  S.queue = (await store.get("autopilotQueue", [])).map((i) => (i.status === "running" ? { ...i, status: "queued", note: "" } : i));
  loadFonts(); // in the background; PDF building awaits it

  document.querySelectorAll(".tabs button").forEach((b) => b.addEventListener("click", () => switchTab(b.dataset.tab)));

  chrome.tabs.onActivated.addListener(refreshContext);
  chrome.tabs.onUpdated.addListener((tabId, info) => {
    if (S.tab && tabId === S.tab.id && (info.url || info.status === "complete")) refreshContext();
  });
  chrome.windows?.onFocusChanged?.addListener(refreshContext);

  if (!settings.aiVerified && (settings.provider === "claude-code" || !AI.isConfigured(settings)) && !base && !resumePdf) S.activeTab = "settings";
  switchTab(S.activeTab);
  await refreshContext();

  if (settings.autoUpdate !== "off") {
    const last = await Update.lastStatus();
    renderUpdateBanner(last);
    // New files on disk (the folder Chrome loads from changed) or a stale check: look now.
    if (Update.restartPending(await Update.diskVersion()) || Update.isStale(last)) Update.checkForUpdate(settings).then(renderUpdateBanner).catch(() => {});
  }

  if (settings.provider === "chatgpt") await refreshChatGPT();

  // No job target yet but a resume is there: read it once in the background.
  if (!settings.target?.builtAt && hasContent(base) && aiReady()) buildTargetFromResume({ quiet: true }).catch(() => {});

  // Autopilot running in a pinned tab: start it here once jobs are loaded.
  if (RUN_PARAM) {
    document.title = "JobPilot Autopilot";
    S.activeTab = "jobs";
    switchTab("jobs");
    await persist("autopilotStop", false);
    const jobs = await jobsPromise;
    if (!S.jobsCache.fetchedAt) S.jobsCache = withKeys(jobs);
    startAutopilot(Number(RUN_PARAM));
  }

  // Follow a run in the other JobPilot page (panel <-> pinned tab).
  // Changes from other JobPilot pages (pinned Autopilot tab, background
  // worker, another panel) show up here right away.
  const SYNC = {
    settings: (v) => (S.settings = { ...S.settings, ...v }),
    profile: (v) => (S.profile = { ...S.profile, ...v }),
    resume: (v) => (S.base = v),
    tailored: (v) => (S.tailored = v || {}),
    applied: (v) => (S.applied = v || {}),
    saved: (v) => (S.saved = v || {}),
    accounts: (v) => (S.accounts = v || {}),
    coverLetter: (v) => (S.cover = { ...C.DEFAULT_COVER, ...(v || {}) }),
    answerBank: (v) => (S.bank = v || []),
    autopilotQueue: (v) => !S.autopilotRunning && (S.queue = v || []),
    jobsCache: (v) => v && (S.jobsCache = withKeys(v)),
    updateStatus: (v) => renderUpdateBanner(v),
  };
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    if (changes.autopilotStop?.newValue && S.autopilotRunning) S.stopAutopilot = true;
    let changed = false;
    for (const [key, { newValue }] of Object.entries(changes)) {
      if (!SYNC[key]) continue;
      let json;
      try {
        json = JSON.stringify(newValue);
      } catch {}
      if (json !== undefined && json === lastWritten.get(key)) continue; // our own write
      SYNC[key](newValue);
      changed = true;
    }
    if (changed) invalidate();
  });
}

init();
