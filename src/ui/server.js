// Giao diện quản lý chạy trên máy: http://127.0.0.1:<port>/
// Đọc kết quả lần quét gần nhất (data/results.json) kết hợp cột duyệt tay trên Google Sheet,
// cho phép nhập link bài viết, bấm chạy quét và duyệt tay OK / LOẠI theo User ID.
// Chỉ lắng nghe 127.0.0.1 và kiểm tra Host/Origin để trang web khác không gửi lệnh vào được.
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
  constructor(status, message) {
    super(message);
    this.status = status;
  }
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
 */
export function createUiServer({ config, rootDir, configPath, sheets, logger, startRun = defaultStartRun }) {
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

  function handleRun() {
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
    logger.info('Giao diện: bắt đầu một lần quét.');
    return runStatus();
  }

  async function handleManual(body) {
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
    logger.info(`Giao diện: duyệt tay ${uid} (${record?.name || ''}) -> ${decision || 'bỏ duyệt'}${note ? ` | ${note}` : ''}`);
    return { record: decided, rowNumber: update.rowNumber };
  }

  function handleConfig(body) {
    const postUrl = String(body.postUrl || '').trim();
    if (!POST_URL_RE.test(postUrl)) throw new HttpError(400, 'Link phải là bài viết Facebook, bắt đầu bằng https://www.facebook.com/');
    const raw = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    raw.postUrl = postUrl;
    fs.writeFileSync(configPath, `${JSON.stringify(raw, null, 2)}\n`);
    config.postUrl = postUrl;
    logger.info(`Giao diện: đổi link bài viết thành ${postUrl}`);
    return { config: publicConfig() };
  }

  async function route(req, res, url) {
    const send = (status, data) => {
      res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      res.end(JSON.stringify(data));
    };
    const asset = req.method === 'GET' ? staticFile(url.pathname) : null;
    if (asset) {
      res.writeHead(200, { 'content-type': asset.type, 'cache-control': 'no-store' });
      res.end(fs.readFileSync(asset.file));
      return;
    }
    if (req.method === 'GET' && url.pathname === '/api/data') return send(200, await buildData({ refresh: url.searchParams.has('refresh') }));
    if (req.method === 'GET' && url.pathname === '/api/status') return send(200, { ...runStatus(), frozen: publicConfig().frozen });
    if (req.method === 'GET' && url.pathname === '/api/logs') {
      const lines = Math.min(Number(url.searchParams.get('lines')) || 300, 2000);
      return send(200, tailLog(rootDir, lines));
    }
    if (req.method === 'POST') {
      if (!/^application\/json\b/i.test(req.headers['content-type'] || '')) throw new HttpError(415, 'Yêu cầu phải là JSON.');
      const body = await readBody(req);
      if (url.pathname === '/api/run') return send(200, handleRun());
      if (url.pathname === '/api/manual') return send(200, await handleManual(body));
      if (url.pathname === '/api/config') return send(200, handleConfig(body));
    }
    throw new HttpError(404, 'Không tìm thấy.');
  }

  const server = http.createServer(async (req, res) => {
    const port = server.address()?.port;
    const allowed = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
    try {
      // Chặn DNS rebinding (Host lạ) và trang web khác gửi lệnh (Origin lạ).
      if (!allowed.has(req.headers.host || '')) throw new HttpError(403, 'Host không hợp lệ.');
      const origin = req.headers.origin;
      if (origin && !allowed.has(origin.replace(/^http:\/\//, ''))) throw new HttpError(403, 'Origin không hợp lệ.');
      await route(req, res, new URL(req.url, `http://${req.headers.host}`));
    } catch (err) {
      const status = err.status || 500;
      if (status === 500) logger.error(`Giao diện: lỗi xử lý ${req.method} ${req.url}: ${err.message}`);
      if (!res.headersSent) res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: err.message }));
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
