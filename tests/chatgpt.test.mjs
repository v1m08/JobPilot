import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
const { ChatGPT, verifyIdentity, readResponseStream } = createRequire(import.meta.url)('../bridge/chatgpt.js');
const nativeFetch = globalThis.fetch;
const dirs = [];
const issuer = 'https://auth.openai.com';
const resource = 'https://api.openai.com/v1';
const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'test-key', alg: 'RS256', use: 'sig' };
const metadata = { issuer, jwks_uri: `${issuer}/jwks`, revocation_endpoint: `${issuer}/revoke` };
const json = (value, status = 200) => new Response(JSON.stringify(value), { status });
const claimsFor = (clientId, nonce) => ({ iss: issuer, sub: 'person', aud: clientId, nonce, exp: Math.floor(Date.now() / 1000) + 3600, email: 'person@example.test' });
function jwt(claims) {
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', kid: 'test-key' })).toString('base64url');
  const body = Buffer.from(JSON.stringify(claims)).toString('base64url');
  const signature = crypto.sign('RSA-SHA256', Buffer.from(`${header}.${body}`), privateKey).toString('base64url');
  return `${header}.${body}.${signature}`;
}
const completed = (value) => ({ status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(value) }] }] });
function stream(events, chunkSize = 11) {
  const bytes = new TextEncoder().encode(events.map((event) => `event: ${event.type}\r\ndata: ${JSON.stringify(event)}\r\n\r\n`).join(''));
  return new Response(new ReadableStream({ start(controller) { for (let i = 0; i < bytes.length; i += chunkSize) controller.enqueue(bytes.slice(i, i + chunkSize)); controller.close(); } }));
}
function service(fetchImpl) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jobpilot-chatgpt-test-')); dirs.push(dir);
  return new ChatGPT({ directory: dir, fetchImpl, signInTimeout: 1000 });
}
const profile = (id, overrides = {}) => ({ client_id: id, issuer, subject: 'person', email: 'person@example.test', access_token: 'access', refresh_token: 'refresh', id_token: 'retained-identity', scopes: ['chatgpt.tokens.use.direct'], expires_at: Date.now() + 3600000, ...overrides });
function seed(svc, accounts = { a: profile('a') }, active = 'a') { svc.save({ hostId: 'urn:uuid:11111111-1111-4111-8111-111111111111', accounts, active }); }
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });

function authFixture({ scopes = 'openid email chatgpt.tokens.use.direct', tokenError, claims = {} } = {}) {
  let authUrl, tokenForm;
  const svc = service(async (url, init) => {
    if (url.endsWith('/openid-configuration')) return json(metadata);
    if (url.endsWith('/jwks')) return json({ keys: [jwk] });
    if (url.endsWith('/oauth/token')) {
      tokenForm = new URLSearchParams(init.body);
      if (tokenError) return json({ error: tokenError }, 400);
      return json({ token_type: 'Bearer', access_token: 'private-access', refresh_token: 'private-refresh', expires_in: 3600, scope: scopes, id_token: jwt({ ...claimsFor(tokenForm.get('client_id'), authUrl.searchParams.get('nonce')), ...claims }) });
    }
    throw new Error(`Unexpected URL: ${url}`);
  });
  const notify = async (url, callbackId = 'oaiapp_first') => {
    authUrl = new URL(url);
    const callback = new URL(authUrl.searchParams.get('redirect_uri'));
    callback.searchParams.set('state', authUrl.searchParams.get('state'));
    callback.searchParams.set('code', 'code');
    if (callbackId) callback.searchParams.set('client_id', callbackId);
    const r = await nativeFetch(callback);
    await r.text();
  };
  return { svc, notify, get url() { return authUrl; }, get form() { return tokenForm; } };
}

