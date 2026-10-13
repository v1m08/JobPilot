// ChatGPT plan OAuth and inference. Credentials never leave this native process.
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const crypto = require('node:crypto');
const { pathToFileURL } = require('node:url');

const ISSUER = 'https://auth.openai.com';
const RESOURCE = 'https://api.openai.com/v1';
const AUTHORIZE = `${ISSUER}/api/accounts/authorize`;
const TOKEN = `${ISSUER}/api/accounts/oauth/token`;
const SCOPES = 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct';
const random = () => crypto.randomBytes(32).toString('base64url');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const fail = (message, code = 'CHATGPT_AUTH') => Object.assign(new Error(message), { code });
const hasPlan = (p) => !!p?.access_token && p.scopes?.includes('chatgpt.tokens.use.direct');

function clearTokens(p) {
  for (const key of ['access_token', 'refresh_token', 'id_token', 'expires_at', 'scopes']) delete p[key];
}

function secureAuthUrl(value) {
  const url = new URL(value);
  if (url.origin !== ISSUER || url.username || url.password) throw fail('Invalid OpenAI authentication endpoint.');
  return url.href;
}

async function verifyIdentity(jwt, clientId, nonce, metadata, jwks, now = Date.now()) {
  if (typeof jwt !== 'string') throw fail('OpenAI did not return an ID token.');
  const segments = jwt.split('.');
  if (segments.length !== 3) throw fail('Invalid OpenAI ID token.');
  let header, claims;
  try {
    header = JSON.parse(Buffer.from(segments[0], 'base64url'));
    claims = JSON.parse(Buffer.from(segments[1], 'base64url'));
  } catch { throw fail('Invalid OpenAI ID token.'); }
  const alg = { RS256: 'RSA-SHA256', ES256: 'sha256' }[header.alg];
  const jwk = jwks.keys?.find((k) => k.kid === header.kid && (!k.use || k.use === 'sig') && (!k.alg || k.alg === header.alg));
  if (!alg || !jwk || header.crit || (header.alg === 'RS256' ? jwk.kty !== 'RSA' : jwk.kty !== 'EC' || jwk.crv !== 'P-256')) throw fail('Untrusted OpenAI ID token signature.');
  const key = crypto.createPublicKey({ key: jwk, format: 'jwk' });
  if (!crypto.verify(alg, Buffer.from(`${segments[0]}.${segments[1]}`), { key, dsaEncoding: 'ieee-p1363' }, Buffer.from(segments[2], 'base64url'))) throw fail('Invalid OpenAI ID token signature.');
  const audience = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (metadata.issuer !== ISSUER || claims.iss !== ISSUER || !audience.includes(clientId) || (audience.length > 1 && claims.azp !== clientId) || (claims.azp && claims.azp !== clientId) || typeof claims.exp !== 'number' || claims.exp <= now / 1000 || (claims.nbf && claims.nbf > now / 1000 + 30) || !claims.sub || (nonce !== undefined && claims.nonce !== nonce)) throw fail('OpenAI ID token identity validation failed.');
  return claims;
}

