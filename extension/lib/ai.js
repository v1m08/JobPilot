// Provider-independent AI calls: resume parsing and per-job rewrites + answers.
import { Anthropic } from "../vendor/anthropic.js";
import { callOpenAI, DEFAULT_OPENAI_MODEL } from "./openai.js";
export { OPENAI_MODELS } from "./openai.js";

export function isConfigured(settings) {
  if (settings.provider === "claude-code") return true;
  if (settings.provider === "chatgpt") return !!settings.chatgptAccountId && !!settings.chatgptModel && settings.chatgptPlanEnabled === true;
  if (settings.provider === "openai") return !!settings.openaiApiKey?.trim();
  return !!settings.apiKey?.trim();
}

export const MODELS = [
  { id: "claude-sonnet-5-5", label: "Claude Sonnet 5.5 (fast, recommended)" },
  { id: "claude-haiku-4-5", label: "Claude Haiku 4.5 (fastest, cheapest)" },
  { id: "claude-opus-5-5", label: "Claude Opus 5.5 (best writing, slower)" },
];

// Models that accept the server-side refusal fallback.
const FALLBACK_MODELS = new Set(["claude-opus-5-5", "claude-sonnet-5-5"]);

// Strict JSON schema helpers: every property required, no extras.
const str = { type: "string" };
const arr = (items) => ({ type: "array", items });
const obj = (properties) => ({ type: "object", properties, required: Object.keys(properties), additionalProperties: false });

function makeClient(settings) {
  if (!settings.apiKey) throw new Error("Add your Anthropic API key in Settings first.");
  return new Anthropic({ apiKey: settings.apiKey, dangerouslyAllowBrowser: true, maxRetries: 2 });
}

function friendly(err) {
  if (err instanceof Anthropic.AuthenticationError) return new Error("Your API key was rejected. Check it in Settings.");
  if (err instanceof Anthropic.PermissionDeniedError) return new Error("This API key doesn't have access to that model. Try another model in Settings.");
  if (err instanceof Anthropic.NotFoundError) return new Error("Model not found. Pick a different model in Settings.");
  if (err instanceof Anthropic.RateLimitError) return new Error("Rate limited by the API. Wait a minute and try again.");
  if (err instanceof Anthropic.BadRequestError) {
    const msg = err.error?.error?.message || err.message;
    if (/credit balance/i.test(msg)) return new Error("Your Anthropic account is out of credits. Add credits at console.anthropic.com → Billing.");
    return new Error(`The API rejected the request: ${msg}`);
  }
  if (err instanceof Anthropic.InternalServerError) return new Error("Anthropic's API had a server error. Try again in a moment.");
  if (err instanceof Anthropic.APIConnectionError) return new Error("Couldn't reach the Anthropic API. Check your internet connection.");
  return err;
}

// ------------------------------------------------- Claude Code bridge

export const BRIDGE_HOST = "com.jobpilot.claude_bridge";

export const CC_MODELS = [
  { id: "sonnet", label: "Sonnet (fast, recommended)" },
  { id: "haiku", label: "Haiku (fastest)" },
  { id: "opus", label: "Opus (best writing, slower, uses limits faster)" },
  { id: "default", label: "Your Claude Code default" },
];

export function bridge(msg) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendNativeMessage(BRIDGE_HOST, msg, (resp) => {
      const err = chrome.runtime.lastError;
      if (err) {
        const m = err.message || "";
        if (/not found|forbidden|not allowed/i.test(m)) {
          return reject(new Error("The JobPilot bridge isn't installed yet. Run `node bridge/install.js`, restart the browser, then open Settings → Connect AI."));
        }
        if (/exited/i.test(m)) return reject(new Error("The JobPilot bridge stopped unexpectedly. Re-run `node bridge/install.js`, then try again."));
        return reject(new Error(`Bridge error: ${m}`));
      }
      if (!resp) return reject(new Error("No response from the JobPilot bridge."));
      if (!resp.ok) {
        const e = new Error(/Unknown request type: chatgpt/.test(resp.error || "") ? "Update the JobPilot bridge: run `node bridge/install.js` again, then restart the browser." : resp.error || "JobPilot bridge failed.");
        e.code = resp.code;
        e.status = resp.status;
        if (e.code === "subscription_sharing_usage_limit_exceeded") chrome.storage.local.set({ autopilotStop: true }).catch(() => {});
        return reject(e);
      }
      resolve(resp);
    });
  });
}

