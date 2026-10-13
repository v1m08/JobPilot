// Signing in to job sites that want an account, for users who turned this on
// in Settings → Accounts & sign-in (each user agrees to it themselves).
//
// Order of attempts on a sign-in wall:
//   1. "Sign in with Google", if the site offers it: JobPilot clicks it, then
//      on Google's pages picks your account and continues past the sharing
//      screen (basic profile only). You sign in to Google yourself, once, in
//      this browser; JobPilot never types a Google password and stops if
//      Google asks for one or wants to verify it's you.
//   2. An account JobPilot already made on this site: email + saved password.
//   3. A new account (if allowed): your profile email and a generated
//      password, saved before submitting so it's never lost. Codes the site
//      emails you are read from your Gmail (lib/gmail.js).
//
// -> { ok, note }. Never solves CAPTCHAs.
import * as Page from "./page.js";
import { sleep } from "./clock.js";
import { waitForEmail } from "./gmail.js";
import { get, set } from "./store.js";

// Workday tenants (nvidia.wd5.myworkdayjobs.com) each need their own account.
export const siteKey = (url) => {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
};

export async function savedAccounts() {
  return get("accounts", {});
}

async function saveAccount(key, acct) {
  const all = await savedAccounts();
  all[key] = { ...(all[key] || {}), ...acct };
  await set("accounts", all);
}

// 16 characters with upper, lower, digit and symbol: passes the usual rules
// (Workday: 8+ with all four kinds).
export function generatePassword() {
  const sets = ["ABCDEFGHJKLMNPQRSTUVWXYZ", "abcdefghijkmnopqrstuvwxyz", "23456789", "!@#$%^&*-_"];
  const rnd = (n) => crypto.getRandomValues(new Uint32Array(1))[0] % n;
  const chars = sets.map((s) => s[rnd(s.length)]);
  const all = sets.join("");
  while (chars.length < 16) chars.push(all[rnd(all.length)]);
  for (let i = chars.length - 1; i > 0; i--) {
    const j = rnd(i + 1);
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }
  return chars.join("");
}

const page = async (tab) => (await Page.callAll(tab, "accountPage")).find((p) => p.kind !== "none") || { kind: "none", google: false };
const call = async (tab, name, args = []) => (await Page.callAll(tab, name, args)).find((r) => r && (r.clicked || r === true || typeof r === "number")) || null;

// "Sign in with Google": the button opens a popup or sends this tab to
// accounts.google.com. Work Google's pages until we're back on the site.
async function viaGoogle(tab, { email, step }) {
  step("Signing in with Google");
  const opened = [];
  const onCreated = (t) => t.openerTabId === tab.id && opened.push(t.id);
  chrome.tabs.onCreated.addListener(onCreated);
  try {
    if (!(await call(tab, "clickGoogleSignIn"))) return { ok: false, note: "Couldn't click the site's Sign in with Google button." };
    const deadline = Date.now() + 90000;
    let touchedGoogle = false;
    while (Date.now() < deadline) {
      await sleep(1500);
      // The Google page: the popup if there is one, else this tab.
      const ids = [...opened, tab.id];
      let googleTab = null;
      for (const id of ids) {
        const t = await chrome.tabs.get(id).catch(() => null);
        if (t && /^https:\/\/accounts\.google\.com/.test(t.url || "")) googleTab = t;
      }
      if (googleTab) {
        touchedGoogle = true;
        const r = (await Page.callAll(googleTab, "googleStep", [{ email }]).catch(() => [])).find(Boolean) || { state: "other" };
        if (r.state === "password") return { ok: false, note: "Google asked for your password. Sign in to Google in this browser once (gmail.com), then Try again." };
        if (r.state === "verify") return { ok: false, note: "Google wants to verify it's you. Finish that in the Google window, then Try again." };
        if (r.state === "scopes") return { ok: false, note: "This site asks Google for more than your basic profile, so JobPilot left it for you." };
        continue;
      }
      // Back on the site (popup closed or redirect finished).
      if (touchedGoogle || opened.length) {
        await Page.waitForForm(await chrome.tabs.get(tab.id), { timeoutMs: 8000 }).catch(() => {});
        const p = await page(tab);
        if (p.kind === "signin" || p.kind === "signup") return { ok: false, note: "Signed in with Google, but the site still shows a sign-in page." };
        return { ok: true, note: "Signed in with Google" };
      }
    }
    return { ok: false, note: "Sign in with Google didn't finish in 90 seconds." };
  } finally {
    chrome.tabs.onCreated.removeListener(onCreated);
  }
}

