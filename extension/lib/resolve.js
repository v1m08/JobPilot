// "Autofill where it can, then ask AI when it gets stuck."
//
// After the rule-based fill, the fields still empty go to one short AI
// call (ai.js resolveFields). What happens next depends on what the answer is:
//   fact        -> filled (green): an option or value straight from your profile
//   preference  -> filled as a draft (purple): a choice you should glance at
//   writing     -> skipped (amber): needs your own words; a fully AI-written
//                  answer submitted as yours would look bad
//   unknown     -> skipped (amber)
import * as Page from "./page.js";
import { resolveFields, applyFeedback } from "./ai.js";

const isText = (q) => q.kind === "short_text" || q.kind === "long_text";

// -> { filled: [{ label, value }], drafted: [...], skipped: [{ label, reason }] }
export async function resolveStuck(tab, { settings, profile, resumeText, posting = "", instructions = "" }) {
  const fields = await Page.collectQuestions(tab, { stuck: true, profile });
  const result = { filled: [], drafted: [], skipped: [] };
  // Essays never go through this step: they're for "Draft answers" with review.
  const ask = fields.filter((q) => q.kind !== "long_text");
  for (const q of fields) if (q.kind === "long_text" && q.required) result.skipped.push({ label: q.question.slice(0, 80), reason: "Needs your own words (use Draft answers to start one)" });
  if (!ask.length) return result;

  const answers = await resolveFields(settings, { fields: ask, profile, resumeText, posting, instructions });
  const byId = Object.fromEntries(ask.map((q) => [q.qid, q]));
  const toFill = [];
  for (const a of answers) {
    const q = byId[a.qid];
    if (!q) continue;
    const values = (a.answer || []).map((v) => String(v).trim()).filter(Boolean);
    const label = q.question.slice(0, 80);
    if (!values.length || a.basis === "writing" || a.basis === "unknown" || (a.basis === "preference" && isText(q))) {
      if (q.required) result.skipped.push({ label, reason: a.basis === "unknown" ? "AI doesn't have this information" : "Needs your own words" });
      continue;
    }
    const fact = a.basis === "fact";
    toFill.push({ qid: q.qid, answer: q.kind === "multi_choice" || q.kind === "dropdown" ? values : values[0], mark: fact ? "filled" : "draft", note: fact ? "matched by AI from your profile" : "AI's pick — check it" });
    (fact ? result.filled : result.drafted).push({ label, value: values.join(", ") });
  }
  if (toFill.length) await Page.fillAnswers(tab, toFill);
  return result;
}

// After Submit: fields the site rejected ("Enter a valid phone number").
// AI reads the error and the current value and fixes facts or formats;
// it never writes your own-words answers here either. -> number fixed
export async function fixInvalid(tab, { settings, profile, resumeText, posting = "", instructions = "" }) {
  const lists = await Page.callAll(tab, "invalidFields");
  const bad = lists.flat().filter((q) => q.kind !== "long_text");
  if (!bad.length) return 0;
  const fields = bad.map((q) => ({ ...q, question: `${q.question} (the site says: "${q.error}"; current value: "${q.value}")` }));
  const answers = await resolveFields(settings, { fields, profile, resumeText, posting, instructions });
  const byId = Object.fromEntries(bad.map((q) => [q.qid, q]));
  const toFill = [];
  for (const a of answers) {
    const q = byId[a.qid];
    const values = (a.answer || []).map((v) => String(v).trim()).filter(Boolean);
    if (!q || !values.length || a.basis === "writing" || a.basis === "unknown") continue;
    toFill.push({ qid: q.qid, answer: q.kind === "dropdown" ? values : values[0], mark: a.basis === "fact" ? "filled" : "draft", note: `fixed after the site said: ${q.error}` });
  }
  return toFill.length ? Page.fillAnswers(tab, toFill) : 0;
}

// "You made mistakes, here's what to change": AI edits only the fields
// your feedback is about. -> { changed: [{ label, from, to }], note }
export async function fixWithFeedback(tab, { settings, profile, resumeText, posting = "", instructions = "" }, feedback) {
  const fields = (await Page.callAll(tab, "snapshotFields")).flat();
  if (!fields.length) return { changed: [], note: "No form fields on this page." };
  const out = await applyFeedback(settings, { fields, feedback, instructions, profile, resumeText, posting });
  const byId = Object.fromEntries(fields.map((q) => [q.qid, q]));
  const toFill = [];
  const changed = [];
  for (const c of out.changes || []) {
    const q = byId[c.qid];
    const values = (c.answer || []).map((v) => String(v).trim()).filter(Boolean);
    if (!q || !values.length) continue;
    // Text fields only take text you wrote in the feedback (or plain facts).
    if (/text/.test(q.kind) && c.basis === "preference") continue;
    const to = values.join(", ");
    if (to === q.value) continue;
    toFill.push({ qid: q.qid, answer: /multi|dropdown/.test(q.kind) ? values : values[0], replace: true, mark: c.basis === "preference" ? "draft" : "filled", note: "changed from your feedback" });
    changed.push({ label: q.question.slice(0, 80), from: q.value || "(empty)", to });
  }
  if (toFill.length) await Page.fillAnswers(tab, toFill);
  return { changed, note: out.note || "" };
}