async function callViaClaudeCode(settings, { system, content, schema, effort }) {
  let prompt = "";
  let pdfBase64;
  for (const part of typeof content === "string" ? [{ type: "text", text: content }] : content) {
    if (part.type === "document") pdfBase64 = part.source.data;
    if (part.type === "text") prompt += part.text;
  }
  const resp = await bridge({ type: "run", system, prompt, schema, model: settings.ccModel || "sonnet", effort, pdfBase64 });
  return resp.data;
}

export async function pingBridge() {
  return bridge({ type: "ping" });
}

export const chatGPTStatus = async () => (await bridge({ type: "chatgpt-status" })).session;
export const chatGPTModels = async (accountId) => (await bridge({ type: "chatgpt-models", accountId })).models;
export const selectChatGPTAccount = async (accountId) => (await bridge({ type: "chatgpt-select", accountId })).session;
export const signOutChatGPT = async (accountId) => (await bridge({ type: "chatgpt-sign-out", accountId })).session;

let signInPort;
export function cancelChatGPTSignIn() { signInPort?.disconnect(); }
export function signInChatGPT(accountId, consent = false) {
  if (signInPort) return Promise.reject(new Error("A ChatGPT sign-in is already running."));
  return new Promise((resolve, reject) => {
    const port = chrome.runtime.connectNative(BRIDGE_HOST);
    signInPort = port;
    let settled = false;
    function finish(error, session) {
      if (settled) return;
      settled = true;
      signInPort = null;
      port.disconnect();
      if (error) reject(error); else resolve(session);
    }
    port.onDisconnect.addListener(() => {
      const message = chrome.runtime.lastError?.message;
      finish(new Error(message ? `JobPilot bridge disconnected: ${message}. Re-run node bridge/install.js if needed.` : "ChatGPT sign-in cancelled."));
    });
    port.onMessage.addListener((response) => {
      if (response.event === "chatgpt-authorize") {
        try {
          const url = new URL(response.url);
          if (url.origin !== "https://auth.openai.com" || url.pathname !== "/api/accounts/authorize") throw new Error("Unexpected ChatGPT sign-in URL.");
          chrome.tabs.create({ url: url.href }).catch((error) => finish(error));
        } catch (error) { finish(error); }
        return;
      }
      finish(response.ok ? null : new Error(response.error || "ChatGPT sign-in failed. Re-run the bridge installer if needed."), response.session);
    });
    port.postMessage({ type: "chatgpt-sign-in", accountId, consent });
  });
}

async function callViaChatGPT(settings, options) {
  const response = await bridge({ type: "chatgpt-run", accountId: settings.chatgptAccountId, model: settings.chatgptModel, options });
  return response.data;
}

// ------------------------------------------------------------- caching
// Same model + prompt + schema → same stored answer, so repeated work is
// instant and results stay consistent (current models don't accept a
// temperature setting, so caching is how we make them deterministic).

async function sha256(text) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

const CACHE_KEY = "aiCache";
const CACHE_MAX = 300;

async function cached(key, fn) {
  const store = (await chrome.storage.local.get(CACHE_KEY))[CACHE_KEY] || {};
  if (store[key]) return store[key].v;
  const v = await fn();
  const fresh = (await chrome.storage.local.get(CACHE_KEY))[CACHE_KEY] || {};
  fresh[key] = { v, t: Date.now() };
  const keys = Object.keys(fresh);
  if (keys.length > CACHE_MAX) keys.sort((a, b) => fresh[a].t - fresh[b].t).slice(0, keys.length - CACHE_MAX).forEach((k) => delete fresh[k]);
  await chrome.storage.local.set({ [CACHE_KEY]: fresh });
  return v;
}

