#!/usr/bin/env node
// JobPilot ↔ Claude Code / ChatGPT plan bridge (Chrome native messaging host).
//
// Chrome starts this process when the extension calls
// chrome.runtime.sendNativeMessage("com.jobpilot.claude_bridge", ...).
// It runs `claude -p` (Claude Code's non-interactive mode) with your own
// Claude Code login, so AI features use your Claude subscription.
//
// Messages (4-byte little-endian length + JSON, both directions):
//   { type: "ping" }  -> { ok, bridgeVersion, claudeVersion }
//   { type: "run", system, prompt, schema, model?, effort?, pdfBase64? }
//                     -> { ok, data } | { ok: false, error }
//   { type: "update-check", branch? } -> { ok, behind, local, remote }
//   { type: "update", branch? }       -> { ok, pulled, bridgeUpdated }
"use strict";

const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const BRIDGE_VERSION = "1.4.1";
const { ChatGPT } = require("./chatgpt.js");
const chatgpt = new ChatGPT();
const TIMEOUT_MS = 5 * 60 * 1000;

function loadConfig() {
  try {
    return JSON.parse(fs.readFileSync(path.join(__dirname, "config.json"), "utf8"));
  } catch {
    return {};
  }
}
const config = loadConfig();

// ------------------------------------------------------- native messaging

function send(obj) {
  const json = Buffer.from(JSON.stringify(obj), "utf8");
  const header = Buffer.alloc(4);
  header.writeUInt32LE(json.length, 0);
  process.stdout.write(Buffer.concat([header, json]));
}

let buf = Buffer.alloc(0);
let pending = 0;
let stdinEnded = false;

process.stdin.on("data", (chunk) => {
  buf = Buffer.concat([buf, chunk]);
  while (buf.length >= 4) {
    const len = buf.readUInt32LE(0);
    if (buf.length < 4 + len) break;
    const raw = buf.subarray(4, 4 + len).toString("utf8");
    buf = buf.subarray(4 + len);
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      send({ ok: false, error: "Bridge received malformed JSON." });
      continue;
    }
    pending++;
    handle(msg)
      .then(send, (e) => send({ ok: false, error: e.message || String(e), code: e.code, status: e.status, responseShape: e.responseShape, requestId: e.requestId }))
      .finally(() => {
        pending--;
        if (stdinEnded && pending === 0) process.exit(0);
      });
  }
});
process.stdin.on("end", () => {
  stdinEnded = true;
  chatgpt.cancelSignIn();
  if (pending === 0) process.exit(0);
});

// ------------------------------------------------------------ claude CLI

// How to start Claude Code: recorded by install.js because Chrome launches
// this process with a minimal PATH.
function claudeCommand() {
  if (config.claudeCommand && config.claudeCommand.length) return config.claudeCommand;
  return [process.platform === "win32" ? "claude.exe" : "claude"];
}

function childEnv() {
  const env = { ...process.env };
  const extra = [path.dirname(process.execPath), ...(config.extraPath || [])];
  env.PATH = [...extra, env.PATH || ""].join(path.delimiter);
  // Use the Claude Code login (subscription), not an API key that happens
  // to be set in the environment.
  if (config.useApiKeyFromEnv !== true) delete env.ANTHROPIC_API_KEY;
  return env;
}

function runClaude(args, input, cwd) {
  const [cmd, ...pre] = claudeCommand();
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(cmd, [...pre, ...args], { cwd, env: childEnv(), windowsHide: true });
    } catch (e) {
      return reject(e);
    }
    let out = "";
    let err = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("Claude Code took too long (5 min) and was stopped."));
    }, TIMEOUT_MS);
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("error", (e) => {
      clearTimeout(timer);
      if (e.code === "ENOENT") reject(new Error("Couldn't find Claude Code. Re-run the bridge installer (node bridge/install.js) after installing Claude Code."));
      else reject(e);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, out, err });
    });
    if (input !== undefined) child.stdin.end(input);
    else child.stdin.end();
  });
}

function friendlyFailure(text) {
  if (/not logged in|please run \/login|\/login|authentication|oauth token|invalid api key|401/i.test(text)) {
    return "Claude Code isn't logged in. Open a terminal, run `claude`, and log in with your Claude account. Then try again.";
  }
  if (/usage limit|rate limit|limit reached|resets at/i.test(text)) {
    return `You've hit your Claude usage limit: ${text.trim().slice(0, 200)}`;
  }
  return text.trim().slice(0, 600) || "Claude Code failed without an error message.";
}

function extractJSON(text) {
  const s = text.indexOf("{");
  const e = text.lastIndexOf("}");
  if (s < 0 || e <= s) throw new Error("Claude didn't return JSON.");
  return JSON.parse(text.slice(s, e + 1));
}

