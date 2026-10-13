// Verification emails from the Gmail you're already signed into in this
// browser, for sites that email a code or a confirm link when JobPilot signs
// you in or makes an account (lib/accounts.js). No setup: it reads Gmail's
// inbox feed (mail.google.com/mail/feed/atom), which lists unread emails
// with a short preview (codes are usually in it). For a link, it opens that
// one email in a background tab and reads the link. Nothing is sent.
//
// This feed isn't an official API for extensions; if Google changes it,
// JobPilot stops and asks you for the code instead.
import { sleep } from "./clock.js";

// Signed in to several Google accounts? Use the one matching `email`,
// otherwise the first signed-in inbox.
async function feedFor(email) {
  let first = null;
  for (let u = 0; u < 5; u++) {
    let xml;
    try {
      const res = await fetch(`https://mail.google.com/mail/u/${u}/feed/atom`, { credentials: "include", cache: "no-store" });
      if (!res.ok) break;
      xml = await res.text();
    } catch {
      break;
    }
    if (!/<feed/i.test(xml)) break; // signed out: Google returns a login page instead
    const owner = (xml.match(/<title>[^<]*?for ([^<\s]+@[^<\s]+)<\/title>/i) || [])[1] || "";
    const feed = { xml, owner };
    if (!email || owner.toLowerCase() === email.toLowerCase()) return feed;
    first ||= feed;
  }
  return first;
}

const unescape = (s) => String(s || "").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&");

function entries(xml) {
  return [...xml.matchAll(/<entry>([\s\S]*?)<\/entry>/gi)].map((m) => {
    const e = m[1];
    const tag = (t) => unescape((e.match(new RegExp(`<${t}>([\\s\\S]*?)</${t}>`, "i")) || [])[1]);
    const link = unescape((e.match(/<link[^>]*href="([^"]+)"/i) || [])[1]);
    return { subject: tag("title"), summary: tag("summary"), from: `${tag("name")} ${tag("email")}`, at: Date.parse(tag("issued") || tag("modified")) || 0, link };
  });
}

// Is Gmail reachable and whose inbox is it? -> address or "" (Settings).
export async function gmailAccount(email = "") {
  const f = await feedFor(email);
  return f ? f.owner || "(signed in)" : "";
}

// Settings → Test Gmail: whose inbox, and how many unread emails it sees.
// Counts only; no email content is shown.
export async function testGmail(email = "") {
  const f = await feedFor(email);
  if (!f) return { ok: false, note: "Not signed in to Gmail in this browser. Open gmail.com, sign in, then test again." };
  const n = entries(f.xml).length;
  const full = Number((f.xml.match(/<fullcount>(\d+)<\/fullcount>/i) || [])[1] || n);
  const mismatch = email && f.owner && f.owner.toLowerCase() !== email.toLowerCase();
  return { ok: !mismatch, owner: f.owner, unread: full, note: mismatch ? `Reading ${f.owner}, but your profile email is ${email}: codes sent to ${email} won't be found. Sign in to that Gmail in this browser.` : `Reading ${f.owner || "your inbox"}: ${full} unread email${full === 1 ? "" : "s"} visible.` };
}

const VERIFY_WORDS = /verif|confirm|activat|validat|welcome|account|sign ?in|log ?in|password|code/i;

// The verify/confirm link among an email's links. Gmail wraps links as
// google.com/url?q=<real>; unwrap those first.
export function pickVerifyLink(hrefs, hint = "") {
  const words = hint.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 3);
  const real = hrefs
    .map((h) => {
      try {
        const u = new URL(h);
        if (/(^|\.)google\.com$/.test(u.hostname) && u.pathname === "/url") return u.searchParams.get("q") || u.searchParams.get("url") || "";
        return h;
      } catch {
        return "";
      }
    })
    .filter((h) => /^https?:/.test(h) && !/(^|\/\/)([a-z0-9-]+\.)*(google|gmail|googleusercontent|gstatic)\.com\//i.test(h) && !/unsubscribe|privacy|help|support|preferences|mailto:/i.test(h));
  const scored = real.map((h) => ({ h, s: (/verif|confirm|activat|validat|token=|code=|key=/i.test(h) ? 3 : 0) + (words.some((w) => h.toLowerCase().includes(w)) ? 1 : 0) }));
  scored.sort((a, b) => b.s - a.s);
  return scored[0] && scored[0].s >= 3 ? scored[0].h : null;
}

// Open one email in a background tab and read its links (Gmail's own page;
// the email is marked read). -> verify link or null.
async function linkFromEmail(entryUrl, hint) {
  if (!entryUrl || typeof chrome === "undefined" || !chrome.tabs) return null;
  const tab = await chrome.tabs.create({ url: entryUrl, active: false });
  try {
    for (let i = 0; i < 20; i++) {
      await sleep(1000);
      const [r] = await chrome.scripting
        .executeScript({
          target: { tabId: tab.id },
          func: () => {
            const body = [...document.querySelectorAll(".a3s, [role=listitem] .ii, .adn")];
            const scope = body.length ? body : [document];
            return scope.flatMap((b) => [...b.querySelectorAll("a[href]")].map((a) => a.href));
          },
        })
        .catch(() => [{ result: [] }]);
      const link = pickVerifyLink(r?.result || [], hint);
      if (link) return link;
    }
    return null;
  } finally {
    chrome.tabs.remove(tab.id).catch(() => {});
  }
}

// A code near words like "code"/"verification", not a year.
export function extractCode(text) {
  for (const m of String(text).matchAll(/\b([A-Z0-9]{4,8})\b/g)) {
    const c = m[1];
    if (!/\d/.test(c) || /^(19|20)\d\d$/.test(c)) continue;
    const near = text.slice(Math.max(0, m.index - 80), m.index + 40).toLowerCase();
    if (/code|verif|otp|passcode|one[- ]time|security|pin\b|confirm/.test(near)) return c;
  }
  return null;
}

// Wait for the site's verification email (arrived after sinceMs).
// want: "code" | "link" | "any". hint: site/company words, to pick the
// right email. -> { code?, link?, from, subject } or null.
export async function waitForEmail({ email, sinceMs, hint = "", want = "any", timeoutMs = 180000 }) {
  const words = hint.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 3);
  const deadline = Date.now() + timeoutMs;
  const tried = new Set();
  while (Date.now() < deadline) {
    const f = await feedFor(email);
    if (!f) return null;
    const fresh = entries(f.xml)
      .filter((e) => e.at >= sinceMs - 60000)
      .map((e) => ({ ...e, code: extractCode(`${e.subject}\n${e.summary}`), match: words.some((w) => `${e.from} ${e.subject} ${e.summary}`.toLowerCase().includes(w)) }))
      .sort((a, b) => b.match - a.match || b.at - a.at);
    if (want !== "link") {
      const c = fresh.find((e) => e.code);
      if (c) return { code: c.code, from: c.from, subject: c.subject };
    }
    if (want !== "code") {
      // A verify/confirm email since sign-up started (ones naming the site
      // first; Workday's come from "Workday"): open each once for the link.
      for (const e of fresh.filter((x) => VERIFY_WORDS.test(`${x.subject} ${x.summary}`) && x.link && !tried.has(x.link))) {
        tried.add(e.link);
        const link = await linkFromEmail(e.link, hint);
        if (link) return { link, from: e.from, subject: e.subject };
      }
    }
    await sleep(5000);
  }
  return null;
}

export const waitForCode = (opts) => waitForEmail({ ...opts, want: "code" });