function modelFor(settings) {
  if (settings.provider === "chatgpt") return `chatgpt:${settings.chatgptAccountId}:${settings.chatgptModel}`;
  if (settings.provider === "openai") return `openai:${settings.openaiModel || DEFAULT_OPENAI_MODEL}`;
  return settings.provider === "claude-code" ? `cc:${settings.ccModel || "sonnet"}` : `api:${settings.model}`;
}

async function callJSON(settings, opts) {
  if (!isConfigured(settings)) throw new Error("Connect AI in Settings first.");
  if (settings.provider === "chatgpt") {
    const session = await chatGPTStatus();
    if (!session.accounts.some((a) => a.id === settings.chatgptAccountId && a.planEnabled)) throw new Error("Continue with ChatGPT in Settings to enable plan usage.");
  }
  const key = await sha256(JSON.stringify([modelFor(settings), opts.system, opts.content, opts.schema, opts.effort, opts.maxTokens]));
  return cached(key, () => callJSONUncached(settings, opts));
}

async function callJSONUncached(settings, { system, content, schema, effort = "low", maxTokens = 16000 }) {
  if (settings.provider === "claude-code") return callViaClaudeCode(settings, { system, content, schema, effort });
  if (settings.provider === "chatgpt") return callViaChatGPT(settings, { system, content, schema, effort });
  if (settings.provider === "openai") return callOpenAI(settings, { system, content, schema, effort, maxTokens });
  const client = makeClient(settings);
  const params = {
    model: settings.model,
    max_tokens: maxTokens,
    system,
    messages: [{ role: "user", content }],
    output_config: { format: { type: "json_schema", schema } },
  };
  if (!settings.model.startsWith("claude-haiku")) params.output_config.effort = effort;

  let resp;
  try {
    resp = FALLBACK_MODELS.has(settings.model)
      ? await client.beta.messages.create({ ...params, fallbacks: "default", betas: ["server-side-fallback-2026-07-01"] })
      : await client.messages.create(params);
  } catch (e) {
    throw friendly(e);
  }
  if (resp.stop_reason === "refusal") throw new Error("The model declined this request. Try rephrasing or a different model.");
  if (resp.stop_reason === "max_tokens") throw new Error("The response was cut off (too long). Try again.");
  const text = resp.content.filter((b) => b.type === "text").map((b) => b.text).join("");
  try {
    return JSON.parse(text);
  } catch {
    throw new Error("The AI returned malformed data. Try again.");
  }
}

export async function testConnection(settings) {
  if (settings.provider === "chatgpt") {
    const r = await callViaChatGPT(settings, {
      system: "Reply in the requested JSON format.", content: 'Reply with ok set to "OK".',
      schema: obj({ ok: { type: "string", enum: ["OK"] } }),
    });
    if (r.ok !== "OK") throw new Error("ChatGPT returned an unexpected connection test response.");
    return r.ok;
  }
  if (settings.provider === "openai") {
    const r = await callOpenAI(settings, {
      system: "Reply in the requested JSON format.", content: 'Reply with ok set to "OK".',
      schema: obj({ ok: { type: "string", enum: ["OK"] } }), maxTokens: 2048,
    });
    if (r.ok !== "OK") throw new Error("OpenAI returned an unexpected connection test response.");
    return r.ok;
  }
  if (settings.provider === "claude-code") {
    const ping = await pingBridge();
    const r = await callViaClaudeCode(settings, {
      system: "Reply in the requested JSON format.",
      content: "Reply with ok set to \"OK\".",
      schema: obj({ ok: str }),
      effort: "low",
    });
    return `${r.ok || "OK"} · ${ping.claudeVersion} · ${ping.texEngine ? `LaTeX: ${ping.texEngine}` : ping.bridgeVersion >= "1.1.0" ? "no LaTeX found" : "re-run the bridge installer for LaTeX"}`;
  }
  const client = makeClient(settings);
  try {
    const params = { model: settings.model, max_tokens: 64, messages: [{ role: "user", content: "Reply with just: OK" }] };
    if (!settings.model.startsWith("claude-haiku")) params.output_config = { effort: "low" };
    const resp = await client.messages.create(params);
    return resp.content.filter((b) => b.type === "text").map((b) => b.text).join("").trim() || "OK";
  } catch (e) {
    throw friendly(e);
  }
}

