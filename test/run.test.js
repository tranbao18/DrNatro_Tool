import test from 'node:test';
import assert from 'node:assert/strict';
import { isFrozen, isFinalRun, checkCommentDrop, MAX_LOW_COMMENT_RUNS } from '../src/run.js';

const freezeAt = '2026-10-21T00:00:00+07:00';
const config = {
  freezeAt,
  freezeDate: new Date(freezeAt),
  finalRunDate: new Date(Date.parse(freezeAt) - 15 * 60_000),
};
const at = (s) => new Date(`2026-10-20T${s}+07:00`);

test('isFinalRun chỉ đúng trong 15 phút cuối trước mốc chốt', () => {
  assert.equal(isFinalRun(config, at('23:44:59')), false);
  assert.equal(isFinalRun(config, at('23:45:00')), true);
  assert.equal(isFinalRun(config, at('23:59:59')), true);
  assert.equal(isFinalRun(config, new Date('2026-10-21T00:00:00+07:00')), false);
  const noLead = { ...config, finalRunDate: config.freezeDate };
  assert.equal(isFinalRun(noLead, at('23:59:00')), false, 'finalRunLeadMinutes = 0 thì không có lần chốt cuối');
});

test('isFrozen chốt khi qua mốc hoặc khi lần chốt cuối của đúng mốc này đã xong', () => {
  assert.equal(isFrozen(config, at('23:50:00'), {}), false);
  assert.equal(isFrozen(config, at('23:50:00'), { finalRunFor: freezeAt }), true);
  assert.equal(isFrozen(config, at('23:50:00'), { finalRunFor: '2026-10-15T00:00:00+07:00' }), false, 'đổi freezeAt thì mở lại');
  assert.equal(isFrozen(config, new Date('2026-10-21T00:00:00+07:00'), {}), true);
});

test('checkCommentDrop chặn ghi đè khi số bình luận tụt mạnh, chấp nhận sau nhiều lần liên tiếp', () => {
  assert.deepEqual(checkCommentDrop({ count: 500, lastCount: null, minRatio: 0.8 }), { ok: true, lowRuns: 0 });
  assert.deepEqual(checkCommentDrop({ count: 900, lastCount: 1000, minRatio: 0.8, lowRuns: 2 }), { ok: true, lowRuns: 0 });
  assert.deepEqual(checkCommentDrop({ count: 300, lastCount: 1000, minRatio: 0 }), { ok: true, lowRuns: 0 }, 'minRatio = 0 thì tắt kiểm tra');
  let lowRuns = 0;
  for (let i = 1; i < MAX_LOW_COMMENT_RUNS; i += 1) {
    const r = checkCommentDrop({ count: 300, lastCount: 1000, minRatio: 0.8, lowRuns });
    assert.deepEqual(r, { ok: false, lowRuns: i });
    lowRuns = r.lowRuns;
  }
  assert.deepEqual(checkCommentDrop({ count: 300, lastCount: 1000, minRatio: 0.8, lowRuns }), { ok: true, lowRuns: MAX_LOW_COMMENT_RUNS });
});