test('sign-in uses loopback PKCE, validates identity and persists only protected local tokens', async () => {
  const f = authFixture();
  const session = await f.svc.signIn(undefined, f.notify);
  assert.equal(f.url.origin, issuer);
  assert.equal(f.url.searchParams.get('client_id'), 'dynamic_agent_client');
  assert.equal(f.url.searchParams.get('agent_name_hint'), 'JobPilot');
  assert.equal(new URL(f.url.searchParams.get('redirect_uri')).hostname, '127.0.0.1');
  assert.equal(new URL(f.url.searchParams.get('redirect_uri')).pathname, '/auth/callback');
  assert.equal(f.form.get('redirect_uri'), f.url.searchParams.get('redirect_uri'));
  assert.equal(f.form.get('client_id'), 'oaiapp_first');
  assert.equal(f.form.get('resource'), resource);
  assert.equal(crypto.createHash('sha256').update(f.form.get('code_verifier')).digest('base64url'), f.url.searchParams.get('code_challenge'));
  assert.equal(session.accounts[0].planEnabled, true);
  assert.equal(session.active, 'oaiapp_first');
  assert.doesNotMatch(JSON.stringify(session), /private-access|private-refresh|id_token/);
  assert.equal(f.svc.load().accounts.oaiapp_first.access_token, 'private-access');
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(f.svc.file).mode & 0o777, 0o600);
    assert.equal(fs.statSync(f.svc.directory).mode & 0o777, 0o700);
  }
});

test('returning sign-in reuses client and host, hints the identity, and preserves other registrations', async () => {
  const f = authFixture(); seed(f.svc, { oaiapp_first: profile('oaiapp_first'), other: profile('other') }, 'other');
  const before = f.svc.load();
  await f.svc.signIn('oaiapp_first', (url) => f.notify(url, null));
  assert.equal(f.url.searchParams.get('client_id'), 'oaiapp_first');
  assert.equal(f.url.searchParams.get('ext_agent_host_id'), before.hostId);
  assert.equal(f.url.searchParams.get('agent_name_hint'), null);
  assert.equal(f.url.searchParams.get('id_token_hint'), 'retained-identity');
  assert.deepEqual(f.svc.load().accounts.other, before.accounts.other);
});

test('callback state mismatch is rejected without consuming the valid attempt', async () => {
  const f = authFixture();
  await f.svc.signIn(undefined, async (url) => {
    const u = new URL(url), callback = new URL(u.searchParams.get('redirect_uri'));
    callback.searchParams.set('state', 'wrong');
    const r = await nativeFetch(callback); assert.equal(r.status, 400); await r.text();
    await f.notify(url);
  });
  assert.equal(f.svc.status().active, 'oaiapp_first');
});

test('declined consent and sign-in cancellation stop the attempt', async () => {
  const f = authFixture();
  await assert.rejects(f.svc.signIn(undefined, async (url) => {
    const u = new URL(url), callback = new URL(u.searchParams.get('redirect_uri'));
    callback.searchParams.set('state', u.searchParams.get('state')); callback.searchParams.set('error', 'access_denied');
    await nativeFetch(callback);
  }), /declined/);
  assert.equal(f.svc.status().accounts.length, 0);
  await assert.rejects(f.svc.signIn(undefined, async () => f.svc.cancelSignIn()), /cancelled/);
});

test('token scope controls plan access even if identity sign-in succeeds', async () => {
  const f = authFixture({ scopes: 'openid email' });
  const session = await f.svc.signIn(undefined, f.notify);
  assert.equal(session.accounts[0].connected, true);
  assert.equal(session.accounts[0].planEnabled, false);
  await assert.rejects(f.svc.access('oaiapp_first'), /not enabled/);
});

test('failed code exchange retains the issued registration for a fresh sign-in', async () => {
  const f = authFixture({ tokenError: 'invalid_grant' });
  await assert.rejects(f.svc.signIn(undefined, f.notify), /invalid_grant/);
  assert.equal(f.svc.load().accounts.oaiapp_first.client_id, 'oaiapp_first');
  assert.equal(f.svc.load().accounts.oaiapp_first.access_token, undefined);
});

test('returning registration and identity mismatches cannot overwrite credentials', async () => {
  const f = authFixture({ claims: { sub: 'wrong-person' } }); seed(f.svc, { oaiapp_first: profile('oaiapp_first') }, 'oaiapp_first');
  const before = f.svc.load();
  await assert.rejects(f.svc.signIn('oaiapp_first', (url) => f.notify(url)), /does not match/);
  assert.deepEqual(f.svc.load(), before);
  await assert.rejects(f.svc.signIn('oaiapp_first', (url) => f.notify(url, 'different-client')), /invalid account/);
  assert.deepEqual(f.svc.load(), before);
});

