#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

const source = fs.readFileSync(path.join(__dirname, '..', 'lib/db.js'), 'utf8');
function harness(fetch, { removalFails = false } = {}) {
  const stored = new Map([['elistly_token', 'synthetic-token']]);
  const window = { ELISTLY_API_URL: 'https://api.example.test', NEON_AUTH_URL: 'https://auth.example.test' };
  vm.runInNewContext(source, {
    window, fetch, console, atob,
    localStorage: {
      getItem: key => stored.get(key) ?? null,
      setItem: (key, value) => stored.set(key, value),
      removeItem: key => { if (removalFails) throw new Error('storage unavailable'); stored.delete(key); }
    }
  });
  return { auth: window.elistlyClient.auth, stored };
}

for (const failure of ['http', 'network', 'storage']) {
  test(`sign-out reports ${failure} failure instead of claiming session revocation`, async () => {
    const { auth, stored } = harness(async () => {
      if (failure === 'network') throw new Error('offline');
      return new Response('{}', { status: failure === 'http' ? 503 : 200 });
    }, { removalFails: failure === 'storage' });
    const result = await auth.signOut();
    assert.ok(result.error, 'incomplete sign-out must return an error');
    if (failure !== 'storage') assert.equal(stored.has('elistly_token'), false, 'local token must still be removed when remote revocation fails');
  });
}

test('a session refresh finishing after sign-out cannot restore the token', async () => {
  let release;
  const { auth, stored } = harness(async url => {
    if (url.endsWith('/get-session')) {
      await new Promise(resolve => { release = resolve; });
      return new Response(JSON.stringify({ user: { id: 'synthetic-user' } }), { headers: { 'set-auth-jwt': 'new-synthetic-token' } });
    }
    return new Response('{}');
  });
  const refreshing = auth.refreshSession();
  await auth.signOut();
  release();
  const result = await refreshing;
  assert.equal(stored.has('elistly_token'), false, 'late refresh must not resurrect a signed-out session');
  assert.ok(result.error, 'cancelled session refresh must not report successful authentication');
});

test('concurrent expired-session reads cannot clear a freshly refreshed token', async () => {
  const expired = `e30.${Buffer.from(JSON.stringify({ sub: 'synthetic-user', exp: 1 })).toString('base64url')}.test`;
  const fresh = `e30.${Buffer.from(JSON.stringify({ sub: 'synthetic-user', exp: 9999999999 })).toString('base64url')}.test`;
  const releases = [];
  const { auth, stored } = harness(async () => {
    await new Promise(resolve => releases.push(resolve));
    return new Response(JSON.stringify({ user: { id: 'synthetic-user' } }), { headers: { 'set-auth-jwt': fresh } });
  });
  stored.set('elistly_token', expired);
  const first = auth.getSession();
  const second = auth.getSession();
  releases[0]();
  await first;
  releases[1]();
  const result = await second;
  assert.equal(stored.get('elistly_token'), fresh, 'a superseded refresh must not clear the newer session');
  assert.equal(result.data.session.access_token, fresh);
});

for (const [method, endpoint] of [['signInWithPassword', '/sign-in/email'], ['signUp', '/sign-up/email'], ['verifyOtp', '/email-otp/verify-email']]) {
  test(`sign-out waits for pending ${method} cookies and cancels session restoration`, async () => {
    let release;
    const events = [];
    const { auth, stored } = harness(async url => {
      if (url.endsWith(endpoint)) {
        await new Promise(resolve => { release = resolve; });
        events.push('cookie issued');
      }
      if (url.endsWith('/sign-out')) events.push('cookie revoked');
      return new Response(JSON.stringify({ user: { id: 'synthetic-user' } }), { headers: { 'set-auth-jwt': 'synthetic-new-token' } });
    });
    const signingIn = auth[method]({ email: 'synthetic@example.test', password: 'test-only', token: '123456', type: 'signup' });
    const signingOut = auth.signOut();
    release();
    const [login, logout] = await Promise.all([signingIn, signingOut]);
    assert.deepEqual(events, ['cookie issued', 'cookie revoked']);
    assert.ok(login.error, 'superseded authentication must not report success');
    assert.equal(logout.error, null);
    assert.equal(stored.has('elistly_token'), false);
  });
}

for (const method of ['signUp', 'verifyOtp']) {
  test(`${method} does not hide cancellation during its session lookup`, async () => {
    let release;
    let started;
    const ready = new Promise(resolve => { started = resolve; });
    const { auth, stored } = harness(async url => {
      if (url.endsWith('/get-session')) {
        await new Promise(resolve => { release = resolve; started(); });
      }
      return new Response(JSON.stringify({ user: { id: 'synthetic-user' } }), { headers: { 'set-auth-jwt': 'synthetic-new-token' } });
    });
    const signingIn = auth[method]({ email: 'synthetic@example.test', password: 'test-only', token: '123456', type: 'signup' });
    await ready;
    await auth.signOut();
    release();
    assert.ok((await signingIn).error);
    assert.equal(stored.has('elistly_token'), false);
  });
}

test('refresh cannot restore the token while cookie revocation is pending', async () => {
  let release;
  const { auth, stored } = harness(async url => {
    if (url.endsWith('/sign-out')) await new Promise(resolve => { release = resolve; });
    return new Response(JSON.stringify({ user: { id: 'synthetic-user' } }), { headers: { 'set-auth-jwt': 'synthetic-new-token' } });
  });
  const signingOut = auth.signOut();
  await Promise.resolve();
  const result = await auth.refreshSession();
  release();
  await signingOut;
  assert.ok(result.error);
  assert.equal(stored.has('elistly_token'), false);
});

test('successful sign-out clears the token and sends the current Neon request', async () => {
  let request;
  const { auth, stored } = harness(async (url, options) => {
    request = { url, ...options };
    return new Response('{}');
  });
  assert.equal((await auth.signOut()).error, null);
  assert.equal(stored.has('elistly_token'), false);
  assert.equal(request.url, 'https://auth.example.test/sign-out');
  assert.equal(request.method, 'POST');
  assert.equal(request.credentials, 'include');
  assert.equal(request.body, '{}');
});
