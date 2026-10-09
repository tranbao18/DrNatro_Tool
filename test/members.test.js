import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyMemberPage, cachedMemberStatus } from '../src/fb/members.js';
import { isExpandLabel, isReplyExpandLabel } from '../src/fb/post.js';

const url = 'https://www.facebook.com/groups/1644256277377552/user/1001/';

test('classifyMemberPage nhận diện thành viên, không phải thành viên và không rõ', () => {
  assert.equal(classifyMemberPage({ finalUrl: url, uid: '1001', bodyText: 'Nguyễn A\nĐã tham gia nhóm vào 2 năm trước' }).status, 'member');
  assert.equal(classifyMemberPage({ finalUrl: url, uid: '1001', bodyText: 'Joined on March 3, 2024' }).status, 'member');
  assert.equal(classifyMemberPage({ finalUrl: url, uid: '1001', bodyText: 'Nội dung này hiện không hiển thị' }).status, 'not_member');
  assert.equal(classifyMemberPage({ finalUrl: url, uid: '1001', bodyText: "This content isn't available right now" }).status, 'not_member');
  assert.equal(classifyMemberPage({ finalUrl: 'https://www.facebook.com/groups/1644256277377552/', uid: '1001', bodyText: 'Yêu cầu tham gia' }).status, 'unknown');
  assert.equal(classifyMemberPage({ finalUrl: url, uid: '1001', bodyText: 'Yêu cầu tham gia\nCông cụ quản trị' }).status, 'unknown');
  assert.equal(classifyMemberPage({ finalUrl: url, uid: '1001', bodyText: 'Trang này hiện không khả dụng' }).status, 'not_member');
});

test('classifyMemberPage không tự loại thành viên vì chữ trong bài viết của họ', () => {
  const joined = 'Đã tham gia nhóm vào tháng 3/2024\n';
  assert.equal(classifyMemberPage({ finalUrl: url, uid: '1001', bodyText: `${joined}Sản phẩm tạm thời không khả dụng, mọi người chờ nhé` }).status, 'member');
  const conflict = classifyMemberPage({ finalUrl: url, uid: '1001', bodyText: `${joined}Chị Lan đã rời nhóm rồi` });
  assert.equal(conflict.status, 'unknown');
  assert.match(conflict.evidence, /^conflict:/);
});

test('cachedMemberStatus tôn trọng thời hạn cache', () => {
  const now = Date.parse('2026-10-04T10:00:00Z');
  const state = {
    members: {
      a: { status: 'member', checkedAt: '2026-10-04T00:00:00Z' },
      b: { status: 'member', checkedAt: '2026-10-02T00:00:00Z' },
      c: { status: 'unknown', checkedAt: '2026-10-04T02:00:00Z' },
    },
  };
  assert.equal(cachedMemberStatus(state, 'a', 24, now), 'member');
  assert.equal(cachedMemberStatus(state, 'b', 24, now), undefined);
  assert.equal(cachedMemberStatus(state, 'c', 24, now), undefined);
  assert.equal(cachedMemberStatus(state, 'zzz', 24, now), undefined);
});

test('isExpandLabel chỉ nhận nút tải thêm bình luận/phản hồi', () => {
  for (const label of ['Xem thêm bình luận', 'View more comments', 'View 12 more comments', 'Xem tất cả 3 phản hồi', '2 phản hồi', 'View all 4 replies', '1 reply', 'Xem thêm 5 câu trả lời', 'Xem bình luận trước']) {
    assert.equal(isExpandLabel(label), true, label);
  }
  for (const label of ['Viết bình luận...', 'Bình luận', 'Trả lời', 'Thích', 'Phù hợp nhất', 'Xem thêm', 'Write a comment', 'Reply', '']) {
    assert.equal(isExpandLabel(label), false, label);
  }
  assert.equal(isReplyExpandLabel('Xem tất cả 3 phản hồi'), true);
  assert.equal(isReplyExpandLabel('Xem thêm bình luận'), false);
});
