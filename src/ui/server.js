// Giao diện quản lý chạy trên máy: http://127.0.0.1:<port>/
// Đọc kết quả lần quét gần nhất (data/results.json) kết hợp cột duyệt tay trên Google Sheet,
// cho phép nhập link bài viết, bấm chạy quét và duyệt tay OK / LOẠI theo User ID.
// Chỉ lắng nghe 127.0.0.1 và kiểm tra Host/Origin để trang web khác không gửi lệnh vào được.
// Mở cho team qua Cloudflare Tunnel: người vào từ xa phải đăng nhập bằng Google, Gmail được ghi lại và
// chỉ Gmail được cho phép mới xem/thao tác được.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadState, loadResults } from '../state.js';
import { readRunLock } from '../lock.js';
import { isFrozen } from '../run.js';
import { decideStatus, normalizeManual, summarize, STATUS } from '../rules.js';
import { TABS, parseManualColumns, buildManualUpdate } from '../sheets.js';
import { createAuthStore, SESSION_COOKIE, STATUS_LABEL } from './auth.js';

const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'public');
const STATIC_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

/**
 * File tĩnh nằm ngay trong public/ (không thư mục con, không "..", chỉ các đuôi trong STATIC_TYPES).
 * Tra cứu lúc nhận yêu cầu nên thêm ảnh/icon mới không cần khởi động lại giao diện.
 */
export function staticFile(pathname, dir = PUBLIC_DIR) {
  const name = pathname === '/' ? 'index.html' : pathname.slice(1);
  if (!/^[\w-]+(\.[\w-]+)+$/.test(name)) return null;
  const type = STATIC_TYPES[path.extname(name).toLowerCase()];
  const file = path.join(dir, name);
  if (!type || !fs.existsSync(file)) return null;
  return { file, type };
}
const MAIN_RANGE = `'${TABS.MAIN}'!A1:R5000`;
const SHEET_CACHE_MS = 15_000;
const POST_URL_RE = /^https?:\/\/(www\.|m\.|web\.)?facebook\.com\//i;
const STATUS_ORDER = { [STATUS.QUALIFIED]: 0, [STATUS.PENDING]: 1, [STATUS.REJECTED]: 2 };

