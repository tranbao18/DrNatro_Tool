// Kiểm thử máy chủ giao diện quản lý với Google Sheet giả và lần quét giả (không mở Facebook).
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { createUiServer, applyManual, staticFile } from '../src/ui/server.js';
import { saveResults } from '../src/state.js';
import { MAIN_HEADER, COL } from '../src/sheets.js';
import { STATUS } from '../src/rules.js';

const silent = { info() {}, warn() {}, error() {}, debug() {} };

const RECORDS = [
  { uid: '1001', name: 'Nguyễn A', profileUrl: 'https://www.facebook.com/profile.php?id=1001', status: STATUS.QUALIFIED, reasons: [], tagCount: 5, memberAuto: 'member', memberLabel: 'Thành viên', memberEvidence: 'Đã tham gia', shareAuto: 'shared', sharePrivacy: 'Công khai', shareLabel: 'Đã share công khai', manualDecision: '', manualNote: '', likes: 10, replies: 2, engagement: 12, comment: { text: '<script>alert(1)</script>', url: 'https://www.facebook.com/c/1', createdAt: '2026-10-05T03:00:00.000Z' } },
  { uid: '1002', name: 'Trần B', profileUrl: 'https://www.facebook.com/profile.php?id=1002', status: STATUS.PENDING, reasons: ['Share: không thấy trong danh sách chia sẻ công khai'], tagCount: 6, memberAuto: 'member', memberLabel: 'Thành viên', memberEvidence: '', shareAuto: 'not_found', sharePrivacy: '', shareLabel: 'Chưa xác nhận', manualDecision: '', manualNote: '', likes: 5, replies: 0, engagement: 5, comment: null },
  { uid: '1003', name: 'Lê C', profileUrl: 'https://www.facebook.com/profile.php?id=1003', status: STATUS.PENDING, reasons: ['Thành viên: chưa xác nhận tự động'], tagCount: 5, memberAuto: 'unknown', memberLabel: 'Chưa xác nhận', memberEvidence: 'conflict:đã tham gia | đã rời nhóm', shareAuto: 'shared', sharePrivacy: 'Công khai', shareLabel: 'Đã share công khai', manualDecision: '', manualNote: '', likes: 1, replies: 0, engagement: 1, comment: null },
];

function sheetRow(r, i, decision = '', note = '') {
  const row = Array(MAIN_HEADER.length).fill('');
  row[0] = String(i + 1);
  row[1] = r.name;
  row[COL.UID] = r.uid;
  row[COL.STATUS] = r.status;
  row[COL.MANUAL] = decision;
  row[COL.MANUAL_NOTE] = note;
  return row;
}

function fakeSheets(rows) {
  return {
    rows,
    writes: [],
    async readRange() {
      return this.rows;
    },
    async batchWriteRanges(_id, data) {
      this.writes.push(...data);
    },
  };
}

async function setup({ sheetRows, publicUrl = '', allowedEmails = [], verifyGoogle = null } = {}) {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'drnatro-ui-'));
  const configPath = path.join(rootDir, 'config.json');
  fs.writeFileSync(configPath, JSON.stringify({ postUrl: '', sheetId: 'SHEET', other: 'giữ nguyên' }, null, 2));
  saveResults(rootDir, {
    startedAt: '2026-10-09T10:00:00.000Z',
    finishedAt: '2026-10-09T10:20:00.000Z',
    finalRun: false,
    postUrl: '',
    stats: { commentCount: 40, shareCount: 3 },
    sharesAvailable: true,
    records: RECORDS,
    rejected: [{ uid: '2001', name: 'Phạm D', reason: 'Tag 2/5 người', tagCount: 2, comment: null }],
  });
  const freezeAt = '2099-10-21T00:00:00+07:00';
  const config = {
    postUrl: '',
    groupUrl: 'https://www.facebook.com/groups/1',
    sheetId: 'SHEET',
    timezone: 'Asia/Ho_Chi_Minh',
    freezeAt,
    freezeDate: new Date(freezeAt),
    finalRunDate: new Date(Date.parse(freezeAt) - 15 * 60_000),
    intervalMinutes: 60,
    memberCheck: 'auto',
    ui: { publicUrl, allowedEmails },
  };
  const sheets = fakeSheets(sheetRows || [MAIN_HEADER, ...RECORDS.map((r, i) => sheetRow(r, i))]);
  const runs = [];
  const startRun = () => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    runs.push(child);
    return child;
  };
  const logs = [];
  const logger = { ...silent, info: (m) => logs.push(m) };
  const server = createUiServer({ config, rootDir, configPath, sheets, logger, startRun, verifyGoogle });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const request = (method, url, { body, headers = {} } = {}) =>
    new Promise((resolve, reject) => {
      const payload = body === undefined ? undefined : JSON.stringify(body);
      const req = http.request(
        { host: '127.0.0.1', port, method, path: url, headers: { ...(payload ? { 'content-type': 'application/json' } : {}), ...headers } },
        (res) => {
          let text = '';
          res.setEncoding('utf8');
          res.on('data', (c) => (text += c));
          res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text, json: () => JSON.parse(text) }));
        },
      );
      req.on('error', reject);
      if (payload) req.write(payload);
      req.end();
    });
  const close = () => {
    server.close();
    fs.rmSync(rootDir, { recursive: true, force: true });
  };
  return { rootDir, configPath, config, sheets, runs, request, close, logs };
}

