import test from 'node:test';
import assert from 'node:assert/strict';
import { groupByUser, buildRecords, countTags, normalizeManual, STATUS, summarize } from '../src/rules.js';

const RULES = { requiredTags: 5, countSelfTag: false, includeReplies: false };

function comment({ id, uid, name = `User ${uid}`, tags = [], likes = 0, replies = 0, top = true, created = 0 }) {
  return {
    id,
    author: { id: uid, name, anonymous: false },
    taggedUsers: tags.map((t) => ({ id: String(t) })),
    likes,
    replies,
    isTopLevel: top,
    createdAt: new Date(1759500000000 + created * 1000),
    text: `comment ${id}`,
  };
}

test('countTags đếm người khác nhau và bỏ tag chính mình', () => {
  const c = comment({ id: '1', uid: '9', tags: [1, 1, 2, 3, 9] });
  assert.equal(countTags(c, RULES), 3);
  assert.equal(countTags(c, { ...RULES, countSelfTag: true }), 4);
});

test('normalizeManual hiểu nhiều cách ghi', () => {
  assert.equal(normalizeManual(' ok '), 'OK');
  assert.equal(normalizeManual('Đạt'), 'OK');
  assert.equal(normalizeManual('LOẠI'), 'LOẠI');
  assert.equal(normalizeManual('x'), 'LOẠI');
  assert.equal(normalizeManual(''), '');
  assert.equal(normalizeManual('abc'), '');
});

test('groupByUser chọn bình luận đủ tag có tương tác cao nhất', () => {
  const comments = [
    comment({ id: 'a1', uid: '1', tags: [101, 102, 103, 104, 105], likes: 3, replies: 1, created: 1 }),
    comment({ id: 'a2', uid: '1', tags: [101, 102, 103, 104, 105, 106], likes: 10, replies: 0, created: 2 }),
    comment({ id: 'a3', uid: '1', tags: [101, 102, 103, 104, 105], likes: 50, replies: 0, top: false }),
    comment({ id: 'b1', uid: '2', tags: [101, 102, 103, 104], likes: 100 }),
    { id: 'anon', author: { id: null, anonymous: true }, taggedUsers: [], isTopLevel: true },
  ];
  const users = groupByUser(comments, RULES);
  assert.equal(users.size, 2);
  assert.equal(users.get('1').best.id, 'a2');
  assert.equal(users.get('1').candidates.length, 2);
  assert.equal(users.get('2').best, null);
  assert.equal(users.get('2').maxTags, 4);
});

test('groupByUser tính cả bình luận trả lời khi includeReplies', () => {
  const comments = [comment({ id: 'r1', uid: '1', tags: [101, 102, 103, 104, 105], likes: 7, top: false })];
  const users = groupByUser(comments, { ...RULES, includeReplies: true });
  assert.equal(users.get('1').best.id, 'r1');
});

test('buildRecords xếp trạng thái theo thành viên, share và duyệt tay', () => {
  const comments = [
    comment({ id: 'c1', uid: '1', tags: [101, 102, 103, 104, 105], likes: 5, replies: 2 }),
    comment({ id: 'c2', uid: '2', tags: [101, 102, 103, 104, 105], likes: 1 }),
    comment({ id: 'c3', uid: '3', tags: [101, 102, 103, 104, 105], likes: 9 }),
    comment({ id: 'c4', uid: '4', tags: [101, 102, 103, 104, 105], likes: 20 }),
    comment({ id: 'c5', uid: '5', tags: [101, 102, 103, 104, 105], likes: 8 }),
    comment({ id: 'c6', uid: '6', tags: [101, 102], likes: 99 }),
  ];
  const users = groupByUser(comments, RULES);
  const sharers = new Map([
    ['1', { id: '1', isPublic: true, privacy: 'Công khai' }],
    ['5', { id: '5', isPublic: false, privacy: 'Bạn bè' }],
  ]);
  const memberStatus = { 1: 'member', 2: 'member', 3: 'not_member', 4: 'unknown', 5: 'member' };
  const manual = { 4: { decision: 'OK', note: 'đã kiểm tra tay' }, 5: { decision: 'loại', note: '' } };

  const { records, rejected } = buildRecords({ users, sharers, memberStatus, manual, sharesAvailable: true, rules: RULES });
  const byUid = Object.fromEntries(records.map((r) => [r.uid, r]));

  assert.equal(byUid['1'].status, STATUS.QUALIFIED);
  assert.equal(byUid['1'].engagement, 7);
  assert.equal(byUid['1'].shareLabel, 'Đã share công khai');

  assert.equal(byUid['2'].status, STATUS.PENDING);
  assert.match(byUid['2'].reasons.join(' '), /không thấy trong danh sách chia sẻ/);

  assert.equal(byUid['3'].status, STATUS.REJECTED);
  assert.match(byUid['3'].reasons.join(' '), /Không phải thành viên/);

  assert.equal(byUid['4'].status, STATUS.QUALIFIED);
  assert.equal(byUid['4'].manualDecision, 'OK');
  assert.equal(byUid['4'].manualNote, 'đã kiểm tra tay');

  assert.equal(byUid['5'].status, STATUS.REJECTED);
  assert.equal(byUid['5'].shareAuto, 'shared_private');

  // Thứ tự: đủ điều kiện (tương tác cao trước), rồi chờ duyệt, rồi loại.
  assert.deepEqual(records.map((r) => r.uid), ['4', '1', '2', '3', '5']);

  assert.equal(rejected.length, 1);
  assert.equal(rejected[0].uid, '6');
  assert.match(rejected[0].reason, /Tag 2\/5/);

  assert.deepEqual(summarize(records), { [STATUS.QUALIFIED]: 2, [STATUS.PENDING]: 1, [STATUS.REJECTED]: 2 });
});

test('buildRecords báo chưa đọc được danh sách share khi hộp thoại không mở', () => {
  const users = groupByUser([comment({ id: 'c1', uid: '1', tags: [101, 102, 103, 104, 105] })], RULES);
  const { records } = buildRecords({ users, sharers: new Map(), memberStatus: { 1: 'member' }, manual: {}, sharesAvailable: false, rules: RULES });
  assert.equal(records[0].status, STATUS.PENDING);
  assert.match(records[0].reasons.join(' '), /chưa đọc được danh sách chia sẻ/);
});
