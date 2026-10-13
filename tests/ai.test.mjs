import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { callOpenAI } from '../extension/lib/openai.js';
import { isConfigured, parseResume, rewriteAndAnswer, testConnection } from '../extension/lib/ai.js';
import { getSettings } from '../extension/lib/store.js';

const settings = { provider: 'openai', openaiApiKey: 'test-openai-key', openaiModel: 'gpt-5-mini', apiKey: 'test-anthropic-key', model: 'claude-sonnet-5-5' };
const schema = { type: 'object', properties: { ok: { type: 'string' } }, required: ['ok'], additionalProperties: false };
const opts = { system: 'Return JSON.', content: 'Hello', schema };
const completed = (value) => ({ status: 'completed', output: [{ type: 'reasoning', summary: [] }, { type: 'message', content: [{ type: 'output_text', text: JSON.stringify(value) }] }] });
const response = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
let calls, storage, native;
beforeEach(() => {
  calls = []; storage = {}; native = [];
  globalThis.fetch = async (url, init) => { calls.push({ url, init, body: JSON.parse(init.body) }); return response(completed({ ok: 'OK' })); };
  globalThis.chrome = {
    storage: { local: { get: async (key) => ({ [key]: storage[key] }), set: async (values) => Object.assign(storage, values) } },
    runtime: { sendNativeMessage: (host, message, callback) => { native.push({ host, message }); callback({ ok: true, data: { ok: 'Claude' } }); } },
  };
});

test('OpenAI sends strict structured outputs, isolated credentials and no stored response', async () => {
  assert.deepEqual(await callOpenAI(settings, opts), { ok: 'OK' });
  assert.equal(calls[0].url, 'https://api.openai.com/v1/responses');
  assert.equal(calls[0].init.headers.Authorization, 'Bearer test-openai-key');
  assert.equal(calls[0].body.store, false);
  assert.deepEqual(calls[0].body.text.format, { type: 'json_schema', name: 'jobpilot_result', strict: true, schema });
  assert.deepEqual(calls[0].body.reasoning, { effort: 'low' });
  assert.equal(calls[0].body.instructions, opts.system);
  assert.deepEqual(calls[0].body.input[0].content, [{ type: 'input_text', text: 'Hello' }]);
});

test('PDF parsing translates the existing resume input and schema to OpenAI', async () => {
  await parseResume(settings, 'JVBERi0=');
  assert.deepEqual(calls[0].body.input[0].content[0], { type: 'input_file', filename: 'resume.pdf', file_data: 'data:application/pdf;base64,JVBERi0=' });
  assert.ok(calls[0].body.text.format.schema.properties.sections);
});

test('GPT-4.1 omits reasoning options and uses its own cache', async () => {
  await parseResume(settings, 'pdf');
  await parseResume({ ...settings, openaiModel: 'gpt-4.1' }, 'pdf');
  assert.equal(calls.length, 2);
  assert.equal(calls[1].body.model, 'gpt-4.1');
  assert.equal(calls[1].body.reasoning, undefined);
});

test('provider caches are separate and Claude Code still uses its bridge', async () => {
  assert.deepEqual(await parseResume(settings, 'pdf'), { ok: 'OK' });
  assert.deepEqual(await parseResume(settings, 'pdf'), { ok: 'OK' });
  assert.equal(calls.length, 1);
  assert.deepEqual(await parseResume({ ...settings, provider: 'claude-code', ccModel: 'sonnet' }, 'pdf'), { ok: 'Claude' });
  assert.equal(native.length, 1);
  assert.equal(native[0].message.pdfBase64, 'pdf');
  assert.equal(native[0].message.model, 'sonnet');
});

test('Anthropic API routing keeps the Anthropic key and request format', async () => {
  globalThis.fetch = async (url, init) => { calls.push({ url: String(url), init }); return response({ content: [{ type: 'text', text: '{"ok":"Anthropic"}' }], stop_reason: 'end_turn' }); };
  assert.deepEqual(await parseResume({ ...settings, provider: 'api' }, 'pdf'), { ok: 'Anthropic' });
  assert.match(calls[0].url, /api\.anthropic\.com/);
  const headers = new Headers(calls[0].init.headers);
  assert.equal(headers.get('x-api-key'), settings.apiKey);
  assert.equal(headers.get('authorization'), null);
});

