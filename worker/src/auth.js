/**
 * Elistly Worker – Auth helpers
 * JWT: HS256 (Web Crypto), Password: PBKDF2 (Web Crypto), TOTP: RFC 6238 (HMAC-SHA1, Web Crypto)
 * Adapted from the Notner auth pattern (notner/AUTH_PATTERN.md).
 *
 * Required Worker secrets: JWT_SECRET
 * Optional: TOTP_ENCRYPTION_KEY (falls back to JWT_SECRET)
 */

// ─── JWT (HS256, Web Crypto) ──────────────────────────────────────────────────

const JWT_EXPIRY_SECONDS = 7 * 24 * 60 * 60; // 7 days

function base64url(buf) {
  return btoa(String.fromCharCode(...new Uint8Array(buf)))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64urlDecode(str) {
  const b64 = str.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(b64);
  return Uint8Array.from(bin, c => c.charCodeAt(0));
}

async function getHmacKey(secret) {
  const enc = new TextEncoder();
  return crypto.subtle.importKey(
    'raw', enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false, ['sign', 'verify']
  );
}

export async function signJwt(payload, secret) {
  const header = { alg: 'HS256', typ: 'JWT' };
  const now = Math.floor(Date.now() / 1000);
  const claims = { iat: now, exp: now + JWT_EXPIRY_SECONDS, ...payload };
  const enc = new TextEncoder();
  const headerB64 = base64url(enc.encode(JSON.stringify(header)));
  const payloadB64 = base64url(enc.encode(JSON.stringify(claims)));
  const signingInput = `${headerB64}.${payloadB64}`;
  const key = await getHmacKey(secret);
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(signingInput));
  return `${signingInput}.${base64url(sig)}`;
}

export async function verifyJwt(token, secret) {
  if (!token || typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  try {
    const enc = new TextEncoder();
    const signingInput = `${parts[0]}.${parts[1]}`;
    const key = await getHmacKey(secret);
    const sig = base64urlDecode(parts[2]);
    const valid = await crypto.subtle.verify('HMAC', key, sig, enc.encode(signingInput));
    if (!valid) return null;
    const payload = JSON.parse(new TextDecoder().decode(base64urlDecode(parts[1])));
    if (payload.exp && Math.floor(Date.now() / 1000) > payload.exp) return null;
    return payload;
  } catch {
    return null;
  }
}

export function extractBearer(req) {
  const h = req.headers.get('Authorization') || '';
  return h.startsWith('Bearer ') ? h.slice(7).trim() : null;
}

export async function requireAuth(req, env) {
  const token = extractBearer(req);
  if (!token) return null;
  return verifyJwt(token, env.JWT_SECRET);
}

// ─── Password (PBKDF2, Web Crypto) ───────────────────────────────────────────

const toHex = buf => Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');

export async function hashPassword(password) {
  const enc = new TextEncoder();
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations: 100000, hash: 'SHA-256' },
    key, 256
  );
  return `${toHex(salt)}:${toHex(bits)}`;
}

export async function verifyPassword(password, stored) {
  if (!stored || !password) return false;
  try {
    const [saltHex, hashHex] = stored.split(':');
    if (!saltHex || !hashHex) return false;
    const salt = Uint8Array.from(saltHex.match(/.{2}/g).map(b => parseInt(b, 16)));
    const enc = new TextEncoder();
    const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
    const bits = await crypto.subtle.deriveBits(
      { name: 'PBKDF2', salt, iterations: 100000, hash: 'SHA-256' },
      key, 256
    );
    const computed = toHex(bits);
    return timingSafeEqual(computed, hashHex);
  } catch {
    return false;
  }
}

function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// ─── TOTP (RFC 6238, HMAC-SHA1, Web Crypto) ──────────────────────────────────

const TOTP_DIGITS = 6;
const TOTP_PERIOD = 30;