// ------------------------------------------------------------------ parse

const PARSE_SCHEMA = obj({
  basics: obj({
    name: str,
    email: str,
    phone: str,
    location: str,
    links: arr(obj({ label: str, url: str })),
    contact_order: arr({ type: "string", enum: ["phone", "email", "location", "links"] }),
  }),
  summary: str,
  sections: arr(
    obj({
      title: str,
      kind: { type: "string", enum: ["entries", "lines", "text"] },
      layout: { type: "string", enum: ["heading", "inline", "row"] },
      heading_order: { type: "string", enum: ["org-first", "role-first"] },
      dates_position: { type: "string", enum: ["top", "bottom"] },
      entries: arr(obj({ title: str, subtitle: str, location: str, dates: str, link_label: str, link_url: str, org_is_link: { type: "boolean" }, bullets: arr(str) })),
      lines: arr(obj({ label: str, text: str })),
      text: str,
    })
  ),
  profile: obj({
    firstName: str,
    lastName: str,
    email: str,
    phone: str,
    linkedin: str,
    github: str,
    website: str,
    city: str,
    state: str,
    school: str,
    degree: str,
    major: str,
    gpa: str,
    gradMonth: str,
    gradYear: str,
  }),
});

const PARSE_SYSTEM = `You convert resumes into structured data for an editor that re-typesets them, so record both the content and how it is laid out. Transcribe faithfully: keep every section, entry and bullet in the original order with the original wording and punctuation. Do not summarize, merge, improve or invent anything.

Section kinds:
- "entries": Education, Experience, Projects, Leadership, Awards, etc. For every entry: title = the organization / school / project / award name; subtitle = the role / degree / tech stack / description; location; dates exactly as written (e.g. "May 2024 – Aug 2024"); bullets = each bullet point (empty for single-line rows).
- "lines": Skills-style sections made of "Label: items" rows (e.g. label "Languages", text "Python, Java"). If a row has no label, use an empty label.
- "text": a plain paragraph section.

Layout of an "entries" section (for other kinds use "heading", "org-first", "top"):
- layout "heading": each entry has two heading lines (bold first line, italic second line) with text on the right of both. heading_order "org-first" when the organization/school is on the bold first line and the role/degree below it; "role-first" when the role is on the first line. dates_position "top" when the dates are on the right of the first line (location on the second), "bottom" when the dates are on the second line (location on the first).
- layout "inline": one heading line per entry like "Name | tech stack" with dates or a link on the right (typical for projects). subtitle = the text after the "|".
- layout "row": one line per item with no bullets, like "Award Name – description ... 2025" (typical for awards). title = the bold part; subtitle = the rest exactly as written, starting with its separator (e.g. "– Full-ride scholarship" or ", Boy Scouts of America"); dates = the text on the right.

Links in entries: link_label = visible link text shown in the heading (e.g. "GitHub", "Demo"), otherwise "". link_url = that link's URL if you can see it, otherwise "". org_is_link = true when the organization/title text itself is underlined or hyperlinked.

Bold text inside bullets and lines: wrap it in double asterisks, e.g. "**Activities:** AI Safety Initiative". Don't mark text that is bold only because it's a heading or a "lines" label.

contact_order: the order of the items in the contact line under the name, e.g. ["location","phone","email","links"].
Fill unused fields with empty strings/arrays. summary is the resume's summary/objective paragraph if it has one, otherwise "". For links in basics, use full URLs (add https:// when missing) and short labels like "LinkedIn", "GitHub", "Portfolio".

profile: fields for job application forms, taken only from what the resume states (empty string when not stated). gradMonth is a full month name, gradYear four digits, for the most recent/expected degree. degree like "Bachelor of Science".`;

