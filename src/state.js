// Trạng thái cục bộ giữa các lần chạy: cache kiểm tra thành viên, bản lưu duyệt tay,
// số bình luận lần trước (để phát hiện lần quét tải thiếu), lần chạy gần nhất, trạng thái chốt.
import fs from 'node:fs';
import path from 'node:path';

const EMPTY = {
  members: {},
  manual: {},
  lastRun: null,
  lastCommentCount: null,
  lowCommentRuns: 0,
  finalRunFor: null,
  frozenNotifiedAt: null,
  frozenNotifiedFor: null,
  sheetFormatted: false,
};

export function loadState(rootDir) {
  const file = path.join(rootDir, 'data', 'state.json');
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    return { ...EMPTY, ...raw, members: raw.members || {}, manual: raw.manual || {} };
  } catch {
    return { ...EMPTY, members: {}, manual: {} };
  }
}

export function saveState(rootDir, state) {
  const dir = path.join(rootDir, 'data');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'state.json');
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, file);
}
