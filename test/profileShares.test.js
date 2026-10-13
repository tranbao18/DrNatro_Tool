// Kiểm thử nhận diện bài share bài minigame trên tường cá nhân (dữ liệu mô phỏng cấu trúc Facebook thật).
import test from 'node:test';
import assert from 'node:assert/strict';
import { findPostShare, postIdFromUrl, cachedShareStatus } from '../src/fb/profileShares.js';
import { groupByUser, buildRecords, STATUS } from '../src/rules.js';

const POST = '1673256827810830';
const b64 = (s) => Buffer.from(s).toString('base64');

/** Bài share trên tường: actor là người share, attached_story là bài gốc trong group. */
function shareStory({ actorId = '111', attachedId = `S:_I999:VK:${POST}`, privacy = 'Công khai', icon = 'everyone' } = {}) {
  return {
    __typename: 'Story',
    actors: [{ __typename: 'User', id: actorId, name: 'Người share' }],
    attached_story: {
      __typename: 'Story',
      id: b64(attachedId),
      // Chế độ của bài gốc (group), không được lấy nhầm làm chế độ của bài share.
      privacy_scope: { description: 'Nhóm công khai', icon_image: { name: 'everyone' } },
    },
    comet_sections: {
      // Bài gốc lặp lại bên trong bài share (giống dữ liệu thật), kèm chế độ của group.
      content: { story: { comet_sections: { attached: { privacy_scope: { description: 'Nhóm công khai', icon_image: { name: 'everyone' } } } } } },
      context_layout: { story: { privacy_scope: { description: privacy, icon_image: { name: icon } } } },
    },
  };
}

const timeline = (...stories) => ({ data: { node: { timeline_list_feed_units: { edges: stories.map((node) => ({ node })) } } } });

test('postIdFromUrl đọc mã bài từ các dạng link', () => {
  assert.equal(postIdFromUrl(`https://www.facebook.com/groups/1644256277377552/permalink/${POST}/`), POST);
  assert.equal(postIdFromUrl(`https://www.facebook.com/groups/bikip/posts/${POST}`), POST);
  assert.equal(postIdFromUrl(`https://www.facebook.com/permalink.php?story_fbid=${POST}&id=1`), POST);
  assert.equal(postIdFromUrl('https://www.facebook.com/groups/1/posts/pfbid0abc'), null);
});

test('findPostShare nhận ra bài share công khai của chính người đó', () => {
  const hit = findPostShare([timeline(shareStory())], { uid: '111', postId: POST });
  assert.deepEqual(hit, { privacy: { label: 'Công khai', isPublic: true } });
  // Dạng ID khác: "S:_I<tác giả>:<mã bài>:<mã bài>".
  assert.ok(findPostShare([timeline(shareStory({ attachedId: `S:_I999:${POST}:${POST}` }))], { uid: '111', postId: POST }));
});

test('findPostShare: share chế độ Bạn bè không phải công khai; bài khác hoặc người khác thì không tính', () => {
  const friends = findPostShare([timeline(shareStory({ privacy: 'Bạn bè', icon: 'friends' }))], { uid: '111', postId: POST });
  assert.deepEqual(friends, { privacy: { label: 'Bạn bè', isPublic: false } });
  assert.equal(findPostShare([timeline(shareStory({ attachedId: 'S:_I999:VK:999999' }))], { uid: '111', postId: POST }), null);
  assert.equal(findPostShare([timeline(shareStory({ actorId: '222' }))], { uid: '111', postId: POST }), null, 'người khác share lên tường');
  assert.equal(findPostShare([timeline()], { uid: '111', postId: POST }), null);
});

test('cachedShareStatus: đã share thì nhớ luôn, chưa thấy thì hết hạn sau vài giờ, đổi bài thì bỏ', () => {
  const now = Date.parse('2026-10-13T10:00:00Z');
  const state = {
    profileShares: {
      a: { postId: POST, status: 'shared', checkedAt: '2026-10-01T00:00:00Z' },
      b: { postId: POST, status: 'not_found', checkedAt: '2026-10-13T09:00:00Z' },
      c: { postId: POST, status: 'not_found', checkedAt: '2026-10-13T05:00:00Z' },
      d: { postId: '999', status: 'shared', checkedAt: '2026-10-13T09:00:00Z' },
    },
  };
  assert.equal(cachedShareStatus(state, 'a', POST, 3, now).status, 'shared');
  assert.equal(cachedShareStatus(state, 'b', POST, 3, now).status, 'not_found');
  assert.equal(cachedShareStatus(state, 'c', POST, 3, now), undefined);
  assert.equal(cachedShareStatus(state, 'd', POST, 3, now), undefined);
  assert.equal(cachedShareStatus(state, 'zzz', POST, 3, now), undefined);
});

test('buildRecords: lý do rõ ràng khi đã xem tường mà không thấy share, hoặc không xem được trang', () => {
  const comment = (uid) => ({
    id: `c${uid}`,
    author: { id: uid, name: `U${uid}` },
    isTopLevel: true,
    taggedUsers: [1, 2, 3, 4, 5].map((n) => ({ id: `t${n}` })),
    likes: 1,
    replies: 0,
  });
  const users = groupByUser([comment('1'), comment('2'), comment('3')], { requiredTags: 5, countSelfTag: false, includeReplies: false });
  const sharers = new Map([['1', { id: '1', privacy: 'Công khai', isPublic: true, source: 'profile' }]]);
  const { records } = buildRecords({
    users,
    sharers,
    memberStatus: { 1: 'member', 2: 'member', 3: 'member' },
    manual: {},
    sharesAvailable: false,
    profileShares: { 2: 'not_found', 3: 'unknown' },
    rules: { requiredTags: 5 },
  });
  const byUid = Object.fromEntries(records.map((r) => [r.uid, r]));
  assert.equal(byUid['1'].status, STATUS.QUALIFIED);
  assert.equal(byUid['2'].status, STATUS.PENDING);
  assert.match(byUid['2'].reasons.join(), /không thấy bài chia sẻ công khai trên trang cá nhân/);
  assert.equal(byUid['2'].shareLabel, 'Chưa thấy share công khai');
  assert.match(byUid['3'].reasons.join(), /không xem được trang cá nhân/);
});
