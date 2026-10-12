// Kiểm tra JWT ký RS256 bằng khoá công khai dạng JWKS, dùng cho mã của nút "Đăng nhập bằng Google".
// Dùng node:crypto, không cần thư viện ngoài.
import crypto from 'node:crypto';

const KEY_CACHE_MS = 3600_000;
const CLOCK_SKEW_MS = 60_000;

export const GOOGLE_CERTS_URL = 'https://www.googleapis.com/oauth2/v3/certs';
export const GOOGLE_ISSUERS = ['accounts.google.com', 'https://accounts.google.com'];

function decodePart(part) {
  return JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
}

/**
 * @param {object} opts
 * @param {string} opts.certsUrl địa chỉ JWKS
 * @param {string[]} opts.issuers giá trị iss chấp nhận
 * @param {string} opts.aud giá trị aud bắt buộc (Client ID)
 * @returns {(token: string) => Promise<object>} payload của mã, ném lỗi nếu không hợp lệ
 */
export function createJwtVerifier({ certsUrl, issuers, aud, fetchImpl = fetch, now = () => Date.now() }) {
  let cache = { at: 0, keys: new Map() };

  async function loadKeys() {
    const res = await fetchImpl(certsUrl, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) throw new Error(`Không tải được khoá kiểm tra đăng nhập (HTTP ${res.status}).`);
    const body = await res.json();
    const keys = new Map();
    for (const jwk of body.keys || []) {
      if (jwk.kid && jwk.kty === 'RSA') keys.set(jwk.kid, crypto.createPublicKey({ key: jwk, format: 'jwk' }));
    }
    cache = { at: now(), keys };
    return keys;
  }

  async function keyFor(kid) {
    if (now() - cache.at < KEY_CACHE_MS && cache.keys.has(kid)) return cache.keys.get(kid);
    // Khoá mới (nhà cung cấp xoay khoá định kỳ) hoặc cache hết hạn: tải lại.
    return (await loadKeys()).get(kid);
  }

  return async function verify(token) {
    const parts = String(token || '').split('.');
    if (parts.length !== 3) throw new Error('Thiếu hoặc sai định dạng mã đăng nhập.');
    let header;
    let payload;
    try {
      header = decodePart(parts[0]);
      payload = decodePart(parts[1]);
    } catch {
      throw new Error('Mã đăng nhập không đọc được.');
    }
    if (header.alg !== 'RS256') throw new Error('Mã đăng nhập dùng thuật toán không hợp lệ.');
    const key = await keyFor(header.kid);
    if (!key) throw new Error('Mã đăng nhập ký bằng khoá lạ.');
    const signed = crypto.verify('RSA-SHA256', Buffer.from(`${parts[0]}.${parts[1]}`), key, Buffer.from(parts[2], 'base64url'));
    if (!signed) throw new Error('Chữ ký mã đăng nhập không hợp lệ.');
    const auds = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
    if (!auds.includes(aud)) throw new Error('Mã đăng nhập không dành cho ứng dụng này (sai aud).');
    if (!issuers.includes(payload.iss)) throw new Error('Mã đăng nhập không do nơi cấp hợp lệ phát hành (sai iss).');
    const t = now();
    if (!payload.exp || payload.exp * 1000 < t - CLOCK_SKEW_MS) throw new Error('Mã đăng nhập đã hết hạn, hãy đăng nhập lại.');
    if (payload.nbf && payload.nbf * 1000 > t + CLOCK_SKEW_MS) throw new Error('Mã đăng nhập chưa tới thời điểm có hiệu lực.');
    return payload;
  };
}

/** Kiểm tra mã của nút "Đăng nhập bằng Google" (ID token), trả về Gmail đã được Google xác minh. */
export function createGoogleVerifier({ clientId, fetchImpl, now }) {
  const verify = createJwtVerifier({ certsUrl: GOOGLE_CERTS_URL, issuers: GOOGLE_ISSUERS, aud: clientId, fetchImpl, now });
  return async (token) => {
    const p = await verify(token);
    const email = String(p.email || '').trim().toLowerCase();
    const verified = p.email_verified === true || p.email_verified === 'true';
    if (!email || !verified) throw new Error('Tài khoản Google này chưa xác minh email.');
    // Google chỉ bảo đảm chủ sở hữu với Gmail hoặc tài khoản Google Workspace (có hd).
    if (!email.endsWith('@gmail.com') && !p.hd) throw new Error('Chỉ nhận tài khoản Gmail hoặc Google Workspace.');
    return { email, name: String(p.name || ''), sub: String(p.sub || '') };
  };
}