test('Autopilot request retains the rule against drafting text answers', async () => {
  await rewriteAndAnswer(settings, { bullets: [], keywords: [], posting: 'A job', questions: [{ qid: 'q', question: 'Why us?', kind: 'long_text' }], resumeText: 'Resume', profile: {}, company: 'Example', role: 'Intern', draftText: false });
  assert.match(calls[0].body.input[0].content[0].text, /Don't write answers for short_text or long_text/);
  assert.deepEqual(calls[0].body.reasoning, { effort: 'medium' });
});

test('missing OpenAI credentials cannot use an Anthropic key or cached result', async () => {
  await parseResume(settings, 'pdf');
  const missing = { ...settings, openaiApiKey: '' };
  assert.equal(isConfigured(missing), false);
  await assert.rejects(parseResume(missing, 'pdf'), /Connect AI/);
  await assert.rejects(callOpenAI(missing, opts), /OpenAI API key/);
  assert.equal(calls.length, 1);
});

test('connection test always makes a fresh request', async () => {
  assert.equal(await testConnection(settings), 'OK');
  assert.equal(await testConnection(settings), 'OK');
  assert.equal(calls.length, 2);
});

test('HTTP authentication and quota failures are actionable and never retried', async () => {
  for (const [status, code, expected] of [[401, 'invalid_api_key', /rejected/], [429, 'insufficient_quota', /quota/], [403, 'permission_denied', /access/], [404, 'model_not_found', /not found/]]) {
    let attempts = 0;
    globalThis.fetch = async () => { attempts++; return response({ error: { code } }, status); };
    await assert.rejects(callOpenAI(settings, opts), expected);
    assert.equal(attempts, 1);
  }
});

test('transient server errors retry and then parse the response', async () => {
  let attempts = 0;
  globalThis.fetch = async () => ++attempts === 1 ? response({ error: {} }, 500) : response(completed({ ok: 'OK' }));
  assert.deepEqual(await callOpenAI(settings, opts), { ok: 'OK' });
  assert.equal(attempts, 2);
});

test('refusals, incomplete output, malformed data and network errors are not cached', async () => {
  for (const [data, expected] of [
    [{ status: 'completed', output: [{ type: 'message', content: [{ type: 'refusal', refusal: 'No' }] }] }, /declined/],
    [{ status: 'incomplete', output: [] }, /incomplete/],
    [{ status: 'failed', output: [] }, /complete/],
    [{ status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: '{bad' }] }] }, /JSON object/],
  ]) {
    globalThis.fetch = async () => response(data);
    await assert.rejects(parseResume(settings, 'error-pdf'), expected);
    assert.deepEqual(storage.aiCache || {}, {});
  }
  globalThis.fetch = async () => { throw new TypeError('Failed to fetch'); };
  await assert.rejects(callOpenAI(settings, opts), /internet connection/);
});

test('existing stored Claude settings survive new OpenAI defaults', async () => {
  storage.settings = { provider: 'api', apiKey: 'existing-key', model: 'claude-opus-5-5' };
  const merged = await getSettings();
  assert.equal(merged.apiKey, 'existing-key');
  assert.equal(merged.model, 'claude-opus-5-5');
  assert.equal(merged.provider, 'api');
  assert.equal(merged.openaiApiKey, '');
  assert.equal(merged.openaiModel, 'gpt-5-mini');
});

test('ChatGPT routes through native messaging with account-specific caches and no API credentials', async () => {
  const subscription = { ...settings, provider: 'chatgpt', chatgptAccountId: 'account-1', chatgptPlanEnabled: true, chatgptModel: 'account-model' };
  chrome.runtime.sendNativeMessage = (host, message, callback) => {
    native.push({ host, message });
    if (message.type === 'chatgpt-status') callback({ ok: true, session: { accounts: [{ id: subscription.chatgptAccountId, planEnabled: true }] } });
    else callback({ ok: true, data: { ok: subscription.chatgptAccountId } });
  };
  assert.deepEqual(await parseResume(subscription, 'pdf'), { ok: 'account-1' });
  await parseResume(subscription, 'pdf');
  assert.equal(native.filter((n) => n.message.type === 'chatgpt-run').length, 1);
  subscription.chatgptAccountId = 'account-2';
  assert.deepEqual(await parseResume(subscription, 'pdf'), { ok: 'account-2' });
  assert.equal(native.filter((n) => n.message.type === 'chatgpt-run').length, 2);
  assert.equal(calls.length, 0);
  assert.doesNotMatch(JSON.stringify(native), /test-openai-key|test-anthropic-key/);
});