// Only complete, terminal Responses events may become a cached result.
async function readResponseStream(response) {
  if (!response.body) throw fail('OpenAI returned an empty response stream.', 'CHATGPT_RESPONSE');
  let buffer = '', completed;
  const items = new Map();
  const decoder = new TextDecoder();
  function itemFor(event) {
    if (!Number.isInteger(event.output_index) || event.output_index < 0 || event.output_index > 4096) throw fail('Invalid ChatGPT stream output index.', 'CHATGPT_RESPONSE');
    if (!items.has(event.output_index)) items.set(event.output_index, { id: event.item_id, type: 'message', role: 'assistant', content: [] });
    return items.get(event.output_index);
  }
  function partFor(event, type) {
    const item = itemFor(event);
    if (!Number.isInteger(event.content_index) || event.content_index < 0 || event.content_index > 4096) throw fail('Invalid ChatGPT stream content index.', 'CHATGPT_RESPONSE');
    item.content ||= [];
    item.content[event.content_index] ||= { type, [type === 'refusal' ? 'refusal' : 'text']: '' };
    return item.content[event.content_index];
  }
  function consume(block) {
    const payload = block.split('\n').filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trimStart()).join('\n');
    if (!payload || payload === '[DONE]') return;
    let event;
    try { event = JSON.parse(payload); } catch { throw fail('OpenAI returned malformed streaming data.', 'CHATGPT_RESPONSE'); }
    if (event.type === 'error' || event.type === 'response.failed') throw inferenceError(0, event.response || event);
    if (event.type === 'response.incomplete') throw fail('The ChatGPT response was incomplete. Try again.', 'CHATGPT_RESPONSE');
    if (event.type === 'response.output_item.added' || event.type === 'response.output_item.done') {
      itemFor(event);
      items.set(event.output_index, event.item);
    } else if (event.type === 'response.content_part.added' || event.type === 'response.content_part.done') {
      partFor(event, event.part.type);
      items.get(event.output_index).content[event.content_index] = event.part;
    } else if (event.type === 'response.output_text.delta' || event.type === 'response.output_text.done') {
      const part = partFor(event, 'output_text');
      part.text = event.type.endsWith('.done') ? event.text : part.text + event.delta;
    } else if (event.type === 'response.refusal.delta' || event.type === 'response.refusal.done') {
      const part = partFor(event, 'refusal');
      part.refusal = event.type.endsWith('.done') ? event.refusal : part.refusal + event.delta;
    } else if (event.type === 'response.completed') {
      // The subscription route may omit output from the terminal snapshot.
      // Preserve finalized stream items; never concatenate deltas with done text.
      const streamed = [...items.entries()].sort(([a], [b]) => a - b).map(([, item]) => item);
      const snapshot = event.response?.output;
      const output = snapshot?.length ? snapshot.map((item, index) => {
        const saved = streamed.find((part) => part.id && part.id === item.id) || items.get(index);
        return item.type === 'message' && !item.content?.length && saved?.type === 'message' ? { ...saved, ...item, content: saved.content } : item;
      }) : streamed;
      completed = { ...event.response, output };
    }
  }
  const reader = response.body.getReader();
  try {
    while (true) {
      const { value, done } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });
      // SSE may use LF or CRLF, including across arbitrary network chunk boundaries.
      let match;
      while ((match = /\r?\n\r?\n/.exec(buffer))) {
        consume(buffer.slice(0, match.index).replace(/\r\n/g, '\n'));
        buffer = buffer.slice(match.index + match[0].length);
        if (completed) return completed;
      }
      if (buffer.length > 2 * 1024 * 1024) throw fail('ChatGPT returned an oversized stream event.', 'CHATGPT_RESPONSE');
      if (done) { if (buffer.trim()) consume(buffer.replace(/\r\n/g, '\n')); break; }
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  if (!completed) throw fail('ChatGPT disconnected before completing the response. Try again.', 'CHATGPT_RESPONSE');
  return completed;
}

function inferenceError(status, body = {}, requestId) {
  const code = body.error?.code || body.code || 'CHATGPT_REQUEST';
  let message;
  if (code === 'subscription_sharing_usage_limit_exceeded' || status === 429) message = 'ChatGPT plan or app usage limit reached. Manage usage in ChatGPT Settings → Usage.';
  else if (code === 'subscription_sharing_user_not_eligible') message = 'ChatGPT plan usage is unavailable for this account or workspace. Choose an eligible account in Settings.';
  else if (status === 401) message = 'ChatGPT authorization was rejected. Check the selected account and sign in again in Settings.';
  else if (status === 403) message = 'ChatGPT plan access was denied by account, region or workspace policy. Check your account permissions.';
  else if (status >= 500) message = 'ChatGPT plan access is temporarily unavailable. Try again later.';
  else message = 'ChatGPT rejected the request. Check the selected model and plan permissions.';
  const e = fail(`${message}${requestId ? ` Request ID: ${requestId}` : ''}`, code);
  e.status = status;
  e.responseShape = body.error ? 'error' : body.detail ? 'detail' : 'unknown';
  e.requestId = requestId;
  return e;
}