test('ID token validation rejects wrong issuer, audience, expiry, nonce and signature', async () => {
  for (const patch of [{ iss: 'https://evil.example' }, { aud: 'other' }, { exp: 1 }, { nonce: 'wrong' }, { aud: ['a', 'b'] }]) {
    await assert.rejects(verifyIdentity(jwt({ ...claimsFor('a', 'nonce'), ...patch }), 'a', 'nonce', metadata, { keys: [jwk] }), /validation/);
  }
  const valid = jwt(claimsFor('a', 'nonce'));
  const parts = valid.split('.'); parts[2] = Buffer.from('invalid').toString('base64url');
  await assert.rejects(verifyIdentity(parts.join('.'), 'a', 'nonce', metadata, { keys: [jwk] }), /signature/);
  await assert.rejects(verifyIdentity(valid, 'a', 'nonce', metadata, { keys: [] }), /signature/);
});

test('concurrent bridge instances serialize refreshes and store the rotating refresh token', async () => {
  let refreshes = 0;
  const svc = service(async (url, init) => {
    refreshes++; const form = new URLSearchParams(init.body);
    assert.equal(form.get('client_id'), 'a'); assert.equal(form.get('scope'), null);
    assert.equal(form.get('resource'), resource); assert.equal(form.get('refresh_token'), 'refresh');
    await new Promise((resolve) => setTimeout(resolve, 30));
    return json({ token_type: 'Bearer', access_token: 'renewed', refresh_token: 'rotated', expires_in: 3600 });
  });
  seed(svc, { a: profile('a', { expires_at: 0 }) });
  const other = new ChatGPT({ directory: svc.directory, fetchImpl: svc.fetch });
  assert.deepEqual(await Promise.all([svc.access('a'), other.access('a')]), ['renewed', 'renewed']);
  assert.equal(refreshes, 1); assert.equal(svc.load().accounts.a.refresh_token, 'rotated');
});

test('temporary refresh failure preserves credentials; terminal invalid grant clears only tokens', async () => {
  const svc = service(async () => json({ error: 'temporarily_unavailable' }, 503));
  seed(svc, { a: profile('a', { expires_at: 0 }) });
  await assert.rejects(svc.access('a'));
  assert.equal(svc.load().accounts.a.refresh_token, 'refresh');
  svc.fetch = async () => json({ error: 'invalid_grant' }, 400);
  await assert.rejects(svc.access('a'));
  assert.equal(svc.load().accounts.a.access_token, undefined);
  assert.equal(svc.load().accounts.a.client_id, 'a');
});

test('model picker uses the account catalog in server order and hides non-list models', async () => {
  const svc = service(async (url, init) => {
    assert.equal(url, `${resource}/models`); assert.equal(init.headers.Authorization, 'Bearer access');
    return json({ models: [{ slug: 'first', display_name: 'First', visibility: 'list' }, { slug: 'hidden', visibility: 'hide' }, { slug: 'second', display_name: 'Second', visibility: 'list' }] });
  }); seed(svc);
  assert.deepEqual(await svc.models('a'), [{ id: 'first', label: 'First' }, { id: 'second', label: 'Second' }]);
});

test('subscription inference uses streaming, strict JSON and PDF input without API-key-only fields', async () => {
  const svc = service(async (url, init) => {
    assert.equal(url, `${resource}/responses`); assert.equal(init.headers.Authorization, 'Bearer access');
    const body = JSON.parse(init.body);
    assert.equal(body.stream, true); assert.equal(body.store, false);
    assert.equal(body.max_output_tokens, undefined); assert.equal(body.reasoning, undefined);
    assert.equal(body.model, 'account-model');
    assert.equal(body.text.format.strict, true);
    assert.equal(body.input[0].content[0].file_data, 'data:application/pdf;base64,cGRm');
    return stream([{ type: 'response.output_text.delta', delta: '{partial', output_index: 0, content_index: 0 }, { type: 'response.completed', response: completed({ ok: 'OK' }) }]);
  }); seed(svc);
  const result = await svc.run('a', 'account-model', { system: 'Return JSON', content: [{ type: 'document', source: { media_type: 'application/pdf', data: 'cGRm' } }], schema: { type: 'object' } });
  assert.deepEqual(result, { ok: 'OK' });
});

