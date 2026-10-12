// Kiểm thử bộ kiểm tra mã "Đăng nhập bằng Google" bằng cặp khoá RSA tự sinh (giả lập trang certs của Google).
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createGoogleVerifier, GOOGLE_CERTS_URL } from '../src/ui/jwt.js';

const CLIENT_ID = '123-abc.apps.googleusercontent.com';
const NOW = Date.parse('2026-10-12T10:00:00Z');
const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const JWK = { ...publicKey.export({ format: 'jwk' }), kid: 'g1', alg: 'RS256', use: 'sig' };
const VALID = {
  iss: 'https://accounts.google.com',
  aud: CLIENT_ID,
  sub: '1090001',
  email: 'Lan.Nguyen@gmail.com',
  email_verified: true,
  name: 'Lan Nguyễn',
  iat: NOW / 1000,
  exp: NOW / 1000 + 3600,
};

const enc = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');

function sign(payload, { kid = 'g1', key = privateKey, alg = 'RS256' } = {}) {
  const head = enc({ alg, kid, typ: 'JWT' });
  const body = enc(payload);
  const sig = crypto.sign('RSA-SHA256', Buffer.from(`${head}.${body}`), key).toString('base64url');
  return `${head}.${body}.${sig}`;
}

function makeVerifier() {
  let fetches = 0;
  const fetchImpl = async (url) => {
    fetches += 1;
    assert.equal(url, GOOGLE_CERTS_URL);
    return { ok: true, json: async () => ({ keys: [JWK] }) };
  };
  return { verify: createGoogleVerifier({ clientId: CLIENT_ID, fetchImpl, now: () => NOW }), fetches: () => fetches };
}

test('Đăng nhập Google: mã hợp lệ trả về Gmail (chữ thường), khoá được lưu tạm', async () => {
  const { verify, fetches } = makeVerifier();
  assert.deepEqual(await verify(sign(VALID)), { email: 'lan.nguyen@gmail.com', name: 'Lan Nguyễn', sub: '1090001' });
  assert.equal((await verify(sign({ ...VALID, iss: 'accounts.google.com' }))).email, 'lan.nguyen@gmail.com', 'iss không có https cũng hợp lệ');
  assert.equal((await verify(sign({ ...VALID, email: 'nv@drnatro.net', hd: 'drnatro.net' }))).email, 'nv@drnatro.net', 'tài khoản Google Workspace');
  assert.equal(fetches(), 1);
});

test('Đăng nhập Google: từ chối mã giả, sai ứng dụng, hết hạn hoặc email không được Google bảo đảm', async () => {
  const { verify } = makeVerifier();
  const other = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey;
  const tampered = (() => {
    const [h, , s] = sign(VALID).split('.');
    return `${h}.${enc({ ...VALID, email: 'ke-gian@gmail.com' })}.${s}`;
  })();
  const cases = [
    ['sai Client ID', sign({ ...VALID, aud: 'khac.apps.googleusercontent.com' }), /sai aud/],
    ['sai nơi cấp', sign({ ...VALID, iss: 'https://evil.example' }), /sai iss/],
    ['hết hạn', sign({ ...VALID, exp: NOW / 1000 - 3600 }), /hết hạn/],
    ['bị sửa nội dung', tampered, /Chữ ký/],
    ['ký bằng khoá khác', sign(VALID, { key: other }), /Chữ ký/],
    ['khoá lạ', sign(VALID, { kid: 'g-moi' }), /khoá lạ/],
    ['không ký (alg none)', `${enc({ alg: 'none', kid: 'g1' })}.${enc(VALID)}.`, /thuật toán/],
    ['email chưa xác minh', sign({ ...VALID, email_verified: false }), /chưa xác minh/],
    ['email ngoài Gmail, không có hd', sign({ ...VALID, email: 'ai.do@yahoo.com' }), /Chỉ nhận/],
    ['rác', 'abc', /định dạng/],
  ];
  for (const [name, token, error] of cases) {
    await assert.rejects(verify(token), error, name);
  }
});
