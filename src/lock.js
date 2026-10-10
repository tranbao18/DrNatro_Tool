// Khoá chống chạy trùng: chỉ một lần quét được dùng profile Facebook và ghi sheet tại một thời điểm
// (watch, lịch Windows và nút "Chạy quét" trên giao diện đều đi qua đây). File khoá: data/run.lock.
import fs from 'node:fs';
import path from 'node:path';

// Lần quét bị tắt ngang (Task Scheduler dừng sau 50 phút, tắt máy...) để lại file khoá: coi là hết hạn sau 2 giờ.
const STALE_MS = 2 * 3600_000;

function lockFile(rootDir) {
  return path.join(rootDir, 'data', 'run.lock');
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

/** Trả về { pid, startedAt } nếu đang có lần quét chạy, ngược lại null (và dọn file khoá cũ). */
export function readRunLock(rootDir, now = Date.now()) {
  const file = lockFile(rootDir);
  let lock;
  try {
    lock = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
  const age = now - Date.parse(lock.startedAt || '');
  if (lock.pid && isAlive(lock.pid) && age >= 0 && age < STALE_MS) return lock;
  fs.rmSync(file, { force: true });
  return null;
}

export function acquireRunLock(rootDir) {
  const existing = readRunLock(rootDir);
  if (existing) {
    throw new Error(`Đang có một lần quét khác chạy (PID ${existing.pid}, bắt đầu ${existing.startedAt}). Bỏ qua lần này.`);
  }
  const file = lockFile(rootDir);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const lock = { pid: process.pid, startedAt: new Date().toISOString() };
  try {
    fs.writeFileSync(file, JSON.stringify(lock), { flag: 'wx' });
  } catch (err) {
    if (err.code === 'EEXIST') throw new Error('Đang có một lần quét khác vừa bắt đầu. Bỏ qua lần này.');
    throw err;
  }
  return lock;
}

export function releaseRunLock(rootDir) {
  const current = (() => {
    try {
      return JSON.parse(fs.readFileSync(lockFile(rootDir), 'utf8'));
    } catch {
      return null;
    }
  })();
  if (current?.pid === process.pid) fs.rmSync(lockFile(rootDir), { force: true });
}