// After sign-up / sign-in the site may email a code (page asks for it) or a
// confirm link (page says "check your email"). Read it from Gmail and use it.
async function handleEmail(tab, { email, hint, since, step, settings }) {
  const p = await page(tab);
  if (p.kind !== "code" && p.kind !== "check-email") return { ok: true };
  if (!settings.accounts?.readGmail) {
    return { ok: false, note: p.kind === "code" ? "The site emailed you a code. Enter it in the tab, or turn on reading Gmail in Settings → Accounts & sign-in." : "The site emailed you a link to confirm your account. Open it, then Try again." };
  }
  step(p.kind === "code" ? "Waiting for the emailed code" : "Waiting for the confirmation email");
  const got = await waitForEmail({ email, sinceMs: since, hint, want: p.kind === "code" ? "code" : "any", timeoutMs: 180000 });
  if (!got) return { ok: false, note: "Nothing arrived in Gmail within 3 minutes (signed in to Gmail in this browser? Settings → Test Gmail). Finish it in the tab, then Try again." };
  if (got.code) {
    await call(tab, "fillCode", [got.code]);
    await call(tab, "submitAccount");
    await sleep(2500);
    return { ok: true };
  }
  // Confirm link: open it in the job tab, which usually confirms and then
  // shows the site's sign-in or the application.
  step("Confirming your email");
  await chrome.tabs.update(tab.id, { url: got.link });
  await Page.waitForLoad(tab.id);
  await sleep(2000);
  return { ok: true, confirmed: true };
}

// Sign-up forms that also ask for your name, phone, etc.: fill those from
// your profile with the regular autofill (passwords are left alone).
async function fillProfileFields(tab, profile) {
  await Page.autofill(tab, { profile, resumeFile: null }).catch(() => {});
}

export async function signInFlow(tab, { settings, profile, job = {}, step = () => {} }) {
  const opts = settings.accounts || {};
  if (!opts.enabled) return { ok: false, note: "This site needs an account. Turn on Settings → Accounts & sign-in to let JobPilot sign in for you." };
  const email = profile.email;
  if (!email) return { ok: false, note: "Add your email in Settings → Application profile first." };
  const key = siteKey(tab.url || job.url);
  const hint = `${job.company || ""} ${key}`;

  let p = await page(tab);
  if (p.kind === "none") return { ok: true }; // nothing to do

  // 1. Google
  if (p.google && opts.google) {
    const r = await viaGoogle(tab, { email, step });
    if (r.ok) return r;
    if (!opts.createAccounts) return r;
    p = await page(tab);
  }

  const saved = (await savedAccounts())[key];
  const since = Date.now();

  // 2. Saved account
  if (saved) {
    if (p.kind === "signup") await call(tab, "clickSignIn").then(() => sleep(1500));
    step("Signing in");
    await call(tab, "fillCredentials", [{ email: saved.email, password: saved.password }]);
    await call(tab, "submitAccount");
    await sleep(3000);
    const c = await handleEmail(tab, { email, hint, since, step, settings });
    if (!c.ok) return c;
    p = await page(tab);
    if (p.kind === "signin") {
      // A confirm link sends you back to sign in once more.
      if (c.confirmed) {
        await call(tab, "fillCredentials", [{ email: saved.email, password: saved.password }]);
        await call(tab, "submitAccount");
        await sleep(3000);
        p = await page(tab);
      }
      if (p.kind === "signin") return { ok: false, note: "Signing in with the saved password didn't work. Check it in Settings → Accounts & sign-in." };
    }
    return { ok: true, note: "Signed in" };
  }

  // 3. New account
  if (!opts.createAccounts) return { ok: false, note: "This site needs an account and has no Google option. Turn on creating accounts in Settings → Accounts & sign-in, or sign up yourself." };
  if (p.kind !== "signup") {
    await call(tab, "clickCreateAccount");
    await sleep(1800);
    p = await page(tab);
    if (p.kind !== "signup") return { ok: false, note: "Couldn't find this site's create-account form." };
  }
  step("Creating an account");
  const password = generatePassword();
  await saveAccount(key, { email, password, createdAt: Date.now(), company: job.company || "", url: tab.url });
  await fillProfileFields(tab, profile);
  await call(tab, "fillCredentials", [{ email, password, allowTerms: true }]);
  if ((await Page.callAll(tab, "detectCaptcha")).some(Boolean)) return { ok: false, note: "The sign-up form has a CAPTCHA. Finish it in the tab (your password is saved in Settings), then Try again." };
  await call(tab, "submitAccount");
  await sleep(3500);
  const c = await handleEmail(tab, { email, hint, since, step, settings });
  if (!c.ok) return c;
  // Many sites send you back to sign in after signing up or confirming.
  p = await page(tab);
  if (p.kind === "signin") {
    step("Signing in to the new account");
    await call(tab, "fillCredentials", [{ email, password }]);
    await call(tab, "submitAccount");
    await sleep(3000);
    const c2 = await handleEmail(tab, { email, hint, since: Date.now() - 5000, step, settings });
    if (!c2.ok) return c2;
    p = await page(tab);
    if (p.kind === "signin") return { ok: false, note: "Made the account, but signing in to it didn't work. Your password is in Settings → Accounts & sign-in." };
  }
  await saveAccount(key, { verified: true });
  return { ok: true, note: "Created an account" };
}