class ChatGPT {
  constructor({ directory = path.join(os.homedir(), '.jobpilot', 'chatgpt'), fetchImpl = globalThis.fetch, signInTimeout = 5 * 60 * 1000 } = {}) {
    this.directory = directory;
    this.file = path.join(directory, 'accounts.json');
    this.fetch = fetchImpl;
    this.signInTimeout = signInTimeout;
  }
  load() {
    try { return JSON.parse(fs.readFileSync(this.file, 'utf8')); }
    catch (e) { if (e.code !== 'ENOENT') throw fail('Could not read ChatGPT credentials. Check the local bridge credential file.'); return { hostId: `urn:uuid:${crypto.randomUUID()}`, accounts: {}, active: null }; }
  }
  save(state) {
    fs.mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    fs.chmodSync(this.directory, 0o700);
    const temp = `${this.file}.${random()}.tmp`;
    try {
      fs.writeFileSync(temp, JSON.stringify(state), { mode: 0o600, flag: 'wx' });
      fs.renameSync(temp, this.file);
    } finally { fs.rmSync(temp, { force: true }); }
  }
  // Native messages spawn independent processes: serialize rotating-token writes on disk.
  async locked(fn) {
    fs.mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    const lock = path.join(this.directory, 'session.lock');
    const until = Date.now() + 45000;
    let handle;
    while (!handle) {
      try { handle = fs.openSync(lock, 'wx', 0o600); fs.writeSync(handle, String(process.pid)); }
      catch (e) {
        if (e.code !== 'EEXIST') throw e;
        try {
          const pid = Number(fs.readFileSync(lock, 'utf8'));
          if (pid > 0) {
            try { process.kill(pid, 0); } catch (err) { if (err.code === 'ESRCH') fs.rmSync(lock, { force: true }); }
          }
        } catch (err) { if (err.code !== 'ENOENT') throw err; }
        if (Date.now() >= until) throw fail('Another ChatGPT connection operation is still running. Try again.');
        await sleep(100);
      }
    }
    try { return await fn(); } finally { fs.closeSync(handle); fs.rmSync(lock, { force: true }); }
  }
  status() {
    const state = this.load();
    return {
      active: state.active,
      accounts: Object.values(state.accounts).map((p) => ({ id: p.client_id, email: p.email || '', connected: !!p.access_token, planEnabled: hasPlan(p) })),
    };
  }
  async json(url, init = {}) {
    let r;
    try { r = await this.fetch(url, { ...init, signal: AbortSignal.timeout(30000) }); }
    catch { throw fail('Could not reach OpenAI. Check your internet connection and try again.', 'CHATGPT_NETWORK'); }
    let data;
    try { data = await r.json(); } catch { throw fail('OpenAI returned unreadable connection data.'); }
    if (!r.ok) {
      const code = typeof data.error === 'string' ? data.error : data.error?.code;
      throw fail(`OpenAI connection failed (HTTP ${r.status}${code ? `, ${code}` : ''}). Try signing in again.`, code || 'CHATGPT_AUTH');
    }
    return data;
  }
  async metadata() {
    const data = await this.json(`${ISSUER}/.well-known/openid-configuration`);
    if (data.issuer !== ISSUER) throw fail('Unexpected OpenAI identity issuer.');
    secureAuthUrl(data.jwks_uri);
    if (data.revocation_endpoint) secureAuthUrl(data.revocation_endpoint);
    return data;
  }
  async identity(jwt, clientId, nonce) {
    const metadata = await this.metadata();
    return verifyIdentity(jwt, clientId, nonce, metadata, await this.json(secureAuthUrl(metadata.jwks_uri)));
  }
  tokens(data, previous = {}) {
    if (!data.access_token || typeof data.expires_in !== 'number' || data.expires_in <= 0 || data.token_type?.toLowerCase() !== 'bearer') throw fail('OpenAI returned incomplete credentials.');
    return { ...previous, access_token: data.access_token, refresh_token: data.refresh_token || previous.refresh_token, id_token: data.id_token || previous.id_token, scopes: data.scope === undefined ? previous.scopes || [] : data.scope.split(/\s+/).filter(Boolean), expires_at: Date.now() + data.expires_in * 1000 };
  }
  async token(form) {
    return this.json(TOKEN, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: form.toString() });
  }
  cancelSignIn() { this.cancel?.(); }
  async signIn(clientId, notify, consent = false) {
    if (this.cancel) throw fail('A ChatGPT sign-in is already running.');
    const initial = await this.locked(async () => { const s = this.load(); this.save(s); return s; });
    const previous = clientId ? initial.accounts[clientId] : null;
    if (clientId && !previous) throw fail('Unknown saved ChatGPT account.');
    const state = random(), nonce = random(), verifier = random();
    let resolveCallback, rejectCallback;
    const callback = new Promise((resolve, reject) => { resolveCallback = resolve; rejectCallback = reject; });
    // Mark handled even if opening the browser fails before awaiting the callback.
    callback.catch(() => {});
    let accepted = false;
    const server = http.createServer((req, res) => {
      const url = new URL(req.url, 'http://127.0.0.1');
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.setHeader('Cache-Control', 'no-store');
      if (req.method !== 'GET' || url.pathname !== '/auth/callback') { res.writeHead(404); res.end('Not found'); return; }
      if (url.searchParams.get('state') !== state) { res.writeHead(400); res.end('Invalid sign-in state.'); return; }
      if (accepted) { res.writeHead(409); res.end('Sign-in callback already received.'); return; }
      accepted = true;
      if (url.searchParams.has('error')) { res.end('Sign-in was declined. Return to JobPilot.'); rejectCallback(fail('ChatGPT sign-in was declined. You can try again or choose an API key.')); return; }
      const issued = url.searchParams.get('client_id') || previous?.client_id;
      if (!issued || issued === 'dynamic_agent_client' || (previous && issued !== previous.client_id) || !url.searchParams.get('code')) { res.writeHead(400); res.end('Invalid account registration.'); rejectCallback(fail('ChatGPT returned an invalid account registration.')); return; }
      res.end('Authorization received. Return to JobPilot to finish connecting.');
      resolveCallback({ code: url.searchParams.get('code'), clientId: issued });
    });
    const timer = setTimeout(() => rejectCallback(fail('ChatGPT sign-in timed out. Click Continue with ChatGPT to try again.')), this.signInTimeout);
    this.cancel = () => rejectCallback(fail('ChatGPT sign-in cancelled.'));
    try {
      await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
      const redirectUri = `http://127.0.0.1:${server.address().port}/auth/callback`;
      const params = new URLSearchParams({ client_id: previous?.client_id || 'dynamic_agent_client', ext_agent_host_id: initial.hostId, response_type: 'code', redirect_uri: redirectUri, scope: SCOPES, resource: RESOURCE, state, nonce, code_challenge_method: 'S256', code_challenge: crypto.createHash('sha256').update(verifier).digest('base64url') });
      if (previous) {
        if (previous.id_token) params.set('id_token_hint', previous.id_token);
        if (previous.email) params.set('login_hint', previous.email);
      } else params.set('agent_name_hint', 'JobPilot');
      if (consent) params.set('prompt', 'consent');
      await notify(`${AUTHORIZE}?${params}`);
      const result = await callback;
      // Retain issued registration even if the authorization code exchange expires.
      await this.locked(async () => {
        const s = this.load();
        if (!s.accounts[result.clientId]) s.accounts[result.clientId] = { client_id: result.clientId };
        this.save(s);
      });
      const data = await this.token(new URLSearchParams({ grant_type: 'authorization_code', client_id: result.clientId, code: result.code, code_verifier: verifier, redirect_uri: redirectUri, resource: RESOURCE }));
      const claims = await this.identity(data.id_token, result.clientId, nonce);
      if (previous?.subject && (claims.sub !== previous.subject || claims.iss !== previous.issuer)) throw fail('The signed-in ChatGPT identity does not match the selected account.');
      // The token response, never the callback scope, authorizes plan use.
      const account = this.tokens({ ...data, scope: data.scope || '' }, { client_id: result.clientId, issuer: claims.iss, subject: claims.sub, email: claims.email || '' });
      await this.locked(async () => {
        const s = this.load();
        const existing = s.accounts[result.clientId];
        if (existing?.subject && existing.subject !== claims.sub) throw fail('This ChatGPT registration belongs to another account.');
        s.accounts[result.clientId] = account;
        s.active = result.clientId;
        this.save(s);
      });
      return this.status();
    } finally {
      clearTimeout(timer);
      this.cancel = null;
      server.close();
      server.closeAllConnections();
    }
  }
  async access(clientId) {
    return this.locked(async () => {
      const s = this.load();
      const p = s.accounts[clientId];
      if (!p?.access_token) throw fail('Continue with ChatGPT in Settings first.');
      if (!hasPlan(p)) throw fail('ChatGPT plan usage is not enabled. Enable it in Settings or choose an API key.', 'CHATGPT_NO_PLAN');
      if (p.expires_at > Date.now() + 60000) return p.access_token;
      if (!p.refresh_token) throw fail('Your ChatGPT session expired. Continue with ChatGPT in Settings.');
      let data;
      try { data = await this.token(new URLSearchParams({ grant_type: 'refresh_token', client_id: p.client_id, refresh_token: p.refresh_token, resource: RESOURCE })); }
      catch (e) {
        if (['invalid_grant', 'invalid_refresh_token', 'token_expired', 'refresh_token_expired', 'refresh_token_invalidated', 'refresh_token_reused'].includes(e.code)) { clearTokens(p); this.save(s); }
        throw e;
      }
      if (data.id_token) {
        const claims = await this.identity(data.id_token, p.client_id);
        if (claims.sub !== p.subject || claims.iss !== p.issuer) throw fail('Refreshed ChatGPT identity does not match this account.');
      }
      const next = this.tokens(data, p);
      s.accounts[clientId] = next;
      this.save(s);
      if (!hasPlan(next)) throw fail('ChatGPT plan permission was removed. Enable it in Settings.', 'CHATGPT_NO_PLAN');
      return next.access_token;
    });
  }
  async models(clientId) {
    const token = await this.access(clientId);
    const response = await this.fetch(`${RESOURCE}/models`, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(30000) });
    const data = await response.json();
    if (!response.ok) throw inferenceError(response.status, data, response.headers.get('x-request-id'));
    if (!Array.isArray(data.models)) throw fail('ChatGPT returned an unexpected model catalog.');
    return data.models.filter((m) => m.visibility === 'list' && typeof m.slug === 'string').map((m) => ({ id: m.slug, label: m.display_name || m.slug }));
  }
  async run(clientId, model, opts) {
    const token = await this.access(clientId);
    if (!model || typeof model !== 'string') throw fail('Select a ChatGPT model in Settings first.');
    const formatPath = fs.existsSync(path.join(__dirname, 'openai.mjs')) ? path.join(__dirname, 'openai.mjs') : path.join(__dirname, '../extension/lib/openai.js');
    const { buildOpenAIRequest, parseOpenAIResponse } = await import(pathToFileURL(formatPath).href);
    const body = buildOpenAIRequest(model, opts);
    delete body.max_output_tokens;
    delete body.reasoning;
    body.stream = true;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 120000);
    try {
      let response;
      for (let attempt = 0; attempt < 2; attempt++) {
        response = await this.fetch(`${RESOURCE}/responses`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify(body), signal: controller.signal });
        if (response.status < 500 || attempt === 1) break;
        await response.body?.cancel();
        await sleep(750);
      }
      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw inferenceError(response.status, data, response.headers.get('x-request-id'));
      }
      return parseOpenAIResponse(await readResponseStream(response));
    } catch (e) {
      if (e.name === 'AbortError') throw fail('ChatGPT took too long (2 minutes). Try again.', 'CHATGPT_TIMEOUT');
      if (e instanceof TypeError) throw fail('Could not reach ChatGPT. Check your internet connection.', 'CHATGPT_NETWORK');
      throw e;
    } finally { clearTimeout(timer); }
  }
  async signOut(clientId) {
    let revoked = false;
    await this.locked(async () => {
      const s = this.load(), p = s.accounts[clientId];
      if (!p) throw fail('Unknown saved ChatGPT account.');
      try {
        if (p.refresh_token) {
          const metadata = await this.metadata();
          const url = secureAuthUrl(metadata.revocation_endpoint);
          for (let attempt = 0; attempt < 2; attempt++) {
            const r = await this.fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ token: p.refresh_token, token_type_hint: 'refresh_token', client_id: p.client_id }).toString(), signal: AbortSignal.timeout(10000) }).catch(() => null);
            if (r?.status === 200) { revoked = true; break; }
            if (r && r.status < 500) break;
            if (attempt === 0) await sleep(500);
          }
        } else revoked = true;
      } catch { /* Clear locally even when remote revocation cannot be confirmed. */ }
      clearTokens(p);
      if (s.active === clientId) s.active = null;
      this.save(s);
    });
    return { ...this.status(), revoked };
  }
  async select(clientId) {
    await this.locked(async () => { const s = this.load(); if (!s.accounts[clientId]) throw fail('Unknown saved ChatGPT account.'); s.active = clientId; this.save(s); });
    return this.status();
  }
}
module.exports = { ChatGPT, verifyIdentity, readResponseStream };
