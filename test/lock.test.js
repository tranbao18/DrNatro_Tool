import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { acquireRunLock, releaseRunLock, readRunLock } from '../src/lock.js';

test('khoá chạy: không cho chạy trùng, tự dọn khoá của tiến trình đã chết hoặc quá cũ', () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'drnatro-lock-'));
  const file = path.join(rootDir, 'data', 'run.lock');
  try {
    assert.equal(readRunLock(rootDir), null);
    acquireRunLock(rootDir);
    assert.equal(readRunLock(rootDir).pid, process.pid);
    assert.throws(() => acquireRunLock(rootDir), /Đang có một lần quét khác/);
    releaseRunLock(rootDir);
    assert.equal(fs.existsSync(file), false);

    // Tiến trình đã chết (PID không tồn tại): khoá bị bỏ qua và xoá.
    fs.writeFileSync(file, JSON.stringify({ pid: 2 ** 22 + 12345, startedAt: new Date().toISOString() }));
    assert.equal(readRunLock(rootDir), null);
    assert.equal(fs.existsSync(file), false);

    // Khoá quá 2 giờ: coi là hết hạn dù PID còn sống (PID có thể đã bị Windows dùng lại).
    fs.writeFileSync(file, JSON.stringify({ pid: process.pid, startedAt: new Date(Date.now() - 3 * 3600_000).toISOString() }));
    assert.equal(readRunLock(rootDir), null);
    acquireRunLock(rootDir);
    releaseRunLock(rootDir);
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});
