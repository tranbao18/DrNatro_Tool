// Trạng thái cục bộ giữa các lần chạy: cache kiểm tra thành viên, bản lưu duyệt tay,
// số bình luận lần trước (để phát hiện lần quét tải thiếu), lần chạy gần nhất, trạng thái chốt.
// Kết quả lần quét thành công gần nhất lưu riêng ở data/results.json cho giao diện quản lý đọc.
import fs from 'node:fs';
import path from 'node:path';

const EMPTY = {
  members: {},
  manual: {},
  lastRun: null,
  lastError: null,
  lastCommentCount: null,
  lastPostUrl: null,
  lowCommentRuns: 0,
  finalRunFor: null,
  frozenNotifiedAt: null,
  frozenNotifiedFor: null,
  sheetFormatted: false,
};

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function writeJsonAtomic(rootDir, name, value) {
  const dir = path.join(rootDir, 'data');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, name);
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
  fs.renameSync(tmp, file);
}

export function loadState(rootDir) {
  try {
    const raw = readJson(path.join(rootDir, 'data', 'state.json'));
    return { ...EMPTY, ...raw, members: raw.members || {}, manual: raw.manual || {} };
  } catch {
    return { ...EMPTY, members: {}, manual: {} };
  }
}

export function saveState(rootDir, state) {
  writeJsonAtomic(rootDir, 'state.json', state);
}

/** Kết quả lần quét thành công gần nhất, hoặc null nếu chưa quét lần nào. */
export function loadResults(rootDir) {
  try {
    return readJson(path.join(rootDir, 'data', 'results.json'));
  } catch {
    return null;
  }
}

export function saveResults(rootDir, results) {
  writeJsonAtomic(rootDir, 'results.json', results);
}