test('applyManual tính lại trạng thái theo duyệt tay', () => {
  const ok = applyManual(RECORDS[1], { decision: 'đạt', note: '' }, true);
  assert.equal(ok.status, STATUS.QUALIFIED);
  assert.equal(ok.manualNormalized, 'OK');
  assert.equal(applyManual(RECORDS[0], { decision: 'x', note: 'spam' }, true).status, STATUS.REJECTED);
  const cleared = applyManual(RECORDS[1], { decision: '', note: '' }, true);
  assert.equal(cleared.status, STATUS.PENDING);
  assert.match(cleared.reasons.join(), /không thấy trong danh sách chia sẻ/);
});

test('giao diện: /api/data gộp duyệt tay đang có trên sheet', async () => {
  const rows = [MAIN_HEADER, sheetRow(RECORDS[0], 0), sheetRow(RECORDS[1], 1, 'OK', 'đã xem share'), sheetRow(RECORDS[2], 2)];
  const t = await setup({ sheetRows: rows });
  try {
    const res = await t.request('GET', '/api/data');
    assert.equal(res.status, 200);
    const data = res.json();
    const b = data.records.find((r) => r.uid === '1002');
    assert.equal(b.status, STATUS.QUALIFIED);
    assert.equal(b.manualNote, 'đã xem share');
    assert.deepEqual(data.counts, { [STATUS.QUALIFIED]: 2, [STATUS.PENDING]: 1, [STATUS.REJECTED]: 0 });
    assert.equal(data.rejected.length, 1);
    assert.equal(data.sheet.ok, true);
    assert.equal(data.run.running, false);

    const page = await t.request('GET', '/');
    assert.equal(page.status, 200);
    assert.match(page.text, /Quản lý dữ liệu Minigame/);
    const logo = await t.request('GET', '/logo.png');
    assert.equal(logo.status, 200);
  } finally {
    t.close();
  }
});

test('giao diện: duyệt tay ghi đúng dòng theo User ID, kèm trạng thái mới', async () => {
  const t = await setup();
  try {
    const res = await t.request('POST', '/api/manual', { body: { uid: '1003', decision: 'LOẠI', note: 'đã rời nhóm thật' } });
    assert.equal(res.status, 200, res.text);
    const out = res.json();
    assert.equal(out.rowNumber, 4);
    assert.equal(out.record.status, STATUS.REJECTED);
    const byRange = Object.fromEntries(t.sheets.writes.map((w) => [w.range, w.values[0][0]]));
    assert.deepEqual(byRange, {
      "'Danh sách'!J4": "'LOẠI",
      "'Danh sách'!K4": "'đã rời nhóm thật",
      "'Danh sách'!E4": "'LOẠI",
      "'Danh sách'!F4": "'Duyệt tay: loại",
    });

    assert.equal((await t.request('POST', '/api/manual', { body: { uid: '9999', decision: 'OK' } })).status, 404);
    assert.equal((await t.request('POST', '/api/manual', { body: { uid: '1001', decision: 'có lẽ' } })).status, 400);
  } finally {
    t.close();
  }
});

