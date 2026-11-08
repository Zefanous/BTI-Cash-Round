'use strict';
const crypto = require('crypto');
const b64 = b => Buffer.from(b).toString('base64url');

// Minimal HS256 JWT (no external dependency).
function sign(payload, secret, ttlSec = 8 * 3600) {
  const h = b64(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const p = b64(JSON.stringify({ ...payload, exp: Math.floor(Date.now() / 1000) + ttlSec }));
  const sig = crypto.createHmac('sha256', secret).update(`${h}.${p}`).digest('base64url');
  return `${h}.${p}.${sig}`;
}
function verify(token, secret) {
  const parts = String(token || '').split('.');
  if (parts.length !== 3) return null;
  const exp = crypto.createHmac('sha256', secret).update(`${parts[0]}.${parts[1]}`).digest('base64url');
  const a = Buffer.from(exp), b = Buffer.from(parts[2]);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try { const p = JSON.parse(Buffer.from(parts[1], 'base64url').toString()); return p.exp > Date.now() / 1000 ? p : null; } catch { return null; }
}
module.exports = { sign, verify };