function base32Decode(str) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  const s = str.toUpperCase().replace(/=+$/, '');
  let bits = 0, val = 0;
  const out = [];
  for (const c of s) {
    const idx = alphabet.indexOf(c);
    if (idx === -1) continue;
    val = (val << 5) | idx;
    bits += 5;
    if (bits >= 8) { bits -= 8; out.push((val >> bits) & 0xff); }
  }
  return new Uint8Array(out);
}

function base32Encode(buf) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = 0, val = 0, out = '';
  for (const b of buf) { val = (val << 8) | b; bits += 8; while (bits >= 5) { bits -= 5; out += alphabet[(val >> bits) & 31]; } }
  if (bits > 0) out += alphabet[(val << (5 - bits)) & 31];
  return out;
}

async function hotp(keyBytes, counter) {
  const counterBuf = new ArrayBuffer(8);
  const view = new DataView(counterBuf);
  view.setUint32(0, Math.floor(counter / 0x100000000), false);
  view.setUint32(4, counter >>> 0, false);
  const key = await crypto.subtle.importKey('raw', keyBytes, { name: 'HMAC', hash: 'SHA-1' }, false, ['sign']);
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, counterBuf));
  const offset = sig[sig.length - 1] & 0xf;
  const code = ((sig[offset] & 0x7f) << 24) | (sig[offset + 1] << 16) | (sig[offset + 2] << 8) | sig[offset + 3];
  return String(code % Math.pow(10, TOTP_DIGITS)).padStart(TOTP_DIGITS, '0');
}

export async function generateTotp(secretBase32, timestampMs = Date.now()) {
  const counter = Math.floor(timestampMs / 1000 / TOTP_PERIOD);
  return hotp(base32Decode(secretBase32), counter);
}

export async function verifyTotp(secretBase32, token, timestampMs = Date.now()) {
  const counter = Math.floor(timestampMs / 1000 / TOTP_PERIOD);
  const keyBytes = base32Decode(secretBase32);
  for (const delta of [-1, 0, 1]) {
    const expected = await hotp(keyBytes, counter + delta);
    if (timingSafeEqual(expected, token)) return true;
  }
  return false;
}

export function generateTotpSecret() {
  return base32Encode(crypto.getRandomValues(new Uint8Array(20)));
}

export function buildOtpauthUri(secret, accountName, issuer = 'Elistly') {
  const params = new URLSearchParams({
    secret, issuer,
    algorithm: 'SHA1',
    digits: String(TOTP_DIGITS),
    period: String(TOTP_PERIOD),
  });
  return `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(accountName)}?${params}`;
}

// ─── TOTP secret encryption (AES-GCM) ────────────────────────────────────────

async function getTotpEncKey(rawKey) {
  const enc = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey('raw', enc.encode(rawKey), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: enc.encode('elistly-totp-salt'), iterations: 10000, hash: 'SHA-256' },
    keyMaterial,
    { name: 'AES-GCM', length: 256 },
    false, ['encrypt', 'decrypt']
  );
}

export async function encryptTotpSecret(secret, encKeyRaw) {
  const enc = new TextEncoder();
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await getTotpEncKey(encKeyRaw);
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(secret));
  return `${toHex(iv)}:${toHex(ct)}`;
}

export async function decryptTotpSecret(stored, encKeyRaw) {
  try {
    const [ivHex, ctHex] = stored.split(':');
    const iv = Uint8Array.from(ivHex.match(/.{2}/g).map(b => parseInt(b, 16)));
    const ct = Uint8Array.from(ctHex.match(/.{2}/g).map(b => parseInt(b, 16)));
    const key = await getTotpEncKey(encKeyRaw);
    const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ct);
    return new TextDecoder().decode(pt);
  } catch {
    return null;
  }
}

// ─── UUID v4 ──────────────────────────────────────────────────────────────────

export function uuidv4() {
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = Array.from(b).map(x => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0,8)}-${h.slice(8,12)}-${h.slice(12,16)}-${h.slice(16,20)}-${h.slice(20)}`;
}