export async function parseResume(settings, pdfBase64) {
  return callJSON(settings, {
    system: PARSE_SYSTEM,
    content: [
      { type: "document", source: { type: "base64", media_type: "application/pdf", data: pdfBase64 } },
      { type: "text", text: "Convert this resume into the structured format." },
    ],
    schema: PARSE_SCHEMA,
    effort: "low",
  });
}

// ------------------------------------------- bullet rewrites + answers
// The only per-job AI step. Keywords, skills order, project order, page fit
// and standard questions are handled deterministically (keywords.js,
// answers.js); this call only rewords bullets and answers what's left, in
// one request to save Claude Code's per-call startup time.

const JOB_SCHEMA = obj({
  bullet_edits: arr(obj({ id: str, text: str })),
  answers: arr(obj({ qid: str, answer: str })),
  graduation_window: obj({ earliest: str, latest: str }),
  cover_hook: str,
  cover_edits: arr(obj({ id: str, text: str })),
  bank_matches: arr(obj({ qid: str, bank_id: str })),
});

const JOB_SYSTEM = `You help a student apply to one internship. Five tasks; any may come back empty.

1. bullet_edits: reword resume bullets so they use the posting's terminology where the SAME work truthfully fits. Only bullets that clearly improve; at most 6. Keep every number and fact; never add tools, skills, metrics or claims that aren't in the bullet or elsewhere in the resume; keep length similar (≤ ~110 characters); start with a strong past-tense verb; keep any **bold** markup. Use the given ids.

2. answers: answer each listed application question as the student, first person, using only facts from the resume and profile. short_text: a few words to one sentence. long_text: 80–150 words unless the question sets a length; connect the student's real experience to this company and role. single_choice / dropdown / multi_choice: reply with exactly one of the given options' text; for preference questions (team, location, interest area, shift) pick the option that best fits the resume and posting. Answer "" only for factual questions the resume and profile don't cover (e.g. a referrer's name, a specific date, an ID number).

3. graduation_window: the range of graduation dates the posting is open to, as "Month YYYY" (earliest and latest), worked out from its eligibility wording (e.g. "first-year students" for a Summer 2027 internship means graduating around May 2030; "rising seniors" means around May 2028). Use "" for an open end, and "" for both when the posting doesn't say.

4. Cover letter, only when a <cover_letter> block is given (otherwise cover_hook "" and cover_edits []). The student wrote the letter; you only fill a gap and polish.
   cover_hook: ONE sentence (at most 30 words) for the {Hook} spot in their "why" paragraph, naming something specific and real from the posting (a product, problem, team or technology) that connects to what the student says they care about. Plain, concrete wording; no flattery ("I admire", "industry-leading", "passionate", "excited to leverage"), no claims about the student beyond their own paragraphs, no em dashes. It is pasted where {Hook} sits in their "why" paragraph, so it must read naturally there (e.g. after "What draws me to {Company}:" start with "you…" or "the…", not the company's name again). "" if the posting gives nothing specific.
   cover_edits: optionally reword up to 2 of the given story paragraphs to use the posting's terms where the same work truthfully fits. Same rules as bullets: keep every fact and number, add no tools or skills, keep the student's voice and length. Omit paragraphs that are already fine.

5. bank_matches, only when an <answer_bank> is given (otherwise []): the student wrote these answers themselves. For each question that one of them genuinely answers (same intent, even if worded differently, e.g. "What excites you about this role?" ~ "Why do you want to work at {Company}?"), return its qid and the bank_id. A matched question needs no answer in "answers" (return "" there). Don't match when the question asks for something the bank answer doesn't cover.`;