class HttpError extends Error {
  constructor(status, message, extra = undefined) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

function readCookie(req, name) {
  for (const part of String(req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return '';
}

/** Áp duyệt tay hiện tại lên bản ghi đã lưu và tính lại trạng thái. */
export function applyManual(record, manual, sharesAvailable) {
  const decision = manual?.decision || '';
  const { status, reasons } = decideStatus({
    // Ô ghi chữ lạ (không phải OK/LOẠI) coi như chưa duyệt, giống lần quét.
    manualDecision: normalizeManual(decision),
    member: record.memberAuto,
    shareAuto: record.shareAuto,
    sharePrivacy: record.sharePrivacy,
    sharesAvailable,
  });
  return {
    ...record,
    status,
    reasons,
    manualDecision: decision,
    manualNormalized: normalizeManual(decision),
    manualNote: manual?.note || '',
  };
}

function sortRecords(records) {
  return records.sort(
    (a, b) =>
      STATUS_ORDER[a.status] - STATUS_ORDER[b.status] ||
      b.engagement - a.engagement ||
      b.likes - a.likes ||
      String(a.name).localeCompare(String(b.name), 'vi'),
  );
}

function defaultStartRun(rootDir) {
  return spawn(process.execPath, [path.join(rootDir, 'src', 'index.js'), 'run'], {
    cwd: rootDir,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function tailLog(rootDir, maxLines) {
  const dir = path.join(rootDir, 'logs');
  let files = [];
  try {
    files = fs.readdirSync(dir).filter((f) => /^\d{4}-\d{2}-\d{2}\.log$/.test(f)).sort();
  } catch {
    return { file: null, lines: [] };
  }
  if (!files.length) return { file: null, lines: [] };
  const file = files[files.length - 1];
  const lines = fs.readFileSync(path.join(dir, file), 'utf8').split(/\r?\n/).filter(Boolean);
  return { file, lines: lines.slice(-maxLines) };
}

/**
 * @param {object} opts
 * @param {object} opts.config cấu hình đã nạp (loadConfig), được cập nhật tại chỗ khi đổi postUrl
 * @param {string} opts.rootDir thư mục gốc chứa data/ và logs/
 * @param {string} opts.configPath đường dẫn config.json để ghi postUrl
 * @param {object} opts.sheets SheetsClient (readRange, batchWriteRanges)
 * @param {object} opts.logger
 * @param {Function} [opts.startRun] (rootDir) => ChildProcess, mặc định chạy "node src/index.js run"
 * @param {Function} [opts.verifyGoogle] (credential) => Promise<{ email, name }>, kiểm tra mã "Đăng nhập bằng Google";
 *   không có thì chặn mọi truy cập từ xa
 * @param {object} [opts.auth] kho Gmail/phiên đăng nhập (createAuthStore)
 */
export function createUiServer({
  config,
  rootDir,
  configPath,
  sheets,
  logger,
  startRun = defaultStartRun,
  verifyGoogle = null,
  auth = createAuthStore({ rootDir, allowedEmails: config.ui?.allowedEmails || [] }),
}) {
  const publicUrl = config.ui?.publicUrl ? new URL(config.ui.publicUrl) : null;
  let sheetCache = null;
  const uiRun = { child: null, startedAt: null, finishedAt: null, exitCode: null, output: [] };

  async function readMainRows({ force = false } = {}) {
    if (!force && sheetCache && Date.now() - sheetCache.at < SHEET_CACHE_MS) return sheetCache.rows;
    const rows = await sheets.readRange(config.sheetId, MAIN_RANGE);
    sheetCache = { at: Date.now(), rows };
    return rows;
  }

  function runStatus() {
    const lock = readRunLock(rootDir);
    return {
      running: Boolean(lock || uiRun.child),
      lock,
      uiRun: {
        running: Boolean(uiRun.child),
        startedAt: uiRun.startedAt,
        finishedAt: uiRun.finishedAt,
        exitCode: uiRun.exitCode,
        output: uiRun.output.slice(-40),
      },
    };
  }

  function publicConfig() {
    const state = loadState(rootDir);
    return {
      postUrl: config.postUrl || '',
      groupUrl: config.groupUrl,
      sheetUrl: `https://docs.google.com/spreadsheets/d/${config.sheetId}/edit`,
      timezone: config.timezone,
      freezeAt: config.freezeDate.toISOString(),
      finalRunAt: config.finalRunDate < config.freezeDate ? config.finalRunDate.toISOString() : null,
      intervalMinutes: config.intervalMinutes,
      memberCheck: config.memberCheck,
      frozen: isFrozen(config, new Date(), state),
    };
  }

  /**
   * Ai đang gọi: máy chạy tool (127.0.0.1) hay người dùng từ xa qua Tunnel.
   * Yêu cầu qua Tunnel luôn có header cf-ray / cf-connecting-ip do Cloudflare gắn, kể cả khi Host bị đổi,
   * nên dựa vào đó chứ không chỉ dựa vào Host.
   */
  function identify(req) {
    const viaTunnel = Boolean(req.headers['cf-ray'] || req.headers['cf-connecting-ip']) || (publicUrl && req.headers.host === publicUrl.host);
    if (!viaTunnel) return { remote: false, admin: true, email: '', label: 'máy chạy tool' };
    if (!verifyGoogle) {
      throw new HttpError(403, 'Truy cập từ xa chưa được bật: cần điền ui.googleClientId trong config.json.');
    }
    const email = auth.sessionEmail(readCookie(req, SESSION_COOKIE));
    if (!email) return { remote: true, admin: false, anonymous: true, email: '', label: 'khách chưa đăng nhập' };
    return { remote: true, admin: false, email, label: email };
  }

  async function handleLogin(body, viewer) {
    if (!viewer.remote) throw new HttpError(400, 'Trên máy chạy tool không cần đăng nhập.');
    let who;
    try {
      who = await verifyGoogle(String(body.credential || ''));
    } catch (err) {
      throw new HttpError(401, err.message);
    }
    const status = auth.recordLogin(who);
    logger.info(`Giao diện: ${who.email} đăng nhập bằng Google (${STATUS_LABEL[status]}).`);
    if (status === 'blocked') throw new HttpError(403, `Gmail ${who.email} đã bị chặn truy cập.`, { status });
    if (status !== 'allowed') {
      throw new HttpError(403, `Gmail ${who.email} chưa được cấp quyền. Đã ghi nhận yêu cầu, hãy báo người quản lý tool bấm Cho phép rồi đăng nhập lại.`, { status });
    }
    const { token, maxAge } = auth.createSession(who.email);
    return { email: who.email, cookie: `${SESSION_COOKIE}=${token}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${maxAge}` };
  }

  function handleVisitor(body, viewer) {
    if (!viewer.admin) throw new HttpError(403, 'Chỉ cấp hoặc chặn quyền được trên máy chạy tool.');
    const email = String(body.email || '').trim().toLowerCase();
    const status = String(body.status || '');
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new HttpError(400, 'Gmail không hợp lệ.');
    if (!['allowed', 'blocked'].includes(status)) throw new HttpError(400, 'Trạng thái chỉ nhận allowed hoặc blocked.');
    auth.setStatus(email, status);
    logger.info(`Giao diện (${viewer.label}): ${status === 'allowed' ? 'cho phép' : 'chặn'} ${email}.`);
    return { visitors: auth.listVisitors(), canManage: true };
  }

  async function buildData({ refresh }) {
    const state = loadState(rootDir);
    const results = loadResults(rootDir);
    let sheetManual = null;
    let sheetError = '';
    if (results) {
      try {
        sheetManual = parseManualColumns(await readMainRows({ force: refresh }));
      } catch (err) {
        sheetError = err.message;
      }
    }
    const records = sortRecords(
      (results?.records || []).map((r) =>
        applyManual(
          r,
          sheetManual ? sheetManual[r.uid] : { decision: r.manualDecision, note: r.manualNote },
          results.sharesAvailable,
        ),
      ),
    );
    return {
      config: publicConfig(),
      run: runStatus(),
      lastRun: state.lastRun,
      lastError: state.lastError,
      results: results
        ? {
            startedAt: results.startedAt,
            finishedAt: results.finishedAt,
            finalRun: results.finalRun,
            postUrl: results.postUrl,
            stats: results.stats,
            sharesAvailable: results.sharesAvailable,
          }
        : null,
      counts: summarize(records),
      records,
      rejected: results?.rejected || [],
      sheet: { ok: !sheetError, error: sheetError },
    };
  }

  function handleRun(viewer) {
    if (runStatus().running) throw new HttpError(409, 'Đang có một lần quét chạy, chờ xong rồi bấm lại.');
    if (!POST_URL_RE.test(config.postUrl || '')) throw new HttpError(400, 'Chưa có link bài viết minigame. Nhập link rồi bấm Lưu trước.');
    const child = startRun(rootDir);
    Object.assign(uiRun, { child, startedAt: new Date().toISOString(), finishedAt: null, exitCode: null, output: [] });
    const collect = (chunk) => {
      for (const line of String(chunk).split(/\r?\n/)) if (line.trim()) uiRun.output.push(line);
      if (uiRun.output.length > 400) uiRun.output.splice(0, uiRun.output.length - 400);
    };
    child.stdout?.on('data', collect);
    child.stderr?.on('data', collect);
    child.on('error', (err) => collect(`LỖI: không chạy được lần quét: ${err.message}`));
    child.on('close', (code) => {
      Object.assign(uiRun, { child: null, finishedAt: new Date().toISOString(), exitCode: code });
      sheetCache = null;
    });
    logger.info(`Giao diện (${viewer.label}): bắt đầu một lần quét.`);
    return runStatus();
  }

  async function handleManual(body, viewer) {
    const uid = String(body.uid || '').trim();
    const decision = String(body.decision ?? '').trim();
    const note = String(body.note ?? '').trim().slice(0, 500);
    if (!/^\d+$/.test(uid)) throw new HttpError(400, 'User ID không hợp lệ.');
    if (!['OK', 'LOẠI', ''].includes(decision)) throw new HttpError(400, 'Duyệt tay chỉ nhận OK, LOẠI hoặc để trống.');
    // Lần quét đọc cột duyệt tay rồi ghi lại cả bảng: ghi chen giữa lúc đó sẽ bị mất, nên khoá khi đang quét.
    if (runStatus().running) throw new HttpError(409, 'Đang quét, tạm khoá duyệt tay để không bị ghi đè. Thử lại khi quét xong.');

    const results = loadResults(rootDir);
    const record = results?.records.find((r) => r.uid === uid);
    const decided = record ? applyManual(record, { decision, note }, results.sharesAvailable) : null;
    const rows = await readMainRows({ force: true });
    const update = buildManualUpdate(rows, uid, { decision, note, status: decided?.status, reasons: decided?.reasons });
    if (!update) throw new HttpError(404, 'Không thấy dòng của user này trên tab Danh sách. Bấm Làm mới rồi thử lại.');
    await sheets.batchWriteRanges(config.sheetId, update.data);
    sheetCache = null;
    logger.info(`Giao diện (${viewer.label}): duyệt tay ${uid} (${record?.name || ''}) -> ${decision || 'bỏ duyệt'}${note ? ` | ${note}` : ''}`);
    return { record: decided, rowNumber: update.rowNumber };
  }

  function handleConfig(body, viewer) {
    const postUrl = String(body.postUrl || '').trim();
    if (!POST_URL_RE.test(postUrl)) throw new HttpError(400, 'Link phải là bài viết Facebook, bắt đầu bằng https://www.facebook.com/');
    const raw = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    raw.postUrl = postUrl;
    fs.writeFileSync(configPath, `${JSON.stringify(raw, null, 2)}\n`);
    config.postUrl = postUrl;
    logger.info(`Giao diện (${viewer.label}): đổi link bài viết thành ${postUrl}`);
    return { config: publicConfig() };
  }

  async function route(req, res, url, viewer) {
    const send = (status, data, headers = {}) => {
      res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers });
      res.end(JSON.stringify(data));
    };
    // Khách chưa đăng nhập chỉ thấy trang đăng nhập và các file tĩnh (không chứa dữ liệu).
    const page = viewer.anonymous && ['/', '/index.html'].includes(url.pathname) ? '/login.html' : url.pathname;
    const asset = req.method === 'GET' ? staticFile(page) : null;
    if (asset) {
      res.writeHead(200, { 'content-type': asset.type, 'cache-control': 'no-store' });
      res.end(fs.readFileSync(asset.file));
      return;
    }
    if (req.method === 'GET' && url.pathname === '/api/login-config') return send(200, { clientId: config.ui?.googleClientId || '' });
    let body = null;
    if (req.method === 'POST') {
      if (!/^application\/json\b/i.test(req.headers['content-type'] || '')) throw new HttpError(415, 'Yêu cầu phải là JSON.');
      body = await readBody(req);
      if (url.pathname === '/api/login') {
        const { email, cookie } = await handleLogin(body, viewer);
        return send(200, { email }, { 'set-cookie': cookie });
      }
      if (url.pathname === '/api/logout') {
        auth.deleteSession(readCookie(req, SESSION_COOKIE));
        return send(200, { ok: true }, { 'set-cookie': `${SESSION_COOKIE}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0` });
      }
    }
    if (viewer.anonymous) throw new HttpError(401, 'Cần đăng nhập bằng Google.');

    if (req.method === 'GET' && url.pathname === '/api/data') {
      const pendingVisitors = auth.listVisitors().filter((v) => v.status === 'pending' && v.count > 0).length;
      return send(200, {
        ...(await buildData({ refresh: url.searchParams.has('refresh') })),
        viewer: { remote: viewer.remote, email: viewer.email, admin: viewer.admin },
        pendingVisitors,
      });
    }
    if (req.method === 'GET' && url.pathname === '/api/visitors') {
      // Danh sách Gmail của cả team: chỉ xem trên máy chạy tool.
      if (!viewer.admin) throw new HttpError(403, 'Chỉ xem được danh sách người truy cập trên máy chạy tool.');
      return send(200, { visitors: auth.listVisitors(), canManage: true });
    }
    if (req.method === 'GET' && url.pathname === '/api/status') return send(200, { ...runStatus(), frozen: publicConfig().frozen });
    if (req.method === 'GET' && url.pathname === '/api/logs') {
      const lines = Math.min(Number(url.searchParams.get('lines')) || 300, 2000);
      return send(200, tailLog(rootDir, lines));
    }
    if (req.method === 'POST') {
      if (url.pathname === '/api/visitors') return send(200, handleVisitor(body, viewer));
      if (url.pathname === '/api/run') return send(200, handleRun(viewer));
      if (url.pathname === '/api/manual') return send(200, await handleManual(body, viewer));
      if (url.pathname === '/api/config') return send(200, handleConfig(body, viewer));
    }
    throw new HttpError(404, 'Không tìm thấy.');
  }

  const server = http.createServer(async (req, res) => {
    const port = server.address()?.port;
    const hosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
    const origins = new Set([`http://127.0.0.1:${port}`, `http://localhost:${port}`]);
    if (publicUrl) {
      hosts.add(publicUrl.host);
      origins.add(publicUrl.origin);
    }
    try {
      // Chặn DNS rebinding (Host lạ) và trang web khác gửi lệnh (Origin lạ).
      if (!hosts.has(req.headers.host || '')) {
        const viaTunnel = Boolean(req.headers['cf-ray'] || req.headers['cf-connecting-ip']);
        throw new HttpError(
          403,
          viaTunnel && !publicUrl
            ? 'Truy cập từ xa chưa được bật: điền ui.publicUrl và ui.googleClientId trong config.json rồi khởi động lại giao diện (scripts\\restart-ui.ps1 hoặc npm run ui).'
            : 'Host không hợp lệ.',
        );
      }
      const origin = req.headers.origin;
      if (origin && !origins.has(origin)) throw new HttpError(403, 'Origin không hợp lệ.');
      const viewer = identify(req);
      await route(req, res, new URL(req.url, `http://${req.headers.host}`), viewer);
    } catch (err) {
      const status = err.status || 500;
      if (status === 500) logger.error(`Giao diện: lỗi xử lý ${req.method} ${req.url}: ${err.message}`);
      if (!res.headersSent) res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: err.message, ...(err.extra || {}) }));
    }
  });
  return server;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > 64 * 1024) {
        reject(new HttpError(413, 'Dữ liệu gửi lên quá lớn.'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      try {
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {});
      } catch {
        reject(new HttpError(400, 'JSON không hợp lệ.'));
      }
    });
    req.on('error', reject);
  });
}