// ------------------------------------------------------------ LaTeX → PDF

function texSearchDirs() {
  const dirs = (process.env.PATH || "").split(path.delimiter);
  if (process.platform === "darwin") dirs.push("/Library/TeX/texbin", "/opt/homebrew/bin", "/usr/local/bin");
  if (process.platform === "linux") dirs.push("/usr/bin", "/usr/local/bin");
  if (process.platform === "win32") {
    const la = process.env.LOCALAPPDATA || "";
    const pf = process.env.ProgramFiles || "C:\\Program Files";
    dirs.push(path.join(la, "Programs", "MiKTeX", "miktex", "bin", "x64"), path.join(pf, "MiKTeX", "miktex", "bin", "x64"));
  }
  for (const root of ["/usr/local/texlive", "C:\\texlive"]) {
    try {
      for (const year of fs.readdirSync(root).sort().reverse()) {
        const bin = path.join(root, year, "bin");
        if (fs.existsSync(bin)) for (const arch of fs.readdirSync(bin)) dirs.push(path.join(bin, arch));
      }
    } catch {}
  }
  return dirs.filter(Boolean);
}

// First available engine. pdflatex matches Jake's template exactly.
function findTexEngine() {
  const exe = process.platform === "win32" ? ".exe" : "";
  for (const name of ["pdflatex", "tectonic", "xelatex", "lualatex"]) {
    for (const dir of texSearchDirs()) {
      const p = path.join(dir, name + exe);
      if (fs.existsSync(p)) return { name, path: p };
    }
  }
  return null;
}

function runProcess(cmd, args, cwd) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd, windowsHide: true });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    const timer = setTimeout(() => child.kill(), 120000);
    child.on("error", (e) => (clearTimeout(timer), resolve({ code: -1, out: e.message })));
    child.on("close", (code) => (clearTimeout(timer), resolve({ code, out })));
  });
}