// bullets: [{ id, text }]; questions: [{ qid, question, kind, options }]
// draftText: false = never write short_text/long_text answers (Autopilot);
// those are only covered by your answer bank.
export async function rewriteAndAnswer(settings, { bullets, keywords, posting, questions, resumeText, profile, company, role, cover = null, bank = [], draftText = true, instructions = "", feedback = "" }) {
  if (!bullets.length && !questions.length && !cover) return { bullet_edits: [], answers: [] };
  const content = [
    `<job company="${company || ""}" role="${role || ""}">\n${posting}\n</job>`,
    keywords.length ? `<posting_keywords_the_resume_already_has>${keywords.join(", ")}</posting_keywords_the_resume_already_has>` : "",
    bullets.length ? `<bullets>\n${JSON.stringify(bullets)}\n</bullets>` : "",
    cover ? `<cover_letter>\n${JSON.stringify(cover)}\n</cover_letter>` : "",
    instructionsBlock(instructions),
    feedback ? `<feedback_on_last_attempt>\nThe student reviewed your last attempt for this job and says: ${feedback}\nFollow it.\n</feedback_on_last_attempt>` : "",
    !draftText && questions.length ? "Don't write answers for short_text or long_text questions: return \"\" for them. Only bank_matches may cover them." : "",
    bank.length && questions.length ? `<answer_bank>\n${JSON.stringify(bank.map((b) => ({ bank_id: b.id, question: b.prompt, answer: b.text.slice(0, 600) })))}\n</answer_bank>` : "",
    questions.length ? `<resume>\n${resumeText}\n</resume>\n<profile>${JSON.stringify(profile)}</profile>\n<questions>\n${JSON.stringify(questions.map(({ qid, question, kind, options }) => ({ qid, question, kind, options })))}\n</questions>` : "",
  ]
    .filter(Boolean)
    .join("\n\n");
  const effort = questions.some((q) => q.kind === "long_text") ? "medium" : "low";
  return callJSON(settings, { system: JOB_SYSTEM, content, schema: JOB_SCHEMA, effort });
}

// --------------------------------------------- unsticking autofill
// After the rule-based fill, one short call for the fields it couldn't do:
// pick the matching option (Degree "Bachelor's Degree" for "Bachelor of
// Science"), fill factual short fields, choose preference dropdowns. Fields
// that need the student's own writing are labeled "writing" and left empty.

const RESOLVE_SCHEMA = obj({
  fields: arr(obj({ qid: str, answer: arr(str), basis: { type: "string", enum: ["fact", "preference", "writing", "unknown"] } })),
});

const RESOLVE_SYSTEM = `You finish a job application form for a student. Each field below is still empty after automatic filling. For each one return:
- answer: the value(s) to enter. For fields with options, copy the option text exactly (several only for multi_choice, or a dropdown that clearly allows several). For a dropdown with no options listed, give the text to search for (e.g. the school's official name). For number fields, digits only.
- basis:
  "fact" = taken directly from the profile or resume, or an option that means the same thing as a profile value ("wanted" is what the profile says).
  "preference" = a choice the student would plausibly make that the profile doesn't state outright (e.g. which internship term, a team, a shift), picked to fit the posting and resume.
  "writing" = needs the student's own words (why this company, describe a project, cover-letter style text, anything opinion or motivation). Return answer [] for these.
  "unknown" = a fact you don't have (referral name, ID numbers, salary, a date not in the profile). Return answer [].
Never invent facts. Keep answers short. Follow the student's instructions when given (e.g. which term they prefer).`;

// Standing instructions from Settings → Instructions for Claude.
const instructionsBlock = (instructions) => (instructions?.trim() ? `<student_instructions>\n${instructions.trim()}\n</student_instructions>` : "");

// fields: [{ qid, question, kind, options, required, field?, wanted? }]
export async function resolveFields(settings, { fields, profile, resumeText, posting, instructions = "" }) {
  if (!fields.length) return [];
  const content = [
    posting ? `<job>\n${posting.slice(0, 6000)}\n</job>` : "",
    `<profile>${JSON.stringify(profile)}</profile>`,
    `<resume>\n${resumeText.slice(0, 8000)}\n</resume>`,
    instructionsBlock(instructions),
    `<fields>\n${JSON.stringify(fields.map(({ qid, question, kind, options, required, wanted }) => ({ qid, question, kind, options, required, wanted })))}\n</fields>`,
  ]
    .filter(Boolean)
    .join("\n\n");
  const out = await callJSON(settings, { system: RESOLVE_SYSTEM, content, schema: RESOLVE_SCHEMA, effort: "low" });
  return out.fields || [];
}

