// Đăng nhập từ xa bằng Google: lưu mọi Gmail đã vào giao diện (data/ui-visitors.json) và phiên đăng nhập
// (data/ui-sessions.json, chỉ lưu mã đã băm). Gmail trong ui.allowedEmails được vào ngay; Gmail khác ở trạng
// thái "chờ" cho tới khi được cho phép trên máy chạy tool. Chặn một Gmail là mất quyền ngay, kể cả phiên đang mở.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const SESSION_COOKIE = 'mg_session';
const SESSION_DAYS = 7;
export const STATUS_LABEL = { allowed: 'Được phép', pending: 'Chờ cấp quyền', blocked: 'Đã chặn' };

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
  fs.renameSync(tmp, file);
}

const hashToken = (token) => crypto.createHash('sha256').update(String(token)).digest('hex');
const normEmail = (email) => String(email || '').trim().toLowerCase();

export function createAuthStore({ rootDir, allowedEmails = [], now = () => Date.now() }) {
  const visitorsFile = path.join(rootDir, 'data', 'ui-visitors.json');
  const sessionsFile = path.join(rootDir, 'data', 'ui-sessions.json');
  const seed = new Set(allowedEmails.map(normEmail).filter(Boolean));
  const iso = () => new Date(now()).toISOString();

  function statusOf(email, visitors = readJson(visitorsFile, {})) {
    const v = visitors[email];
    // Chặn tay thắng cả danh sách trong config.
    if (v?.status === 'blocked') return 'blocked';
    if (seed.has(email) || v?.status === 'allowed') return 'allowed';
    return 'pending';
  }

  /** Ghi nhận một lần đăng nhập Google thành công, trả về trạng thái quyền của Gmail đó. */
  function recordLogin({ email, name }) {
    const e = normEmail(email);
    const visitors = readJson(visitorsFile, {});
    const t = iso();
    const v = visitors[e] || { email: e, name: '', firstSeen: t, count: 0 };
    Object.assign(v, { name: name || v.name || '', lastSeen: t, count: (v.count || 0) + 1 });
    visitors[e] = v;
    writeJson(visitorsFile, visitors);
    return statusOf(e, visitors);
  }

  function revokeEmail(email) {
    const sessions = readJson(sessionsFile, {});
    for (const [key, s] of Object.entries(sessions)) if (s.email === email) delete sessions[key];
    writeJson(sessionsFile, sessions);
  }

  /** status: 'allowed' | 'blocked'. */
  function setStatus(email, status) {
    const e = normEmail(email);
    const visitors = readJson(visitorsFile, {});
    const t = iso();
    visitors[e] = { ...(visitors[e] || { email: e, name: '', firstSeen: null, lastSeen: null, count: 0 }), status, decidedAt: t };
    writeJson(visitorsFile, visitors);
    if (status === 'blocked') revokeEmail(e);
    return statusOf(e, visitors);
  }

  function listVisitors() {
    const visitors = readJson(visitorsFile, {});
    for (const e of seed) if (!visitors[e]) visitors[e] = { email: e, name: '', firstSeen: null, lastSeen: null, count: 0 };
    const order = { pending: 0, allowed: 1, blocked: 2 };
    return Object.values(visitors)
      .map((v) => ({ ...v, status: statusOf(v.email, visitors), inConfig: seed.has(v.email) }))
      .sort((a, b) => order[a.status] - order[b.status] || String(b.lastSeen || '').localeCompare(String(a.lastSeen || '')));
  }

  function createSession(email) {
    const token = crypto.randomBytes(32).toString('base64url');
    const sessions = readJson(sessionsFile, {});
    const t = now();
    for (const [key, s] of Object.entries(sessions)) if (s.expires < t) delete sessions[key];
    sessions[hashToken(token)] = { email: normEmail(email), created: iso(), expires: t + SESSION_DAYS * 86_400_000 };
    writeJson(sessionsFile, sessions);
    return { token, maxAge: SESSION_DAYS * 86_400 };
  }

  /** Gmail của phiên còn hạn và vẫn được phép, ngược lại null. */
  function sessionEmail(token) {
    if (!token) return null;
    const s = readJson(sessionsFile, {})[hashToken(token)];
    if (!s || s.expires < now()) return null;
    return statusOf(s.email) === 'allowed' ? s.email : null;
  }

  function deleteSession(token) {
    if (!token) return;
    const sessions = readJson(sessionsFile, {});
    delete sessions[hashToken(token)];
    writeJson(sessionsFile, sessions);
  }

  return { recordLogin, setStatus, listVisitors, createSession, sessionEmail, deleteSession, statusOf: (e) => statusOf(normEmail(e)) };
}
