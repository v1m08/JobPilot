import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { extractCode, pickVerifyLink, testGmail, waitForEmail } from '../extension/lib/gmail.js';

// Gmail's inbox feed (mail.google.com/mail/u/N/feed/atom), mocked: two
// signed-in accounts, the second one is the profile's.
const entry = ({ title, summary, from = 'Acme Careers', email = 'no-reply@acme.com', issued, href = 'https://mail.google.com/mail?account_id=x&message_id=1&view=conv&extsrc=atom' }) =>
  `<entry><title>${title}</title><summary>${summary}</summary><link rel="alternate" href="${href.replace(/&/g, '&amp;')}" type="text/html" /><issued>${issued}</issued><author><name>${from}</name><email>${email}</email></author></entry>`;
const feed = (owner, entries) => `<?xml version="1.0" encoding="UTF-8"?><feed version="0.3" xmlns="http://purl.org/atom/ns#"><title>Gmail - Inbox for ${owner}</title><fullcount>${entries.length}</fullcount>${entries.join('')}</feed>`;

let inboxes;
beforeEach(() => {
  inboxes = { 0: feed('other.person@gmail.com', []), 1: feed('student@gmail.com', []) };
  globalThis.fetch = async (url) => {
    const u = Number((String(url).match(/\/u\/(\d+)\//) || [])[1]);
    if (!(u in inboxes)) return new Response('<html>Sign in</html>', { status: 200 });
    return new Response(inboxes[u], { status: 200 });
  };
  delete globalThis.chrome;
});

test('extractCode finds codes near code words and ignores years and phone numbers', () => {
  assert.equal(extractCode('Your Acme verification code is 482913. It expires in 10 minutes.'), '482913');
  assert.equal(extractCode('Use code 7Q4K2P to sign in to Workday'), '7Q4K2P');
  assert.equal(extractCode('Your one-time passcode: 0391'), '0391');
  assert.equal(extractCode('Your application for Summer 2027 has been received.'), null);
  assert.equal(extractCode('Call us at 555 0100. Order 2027 shipped.'), null);
});

test('testGmail reads the inbox matching the profile email, counts only', async () => {
  inboxes[1] = feed('student@gmail.com', [entry({ title: 'Hello', summary: 'hi', issued: new Date().toISOString() })]);
  const r = await testGmail('student@gmail.com');
  assert.equal(r.ok, true);
  assert.equal(r.owner, 'student@gmail.com');
  assert.equal(r.unread, 1);
  assert.doesNotMatch(r.note, /Hello/); // no email content
});

test('testGmail warns when signed in to a different Gmail only', async () => {
  delete inboxes[1];
  const r = await testGmail('student@gmail.com');
  assert.equal(r.ok, false);
  assert.match(r.note, /other\.person@gmail\.com/);
});

test('testGmail reports signed out', async () => {
  inboxes = {};
  const r = await testGmail('student@gmail.com');
  assert.equal(r.ok, false);
  assert.match(r.note, /Not signed in to Gmail/);
});

test('waitForEmail returns a code from a new email, preferring the site', async () => {
  const since = Date.now() - 1000;
  inboxes[1] = feed('student@gmail.com', [
    entry({ title: 'Your Bank code', summary: 'Your security code is 111222', from: 'Bank', email: 'alerts@bank.com', issued: new Date().toISOString() }),
    entry({ title: 'Verify your Acme account', summary: 'Your Acme verification code is 482913', issued: new Date().toISOString() }),
    entry({ title: 'Old Acme code', summary: 'Your code is 999999', issued: new Date(Date.now() - 3600e3).toISOString() }),
  ]);
  const r = await waitForEmail({ email: 'student@gmail.com', sinceMs: since, hint: 'Acme acme.wd5.myworkdayjobs.com', want: 'code', timeoutMs: 2000 });
  assert.equal(r.code, '482913');
});

test('waitForEmail ignores codes that arrived before sign-up started', async () => {
  inboxes[1] = feed('student@gmail.com', [entry({ title: 'Acme code', summary: 'Your code is 999999', issued: new Date(Date.now() - 3600e3).toISOString() })]);
  const r = await waitForEmail({ email: 'student@gmail.com', sinceMs: Date.now(), hint: 'Acme', want: 'code', timeoutMs: 1200 });
  assert.equal(r, null);
});

test('pickVerifyLink unwraps Gmail redirect links and skips footer links', () => {
  const hrefs = [
    'https://www.google.com/url?q=https://acme.wd5.myworkdayjobs.com/privacy&source=gmail',
    'https://www.google.com/url?q=https://acme.wd5.myworkdayjobs.com/en-US/careers/verify?token%3Dabc123&source=gmail&ust=1',
    'https://support.google.com/mail/answer/1',
    'https://acme.com/unsubscribe?u=1',
  ];
  assert.equal(pickVerifyLink(hrefs, 'Acme'), 'https://acme.wd5.myworkdayjobs.com/en-US/careers/verify?token=abc123');
});

test('pickVerifyLink returns null when no link looks like a confirmation', () => {
  assert.equal(pickVerifyLink(['https://acme.com/careers', 'https://acme.com/privacy'], 'Acme'), null);
});