// ------------------------------------------------ fixing with feedback
// The student says what's wrong ("start date is August 2026", "pick Summer
// internship, not Both"); Claude changes only those fields. It may paste
// text the student wrote in the feedback, but never writes answers itself.

const FEEDBACK_SCHEMA = obj({
  changes: arr(obj({ qid: str, answer: arr(str), basis: { type: "string", enum: ["fact", "preference", "student_text"] } })),
  note: str,
});

const FEEDBACK_SYSTEM = `A student reviewed a job application form that was filled in for them and says some of it is wrong. Fix exactly what their feedback asks for, and nothing else.

Rules:
- Only change fields the feedback refers to (or that break their standing instructions). Leave every other field alone.
- For fields with options, copy the option text exactly (several only for multi_choice/multi-select dropdowns). For a dropdown without listed options, give the text to search for.
- basis "fact" when the value comes from the feedback, profile or resume; "preference" for a choice the feedback asks for; "student_text" when you copy text the student wrote in the feedback into a text field.
- Never write an answer in your own words. If the feedback asks you to write or rewrite an open answer without giving the text, don't change that field and say so in note.
- note: one short sentence on what you changed or couldn't change.`;

// fields: snapshotFields() output (current values included)
export async function applyFeedback(settings, { fields, feedback, instructions = "", profile, resumeText, posting = "" }) {
  const content = [
    `<feedback>\n${feedback}\n</feedback>`,
    instructionsBlock(instructions),
    posting ? `<job>\n${posting.slice(0, 4000)}\n</job>` : "",
    `<profile>${JSON.stringify(profile)}</profile>`,
    `<resume>\n${(resumeText || "").slice(0, 6000)}\n</resume>`,
    `<form_fields>\n${JSON.stringify(fields.map(({ qid, question, kind, value, options }) => ({ qid, question, kind, value, options })))}\n</form_fields>`,
  ]
    .filter(Boolean)
    .join("\n\n");
  return callJSON(settings, { system: FEEDBACK_SYSTEM, content, schema: FEEDBACK_SCHEMA, effort: "low" });
}

// ------------------------------------------------ what jobs to look for
// Read once from the resume (and redone when it changes). fit.js scores
// every listing against it without AI.

const TARGET_SCHEMA = obj({
  summary: str,
  categories: arr({ type: "string", enum: ["Software", "AI/ML/Data", "Quant", "Product", "Hardware"] }),
  include: arr(str),
  exclude: arr(str),
  degree: { type: "string", enum: ["Bachelor's", "Master's", "PhD"] },
});

const TARGET_SYSTEM = `You decide which internship listings are realistic for a student, from their resume and profile. Listings are filtered by title words and by a category (Software, AI/ML/Data, Quant, Product, Hardware).

Return:
- summary: one sentence, e.g. "Second-year CS student aiming for software and ML internships."
- categories: the categories worth applying to, based on their major and the bulk of their experience. Be conservative: one hardware-adjacent project or a tool on the skills list doesn't make Hardware a fit for a CS major.
- include: 8-20 lowercase title words/phrases that mark a strong fit (e.g. "software", "machine learning", "backend", "data science", "research", "full stack").
- exclude: 8-25 lowercase title words/phrases for roles they can't realistically do given their major and year: other engineering disciplines (e.g. "electrical", "mechanical", "civil", "chemical", "aerospace", "manufacturing", "rf", "analog"), and unrelated functions (e.g. "accounting", "sales", "marketing", "legal", "hr"). Don't exclude anything that appears in include. Don't list degree words (PhD/Master's are handled separately).
- degree: the degree they're currently pursuing.`;

export async function buildTarget(settings, { resumeText, profile }) {
  const content = `<profile>${JSON.stringify({ school: profile.school, degree: profile.degree, major: profile.major, gradMonth: profile.gradMonth, gradYear: profile.gradYear })}</profile>\n\n<resume>\n${resumeText.slice(0, 9000)}\n</resume>`;
  return callJSON(settings, { system: TARGET_SYSTEM, content, schema: TARGET_SCHEMA, effort: "low" });
}