test('stream reader handles arbitrary CRLF/UTF-8 boundaries and rejects incomplete/disconnected streams', async () => {
  assert.deepEqual(await readResponseStream(stream([{ type: 'response.completed', response: completed({ text: 'café 🎉' }) }], 1)), completed({ text: 'café 🎉' }));
  await assert.rejects(readResponseStream(stream([{ type: 'response.output_text.delta', delta: '{}', output_index: 0, content_index: 0 }])), /disconnected/);
  await assert.rejects(readResponseStream(stream([{ type: 'response.incomplete', response: {} }])), /incomplete/);
  await assert.rejects(readResponseStream(stream([{ type: 'response.failed', response: { error: { code: 'subscription_sharing_usage_limit_exceeded' } } }])), /usage limit/);
});

test('subscription errors never switch to API billing or delete valid credentials', async () => {
  let calls = 0;
  const svc = service(async () => { calls++; return json({ error: { code: 'subscription_sharing_usage_limit_exceeded' } }, 429); }); seed(svc);
  await assert.rejects(svc.run('a', 'model', { system: '', content: 'hello', schema: {} }), /Manage usage/);
  assert.equal(calls, 1); assert.equal(svc.load().accounts.a.access_token, 'access');
});

test('sign-out revokes remotely and clears local tokens while retaining client and host', async () => {
  let revocation;
  const svc = service(async (url, init) => {
    if (url.endsWith('/openid-configuration')) return json(metadata);
    assert.equal(url, metadata.revocation_endpoint); revocation = new URLSearchParams(init.body);
    return new Response(null, { status: 200 });
  }); seed(svc);
  const result = await svc.signOut('a');
  assert.equal(result.revoked, true); assert.equal(result.active, null);
  assert.equal(revocation.get('token'), 'refresh'); assert.equal(revocation.get('client_id'), 'a');
  assert.equal(svc.load().accounts.a.access_token, undefined); assert.equal(svc.load().accounts.a.id_token, undefined);
  assert.equal(svc.load().accounts.a.client_id, 'a'); assert.match(svc.load().hostId, /^urn:uuid:/);
});

test('unconfirmed revocation is reported while tokens are cleared locally', async () => {
  const svc = service(async (url) => url.endsWith('/openid-configuration') ? json(metadata) : new Response(null, { status: 400 })); seed(svc);
  const result = await svc.signOut('a'); assert.equal(result.revoked, false); assert.equal(svc.status().accounts[0].connected, false);
});

test('installer packages subscription bridge and shared adapter in isolated browser directory', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jobpilot-installer-test-')); dirs.push(dir);
  const install = path.join(dir, 'bridge'), browser = path.join(dir, 'browser');
  const result = spawnSync(process.execPath, ['bridge/install.js', '--install-dir', install, '--browser-dir', browser], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.ok(fs.existsSync(path.join(install, 'chatgpt.js'))); assert.ok(fs.existsSync(path.join(install, 'openai.mjs')));
  const manifest = JSON.parse(fs.readFileSync(path.join(browser, 'NativeMessagingHosts/com.jobpilot.claude_bridge.json')));
  assert.deepEqual(manifest.allowed_origins, ['chrome-extension://domfhjgaedjaoioaidcpgcjbleagfbgg/']);
  const frame = Buffer.from(JSON.stringify({ type: 'chatgpt-status' })); const length = Buffer.alloc(4); length.writeUInt32LE(frame.length);
  const host = spawnSync(process.execPath, ['-e', `require('node:os').homedir = () => ${JSON.stringify(dir)}; require(${JSON.stringify(path.join(install, 'host.js'))});`], { input: Buffer.concat([length, frame]) });
  assert.equal(host.status, 0, host.stderr.toString());
  const reply = JSON.parse(host.stdout.subarray(4)); assert.equal(reply.ok, true); assert.equal(reply.bridgeVersion, '1.4.1');
  assert.doesNotMatch(JSON.stringify(reply), /access_token|refresh_token|id_token/);
});