test('a signed-out ChatGPT account cannot reuse cached results', async () => {
  const subscription = { provider: 'chatgpt', chatgptAccountId: 'a', chatgptPlanEnabled: true, chatgptModel: 'model' };
  chrome.runtime.sendNativeMessage = (host, message, callback) => callback(message.type === 'chatgpt-status' ? { ok: true, session: { accounts: [{ id: 'a', planEnabled: true }] } } : { ok: true, data: { ok: 'OK' } });
  await parseResume(subscription, 'pdf');
  chrome.runtime.sendNativeMessage = (host, message, callback) => callback({ ok: true, session: { accounts: [{ id: 'a', planEnabled: false }] } });
  await assert.rejects(parseResume(subscription, 'pdf'), /Continue with ChatGPT/);
  assert.equal(isConfigured({ ...subscription, chatgptPlanEnabled: false, apiKey: 'other-provider' }), false);
});

test('ChatGPT connection tests bypass cache and verify the selected model', async () => {
  const subscription = { provider: 'chatgpt', chatgptAccountId: 'a', chatgptModel: 'live-model' };
  chrome.runtime.sendNativeMessage = (host, message, callback) => { native.push({ host, message }); callback({ ok: true, data: { ok: 'OK' } }); };
  await testConnection(subscription); await testConnection(subscription);
  assert.equal(native.length, 2);
  assert.equal(native[0].message.type, 'chatgpt-run');
  assert.equal(native[0].message.model, 'live-model');
});

test('ChatGPT sign-in opens only the official authorization URL and completes on a native result', async () => {
  const { signInChatGPT } = await import('../extension/lib/ai.js');
  let onMessage, onDisconnect, request, opened;
  const session = { active: 'a', accounts: [{ id: 'a', planEnabled: true }] };
  chrome.runtime.connectNative = () => ({
    onMessage: { addListener: (fn) => { onMessage = fn; } },
    onDisconnect: { addListener: (fn) => { onDisconnect = fn; } },
    disconnect: () => onDisconnect(),
    postMessage: (message) => {
      request = message;
      queueMicrotask(() => {
        onMessage({ event: 'chatgpt-authorize', url: 'https://auth.openai.com/api/accounts/authorize?state=foo' });
        onMessage({ ok: true, session });
      });
    },
  });
  chrome.tabs = { create: async ({ url }) => { opened = url; } };
  assert.deepEqual(await signInChatGPT('a'), session);
  assert.equal(request.accountId, 'a'); assert.match(opened, /^https:\/\/auth\.openai\.com\//);
  chrome.runtime.connectNative = () => ({
    onMessage: { addListener: (fn) => { onMessage = fn; } },
    onDisconnect: { addListener: (fn) => { onDisconnect = fn; } },
    disconnect: () => onDisconnect(),
    postMessage: () => queueMicrotask(() => onMessage({ event: 'chatgpt-authorize', url: 'https://evil.example/authorize' })),
  });
  await assert.rejects(signInChatGPT(), /Unexpected/);
});

test('ChatGPT usage limits stop new Autopilot jobs and do not invoke API billing', async () => {
  chrome.runtime.sendNativeMessage = (host, message, callback) => callback({ ok: false, code: 'subscription_sharing_usage_limit_exceeded', error: 'Manage usage in ChatGPT Settings.' });
  await assert.rejects(testConnection({ provider: 'chatgpt', chatgptAccountId: 'a', chatgptModel: 'model' }), /Manage usage/);
  assert.equal(storage.autopilotStop, true);
  assert.equal(calls.length, 0);
});

test('OpenAI parses the final answer separately from commentary and earlier messages', async () => {
  const { parseOpenAIResponse } = await import('../extension/lib/openai.js');
  assert.deepEqual(parseOpenAIResponse({ status: 'completed', output: [
    { type: 'message', phase: 'commentary', content: [{ type: 'output_text', text: 'Working on it.' }] },
    { type: 'message', phase: 'final_answer', content: [{ type: 'output_text', text: '{"ok":"OK"}' }] },
  ] }), { ok: 'OK' });
  assert.deepEqual(parseOpenAIResponse({ status: 'completed', output: [
    { type: 'message', content: [{ type: 'output_text', text: 'Working on it.' }] },
    { type: 'message', content: [{ type: 'output_text', text: '{"ok":"OK"}' }] },
  ] }), { ok: 'OK' });
});

test('empty OpenAI output is diagnosed separately from invalid JSON without exposing response text', async () => {
  const { parseOpenAIResponse } = await import('../extension/lib/openai.js');
  assert.throws(() => parseOpenAIResponse({ status: 'completed', output: [] }), { code: 'OPENAI_EMPTY_OUTPUT' });
  assert.throws(() => parseOpenAIResponse(completed('private non-JSON answer')), { code: 'OPENAI_INVALID_JSON' });
  try { parseOpenAIResponse(completed('private non-JSON answer')); } catch (e) { assert.doesNotMatch(e.message, /private/); }
});
