#!/usr/bin/env node
// One-time setup: lets the JobPilot extension use your Claude Code login or ChatGPT plan.
//
//   node bridge/install.js               install / update
//   node bridge/install.js --uninstall   remove
//
// Copies the bridge to ~/.jobpilot/bridge, records where Claude Code is
// installed, and registers it with Chrome, Brave, Edge, Arc and Chromium.
"use strict";

const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const HOST_NAME = "com.jobpilot.claude_bridge";
// Fixed by the "key" in extension/manifest.json.
const DEFAULT_EXTENSION_ID = "domfhjgaedjaoioaidcpgcjbleagfbgg";

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const uninstall = args.includes("--uninstall");
const extensionId = flag("--extension-id") || DEFAULT_EXTENSION_ID;
const installDir = flag("--install-dir") || path.join(os.homedir(), ".jobpilot", "bridge");
// For testing: register only into this browser profile directory.
const browserDir = flag("--browser-dir");
const isWin = process.platform === "win32";
const isMac = process.platform === "darwin";

function log(s) {
  console.log(s);
}

// Places browsers look for user-level native messaging host manifests.
function manifestDirs() {
  if (browserDir) return [path.join(browserDir, "NativeMessagingHosts")];
  const home = os.homedir();
  let roots;
  if (isMac) {
    const base = path.join(home, "Library", "Application Support");
    roots = ["Google/Chrome", "Google/Chrome Beta", "Google/Chrome Canary", "Chromium", "BraveSoftware/Brave-Browser", "Microsoft Edge", "Arc/User Data", "Vivaldi"].map((r) => path.join(base, r));
  } else {
    const base = path.join(home, ".config");
    roots = ["google-chrome", "google-chrome-beta", "chromium", "BraveSoftware/Brave-Browser", "microsoft-edge", "vivaldi"].map((r) => path.join(base, r));
  }
  // Always register for Chrome, plus any other browser that's installed.
  return roots.filter((r, i) => i === 0 || fs.existsSync(r)).map((r) => path.join(r, "NativeMessagingHosts"));
}

const WIN_REG_KEYS = ["Google\\Chrome", "Chromium", "Microsoft\\Edge", "BraveSoftware\\Brave-Browser", "Vivaldi"].map((b) => `HKCU\\Software\\${b}\\NativeMessagingHosts\\${HOST_NAME}`);

function which(cmd) {
  try {
    const out = execFileSync(isWin ? "where" : "/bin/sh", isWin ? [cmd] : ["-lc", `command -v ${cmd}`], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    return out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  } catch {
    return [];
  }
}

// Find Claude Code and work out how to start it without a shell.
function findClaude() {
  const home = os.homedir();
  const candidates = [
    ...which("claude"),
    path.join(home, ".local", "bin", isWin ? "claude.exe" : "claude"),
    path.join(home, ".claude", "local", isWin ? "claude.exe" : "claude"),
    "/opt/homebrew/bin/claude",
    "/usr/local/bin/claude",
  ];
  for (const c of candidates) {
    if (!c || !fs.existsSync(c)) continue;
    if (isWin && /\.(cmd|bat|ps1)$/i.test(c)) {
      // npm shim on Windows: run its JS entry point with node directly.
      const pkg = path.join(path.dirname(c), "node_modules", "@anthropic-ai", "claude-code");
      for (const entry of ["cli.js", "cli.mjs"]) {
        if (fs.existsSync(path.join(pkg, entry))) return [process.execPath, path.join(pkg, entry)];
      }
      continue;
    }
    if (isWin && !/\.exe$/i.test(c)) continue;
    // Keep the symlink (not its target) so Claude Code auto-updates keep working.
    return [path.resolve(c)];
  }
  return null;
}

function doUninstall() {
  if (isWin) {
    for (const k of WIN_REG_KEYS) {
      try {
        execFileSync("reg", ["delete", k, "/f"], { stdio: "ignore" });
      } catch {}
    }
  } else {
    for (const d of manifestDirs()) fs.rmSync(path.join(d, `${HOST_NAME}.json`), { force: true });
  }
  fs.rmSync(installDir, { recursive: true, force: true });
  log("JobPilot bridge removed.");
}

function doInstall() {
  const claude = findClaude();
  if (Number(process.versions.node.split(".")[0]) < 20) {
    log("✗ JobPilot's ChatGPT bridge needs Node.js 20 or newer.");
    process.exit(1);
  }
  let version = "";
  if (claude) {
    try { version = execFileSync(claude[0], [...claude.slice(1), "--version"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim(); }
    catch { log("· Claude Code did not run. ChatGPT sign-in is still available."); }
  }

  fs.mkdirSync(installDir, { recursive: true });
  fs.copyFileSync(path.join(__dirname, "host.js"), path.join(installDir, "host.js"));
  fs.copyFileSync(path.join(__dirname, "chatgpt.js"), path.join(installDir, "chatgpt.js"));
  fs.copyFileSync(path.join(__dirname, "../extension/lib/openai.js"), path.join(installDir, "openai.mjs"));
  // If this is a git clone, remember it so the extension can update itself.
  const repo = path.resolve(__dirname, "..");
  const repoDir = fs.existsSync(path.join(repo, ".git")) ? repo : null;
  const gitCommand = repoDir ? which("git")[0] || "git" : undefined;

  fs.writeFileSync(
    path.join(installDir, "config.json"),
    JSON.stringify({ claudeCommand: claude, extraPath: claude ? [path.dirname(claude[0])] : [], repoDir, gitCommand }, null, 2)
  );

  // Launcher Chrome runs (it can't run .js files directly).
  let launcher;
  if (isWin) {
    launcher = path.join(installDir, "jobpilot-bridge.bat");
    fs.writeFileSync(launcher, `@echo off\r\n"${process.execPath}" "${path.join(installDir, "host.js")}" %*\r\n`);
  } else {
    launcher = path.join(installDir, "jobpilot-bridge.sh");
    fs.writeFileSync(launcher, `#!/bin/sh\nexec "${process.execPath}" "${path.join(installDir, "host.js")}" "$@"\n`);
    fs.chmodSync(launcher, 0o755);
  }

  const manifest = {
    name: HOST_NAME,
    description: "JobPilot bridge for Claude Code and ChatGPT plan usage",
    path: launcher,
    type: "stdio",
    allowed_origins: [`chrome-extension://${extensionId}/`],
  };

  if (isWin) {
    const mPath = path.join(installDir, `${HOST_NAME}.json`);
    fs.writeFileSync(mPath, JSON.stringify(manifest, null, 2));
    for (const k of WIN_REG_KEYS) execFileSync("reg", ["add", k, "/ve", "/t", "REG_SZ", "/d", mPath, "/f"], { stdio: "ignore" });
  } else {
    for (const d of manifestDirs()) {
      fs.mkdirSync(d, { recursive: true });
      fs.writeFileSync(path.join(d, `${HOST_NAME}.json`), JSON.stringify(manifest, null, 2));
    }
  }

  log(version ? `✓ Found ${version}` : "· Claude Code not available; ChatGPT plan usage does not require it.");
  log(`✓ Bridge installed in ${installDir}`);
  log("✓ Registered with your browser(s)");
  log(repoDir ? `✓ Auto-update enabled from ${repoDir}` : "· Not a git clone, so auto-update will only notify you (use git clone to enable it)");
  log("");
  log("Next: in JobPilot → Settings → Connect AI, choose your Claude or ChatGPT subscription.");
  log("If Claude Code isn't logged in yet, run `claude` in a terminal and log in first.");
}

if (uninstall) doUninstall();
else doInstall();