test('temporary direct-route failures use bounded backoff and preserve the selected billing path', async () => {
  let calls = 0;
  const svc = service(async () => ++calls === 1 ? json({ detail: 'temporary' }, 503) : stream([{ type: 'response.completed', response: completed({ ok: 'OK' }) }]));
  seed(svc);
  assert.deepEqual(await svc.run('a', 'model', { system: '', content: 'hello', schema: {} }), { ok: 'OK' });
  assert.equal(calls, 2);
});

test('sign-in times out and closes its loopback listener', async () => {
  const f = authFixture(); f.svc.signInTimeout = 20;
  let callback;
  await assert.rejects(f.svc.signIn(undefined, async (url) => { callback = new URL(url).searchParams.get('redirect_uri'); }), /timed out/);
  await assert.rejects(nativeFetch(callback));
});

test('GPT-6.1 Sol subscription stream retains JSON when terminal output is empty', async () => {
  const item = { id: 'msg_test', type: 'message', role: 'assistant', phase: 'final_answer', status: 'completed', content: [{ type: 'output_text', text: '{"ok":"OK"}' }] };
  const events = [
    { type: 'response.output_item.added', output_index: 0, item: { ...item, status: 'in_progress', content: [] } },
    { type: 'response.content_part.added', output_index: 0, content_index: 0, part: { type: 'output_text', text: '' } },
    { type: 'response.output_text.delta', output_index: 0, content_index: 0, delta: '{"ok":' },
    { type: 'response.output_text.delta', output_index: 0, content_index: 0, delta: '"OK"}' },
    { type: 'response.output_text.done', output_index: 0, content_index: 0, text: '{"ok":"OK"}' },
    { type: 'response.content_part.done', output_index: 0, content_index: 0, part: item.content[0] },
    { type: 'response.output_item.done', output_index: 0, item },
    { type: 'response.completed', response: { status: 'completed', output: [] } },
  ];
  const svc = service(async () => stream(events, 1)); seed(svc);
  assert.deepEqual(await svc.run('a', 'gpt-6.1-sol', { system: 'Return JSON', content: 'Return OK', schema: {} }), { ok: 'OK' });
});

test('streamed commentary is separate from the final JSON, including in an empty terminal snapshot', async () => {
  const events = [
    { type: 'response.output_item.done', output_index: 0, item: { type: 'message', phase: 'commentary', content: [{ type: 'output_text', text: 'I will parse your resume.' }] } },
    { type: 'response.output_item.done', output_index: 1, item: { type: 'message', phase: 'final_answer', content: [{ type: 'output_text', text: '{"ok":"OK"}' }] } },
    { type: 'response.completed', response: { status: 'completed', output: [] } },
  ];
  const svc = service(async () => stream(events)); seed(svc);
  assert.deepEqual(await svc.run('a', 'gpt-6.1-sol', { system: '', content: 'OK', schema: {} }), { ok: 'OK' });
});

test('output_text.done alone supplies the final text without duplicating streamed deltas', async () => {
  const output = await readResponseStream(stream([
    { type: 'response.output_text.delta', output_index: 0, content_index: 0, delta: '{"ok":' },
    { type: 'response.output_text.done', output_index: 0, content_index: 0, text: '{"ok":"OK"}' },
    { type: 'response.completed', response: { status: 'completed', output: [] } },
  ]));
  assert.equal(output.output[0].content[0].text, '{"ok":"OK"}');
});

test('completed streams still detect refusals from earlier events', async () => {
  const svc = service(async () => stream([
    { type: 'response.refusal.delta', output_index: 0, content_index: 0, delta: 'Declined' },
    { type: 'response.refusal.done', output_index: 0, content_index: 0, refusal: 'Declined' },
    { type: 'response.completed', response: { status: 'completed', output: [] } },
  ])); seed(svc);
  await assert.rejects(svc.run('a', 'gpt-6.1-sol', { system: '', content: 'OK', schema: {} }), /declined/);
});