test('giao diện: khoá duyệt tay khi đang quét và không cho chạy trùng', async () => {
  const t = await setup();
  try {
    assert.equal((await t.request('POST', '/api/run', { body: {} })).status, 400, 'chưa có link bài viết');
    const saved = await t.request('POST', '/api/config', { body: { postUrl: 'https://www.facebook.com/groups/1/posts/2' } });
    assert.equal(saved.status, 200, saved.text);
    const onDisk = JSON.parse(fs.readFileSync(t.configPath, 'utf8'));
    assert.equal(onDisk.postUrl, 'https://www.facebook.com/groups/1/posts/2');
    assert.equal(onDisk.other, 'giữ nguyên');
    assert.equal((await t.request('POST', '/api/config', { body: { postUrl: 'https://example.com/x' } })).status, 400);

    assert.equal((await t.request('POST', '/api/run', { body: {} })).status, 200);
    assert.equal(t.runs.length, 1);
    assert.equal((await t.request('POST', '/api/run', { body: {} })).status, 409);
    assert.equal((await t.request('POST', '/api/manual', { body: { uid: '1001', decision: 'OK' } })).status, 409);
    t.runs[0].emit('close', 0);
    assert.equal((await t.request('GET', '/api/status')).json().running, false);

    // Lần quét từ lịch Windows (file khoá của một tiến trình đang sống) cũng khoá duyệt tay.
    fs.writeFileSync(path.join(t.rootDir, 'data', 'run.lock'), JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
    assert.equal((await t.request('POST', '/api/manual', { body: { uid: '1001', decision: 'OK' } })).status, 409);
    assert.equal(t.sheets.writes.length, 0);
  } finally {
    t.close();
  }
});

test('giao diện: chỉ phục vụ file tĩnh nằm trong public/, chặn đường dẫn đi ra ngoài', async () => {
  assert.equal(staticFile('/').type, 'text/html; charset=utf-8');
  assert.equal(staticFile('/logo.png').type, 'image/png');
  for (const p of ['/..', '/../config.json', '/%2e%2e/config.json', '/.env', '/sub/app.js', '/server.js', '/app.txt']) {
    assert.equal(staticFile(p), null, p);
  }
  const t = await setup();
  try {
    assert.equal((await t.request('GET', '/style.css')).status, 200);
    assert.equal((await t.request('GET', '/../server.js')).status, 404);
    assert.equal((await t.request('GET', '/%2e%2e%2fconfig.json')).status, 404);
  } finally {
    t.close();
  }
});

test('giao diện: chặn Host/Origin lạ và yêu cầu không phải JSON', async () => {
  const t = await setup();
  try {
    assert.equal((await t.request('GET', '/api/data', { headers: { host: 'evil.example:80' } })).status, 403);
    assert.equal((await t.request('POST', '/api/run', { body: {}, headers: { origin: 'https://evil.example' } })).status, 403);
    const form = await t.request('POST', '/api/run', { headers: { 'content-type': 'application/x-www-form-urlencoded' } });
    assert.equal(form.status, 415);
    assert.equal(t.runs.length, 0);
  } finally {
    t.close();
  }
});

const PUBLIC = 'https://minigame.drnatro.net';
// Google giả: mã "google:<gmail>" là hợp lệ, còn lại bị từ chối.
const fakeGoogle = async (credential) => {
  const m = /^google:(.+)$/.exec(credential);
  if (!m) throw new Error('Chữ ký mã đăng nhập không hợp lệ.');
  return { email: m[1], name: `Tên ${m[1]}`, sub: m[1] };
};
const remote = (extra = {}) => ({ host: 'minigame.drnatro.net', 'cf-ray': 'abc-SIN', 'cf-connecting-ip': '203.0.113.5', ...extra });

async function login(t, email) {
  const res = await t.request('POST', '/api/login', { body: { credential: `google:${email}` }, headers: remote({ origin: PUBLIC }) });
  const cookie = (res.headers['set-cookie'] || [])[0]?.split(';')[0] || '';
  return { res, cookie };
}

test('đăng nhập Google qua Tunnel: khách chỉ thấy trang đăng nhập, Gmail trong danh sách vào được', async () => {
  const t = await setup({ publicUrl: PUBLIC, allowedEmails: ['Lan@gmail.com'], verifyGoogle: fakeGoogle });
  try {
    const page = await t.request('GET', '/', { headers: remote() });
    assert.equal(page.status, 200);
    assert.match(page.text, /Đăng nhập bằng Google/);
    assert.equal((await t.request('GET', '/api/data', { headers: remote() })).status, 401);
    assert.equal((await t.request('GET', '/api/login-config', { headers: remote() })).json().clientId, '');
    // Tunnel đổi Host thành 127.0.0.1 nhưng vẫn có header của Cloudflare: vẫn là khách.
    assert.equal((await t.request('GET', '/api/data', { headers: { 'cf-ray': 'abc-SIN' } })).status, 401);
    // Mã Google giả bị từ chối.
    const fake = await t.request('POST', '/api/login', { body: { credential: 'gia-mao' }, headers: remote({ origin: PUBLIC }) });
    assert.equal(fake.status, 401);

    const { res, cookie } = await login(t, 'lan@gmail.com');
    assert.equal(res.status, 200, res.text);
    assert.match(res.headers['set-cookie'][0], /HttpOnly; Secure; SameSite=Lax/);
    const data = await t.request('GET', '/api/data', { headers: remote({ cookie }) });
    assert.equal(data.status, 200, data.text);
    assert.deepEqual(data.json().viewer, { remote: true, email: 'lan@gmail.com', admin: false });

    const manual = await t.request('POST', '/api/manual', {
      body: { uid: '1002', decision: 'OK', note: 'đã xem share' },
      headers: remote({ cookie, origin: PUBLIC }),
    });
    assert.equal(manual.status, 200, manual.text);
    assert.ok(t.logs.some((l) => l.includes('lan@gmail.com') && l.includes('1002') && l.includes('OK')), 'nhật ký ghi Gmail người duyệt');
    // Trang khác lợi dụng cookie đăng nhập cũng không gửi lệnh vào được (Origin lạ).
    assert.equal((await t.request('POST', '/api/run', { body: {}, headers: remote({ cookie, origin: 'https://evil.example' }) })).status, 403);

    // Người từ xa không xem/cấp quyền được danh sách Gmail.
    assert.equal((await t.request('GET', '/api/visitors', { headers: remote({ cookie }) })).status, 403);
    assert.equal((await t.request('POST', '/api/visitors', { body: { email: 'x@gmail.com', status: 'allowed' }, headers: remote({ cookie, origin: PUBLIC }) })).status, 403);

    // Đăng xuất: cookie cũ hết hiệu lực.
    await t.request('POST', '/api/logout', { body: {}, headers: remote({ cookie, origin: PUBLIC }) });
    assert.equal((await t.request('GET', '/api/data', { headers: remote({ cookie }) })).status, 401);
  } finally {
    t.close();
  }
});

test('đăng nhập Google: Gmail lạ được ghi lại và chờ cấp quyền; chặn là mất quyền ngay', async () => {
  const t = await setup({ publicUrl: PUBLIC, verifyGoogle: fakeGoogle });
  try {
    const first = await login(t, 'nguoi.la@gmail.com');
    assert.equal(first.res.status, 403);
    assert.equal(first.res.json().status, 'pending');
    assert.equal(first.cookie, '', 'chưa được phép thì không có phiên');

    // Trên máy chạy tool: thấy Gmail đang chờ, bấm Cho phép.
    const list = (await t.request('GET', '/api/visitors')).json().visitors;
    assert.deepEqual(list.map((v) => [v.email, v.status, v.count]), [['nguoi.la@gmail.com', 'pending', 1]]);
    assert.equal((await t.request('GET', '/api/data')).json().pendingVisitors, 1);
    const allow = await t.request('POST', '/api/visitors', { body: { email: 'nguoi.la@gmail.com', status: 'allowed' } });
    assert.equal(allow.status, 200, allow.text);

    const second = await login(t, 'nguoi.la@gmail.com');
    assert.equal(second.res.status, 200);
    assert.equal((await t.request('GET', '/api/data', { headers: remote({ cookie: second.cookie }) })).status, 200);

    // Chặn: phiên đang mở bị cắt, đăng nhập lại cũng không được.
    await t.request('POST', '/api/visitors', { body: { email: 'nguoi.la@gmail.com', status: 'blocked' } });
    assert.equal((await t.request('GET', '/api/data', { headers: remote({ cookie: second.cookie }) })).status, 401);
    const third = await login(t, 'nguoi.la@gmail.com');
    assert.equal(third.res.status, 403);
    assert.equal(third.res.json().status, 'blocked');
    assert.ok(t.logs.some((l) => l.includes('nguoi.la@gmail.com') && l.includes('đăng nhập bằng Google')), 'nhật ký ghi lần đăng nhập');
  } finally {
    t.close();
  }
});

test('giao diện: chưa cấu hình đăng nhập Google thì chặn mọi truy cập qua Tunnel', async () => {
  const t = await setup();
  try {
    const res = await t.request('GET', '/api/data', { headers: { 'cf-connecting-ip': '203.0.113.5' } });
    assert.equal(res.status, 403);
    assert.match(res.json().error, /googleClientId/);
    // Tunnel gửi Host là tên miền công khai nhưng chưa khai báo publicUrl: báo rõ cần điền gì.
    const named = await t.request('GET', '/', { headers: { host: 'minigame.drnatro.net', 'cf-ray': 'abc-SIN' } });
    assert.equal(named.status, 403);
    assert.match(named.json().error, /ui.publicUrl/);
  } finally {
    t.close();
  }
});
