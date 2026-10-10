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

async function setup({ sheetRows } = {}) {
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
  const server = createUiServer({ config, rootDir, configPath, sheets, logger: silent, startRun });
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
          res.on('end', () => resolve({ status: res.statusCode, text, json: () => JSON.parse(text) }));
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
  return { rootDir, configPath, config, sheets, runs, request, close };
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