async function compileLatex(tex) {
  const engine = findTexEngine();
  if (!engine) {
    return { ok: false, code: "NO_TEX", error: "No LaTeX engine found. Install MacTeX/TeX Live, MiKTeX, or Tectonic for exact Jake's Resume output." };
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jobpilot-tex-"));
  try {
    fs.writeFileSync(path.join(dir, "resume.tex"), tex);
    const args = engine.name === "tectonic" ? ["--keep-logs", "resume.tex"] : ["-interaction=nonstopmode", "-halt-on-error", "resume.tex"];
    const r = await runProcess(engine.path, args, dir);
    const pdf = path.join(dir, "resume.pdf");
    if (!fs.existsSync(pdf)) {
      const errLine = (r.out.split(/\r?\n/).find((l) => l.startsWith("!") || /error/i.test(l)) || "").trim();
      return { ok: false, code: "COMPILE_FAILED", error: `LaTeX failed (${engine.name}): ${errLine || "see log"}`, log: r.out.slice(-3000) };
    }
    // Page count, so the extension can shrink the resume to fit one page.
    let log = r.out;
    try {
      log += fs.readFileSync(path.join(dir, "resume.log"), "utf8");
    } catch {}
    const m = log.match(/Output written on \S+ \((\d+) pages?/);
    return { ok: true, engine: engine.name, pages: m ? Number(m[1]) : null, pdfBase64: fs.readFileSync(pdf).toString("base64") };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// ------------------------------------------------------------- self-update

// The repo folder is recorded by install.js; the extension can't choose it.
function repoDir() {
  const dir = config.repoDir;
  if (!dir || !fs.existsSync(path.join(dir, ".git"))) {
    throw Object.assign(new Error("The bridge doesn't know where your JobPilot git clone is. Re-run `node bridge/install.js` from inside the clone."), { code: "NO_REPO" });
  }
  return dir;
}

async function git(args) {
  const r = await runProcess(config.gitCommand || "git", args, repoDir());
  if (r.code !== 0) throw new Error(`git ${args[0]} failed: ${r.out.trim().slice(0, 400)}`);
  return r.out.trim();
}

function safeBranch(b) {
  return /^\w[\w./-]*$/.test(b || "") ? b : "main";
}

async function updateCheck(msg) {
  const branch = safeBranch(msg.branch);
  await git(["fetch", "--quiet", "origin", branch]);
  const local = await git(["rev-parse", "HEAD"]);
  const remote = await git(["rev-parse", `origin/${branch}`]);
  const behind = Number(await git(["rev-list", "--count", `HEAD..origin/${branch}`]));
  return { ok: true, behind, local, remote };
}

async function update(msg) {
  const branch = safeBranch(msg.branch);
  const before = await git(["rev-parse", "HEAD"]);
  await git(["pull", "--ff-only", "--quiet", "origin", branch]);
  const after = await git(["rev-parse", "HEAD"]);
  // Keep the installed copy of the bridge in sync with the repo.
  let bridgeUpdated = false;
  for (const [source, target] of [["bridge/host.js", "host.js"], ["bridge/chatgpt.js", "chatgpt.js"], ["extension/lib/openai.js", "openai.mjs"]]) {
    const src = path.join(repoDir(), source);
    const dest = path.join(__dirname, target);
    if (fs.existsSync(src) && path.resolve(src) !== path.resolve(dest) && (!fs.existsSync(dest) || fs.readFileSync(src, "utf8") !== fs.readFileSync(dest, "utf8"))) {
      fs.copyFileSync(src, dest);
      bridgeUpdated = true;
    }
  }
  return { ok: true, pulled: before !== after, bridgeUpdated };
}

async function handle(msg) {
  if (msg.type === "chatgpt-status") return { ok: true, session: chatgpt.status(), bridgeVersion: BRIDGE_VERSION };
  if (msg.type === "chatgpt-sign-in") return { ok: true, session: await chatgpt.signIn(msg.accountId, (url) => send({ event: "chatgpt-authorize", url }), msg.consent === true) };
  if (msg.type === "chatgpt-cancel") { chatgpt.cancelSignIn(); return { ok: true }; }
  if (msg.type === "chatgpt-sign-out") return { ok: true, session: await chatgpt.signOut(msg.accountId) };
  if (msg.type === "chatgpt-select") return { ok: true, session: await chatgpt.select(msg.accountId) };
  if (msg.type === "chatgpt-models") return { ok: true, models: await chatgpt.models(msg.accountId) };
  if (msg.type === "chatgpt-run") return { ok: true, data: await chatgpt.run(msg.accountId, msg.model, msg.options) };
  if (msg.type === "update-check") return updateCheck(msg);
  if (msg.type === "update") return update(msg);
  if (msg.type === "latex") return compileLatex(msg.tex || "");
  if (msg.type === "ping") {
    const r = await runClaude(["--version"], undefined, os.tmpdir());
    if (r.code !== 0) throw new Error(friendlyFailure(r.err || r.out));
    const tex = findTexEngine();
    return { ok: true, bridgeVersion: BRIDGE_VERSION, claudeVersion: r.out.trim(), texEngine: tex ? tex.name : null };
  }
  if (msg.type !== "run") throw new Error(`Unknown request type: ${msg.type}`);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jobpilot-"));
  try {
    let prompt = msg.prompt || "";
    if (msg.pdfBase64) {
      fs.writeFileSync(path.join(dir, "resume.pdf"), Buffer.from(msg.pdfBase64, "base64"));
      prompt = `The resume is the PDF file ./resume.pdf in the current directory. Read it with the Read tool.\n\n${prompt}`;
    }

    const modern = [
      "-p",
      "--output-format", "json",
      "--no-session-persistence",
      "--strict-mcp-config", // skip loading your MCP servers
      "--disable-slash-commands", // skip loading skills
      "--setting-sources", "user", // skip project/local settings in the temp dir
      "--tools", msg.pdfBase64 ? "Read" : "",
      "--system-prompt", msg.system || "",
    ];
    if (msg.pdfBase64) modern.push("--allowedTools", "Read");
    if (msg.schema) modern.push("--json-schema", JSON.stringify(msg.schema));
    if (msg.model && msg.model !== "default") modern.push("--model", msg.model);
    if (msg.effort) modern.push("--effort", msg.effort);

    let r = await runClaude(modern, prompt, dir);

    // Older Claude Code versions don't know some flags: retry with the basics
    // and ask for JSON in the prompt instead.
    if (r.code !== 0 && /unknown option|unrecognized|unknown argument/i.test(r.err)) {
      const basic = ["-p", "--output-format", "json", "--append-system-prompt", msg.system || ""];
      if (msg.pdfBase64) basic.push("--allowedTools", "Read");
      basic.push("--disallowedTools", "Bash", "Edit", "Write", "WebFetch", "WebSearch", "NotebookEdit");
      if (msg.model && msg.model !== "default") basic.push("--model", msg.model);
      const p2 = msg.schema ? `${prompt}\n\nRespond with only a JSON object (no prose, no code fences) matching this JSON Schema:\n${JSON.stringify(msg.schema)}` : prompt;
      r = await runClaude(basic, p2, dir);
    }

    let result;
    try {
      result = JSON.parse(r.out);
    } catch {
      throw new Error(friendlyFailure(r.err || r.out));
    }
    if (result.is_error || r.code !== 0) throw new Error(friendlyFailure(String(result.result || r.err || "")));
    const data = result.structured_output !== undefined && result.structured_output !== null ? result.structured_output : msg.schema ? extractJSON(String(result.result || "")) : String(result.result || "");
    return { ok: true, data };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
