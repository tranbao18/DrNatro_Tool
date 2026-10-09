import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseMultiJson, extractEmbeddedJson, extractComments, extractShareActors } from '../src/fb/graphql.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const load = (name) => JSON.parse(fs.readFileSync(path.join(here, 'fixtures', name), 'utf8'));

test('parseMultiJson tách nhiều JSON nối bằng xuống dòng', () => {
  const docs = parseMultiJson('{"a":1}\n{"b":2}\n');
  assert.equal(docs.length, 2);
  assert.deepEqual(docs[1], { b: 2 });
  assert.deepEqual(parseMultiJson('  '), []);
  assert.deepEqual(parseMultiJson('{"x":[1,2]}'), [{ x: [1, 2] }]);
});

test('extractEmbeddedJson lấy khối application/json trong HTML', () => {
  const html = '<html><script type="application/json" data-content-len="10">{"require":[1]}</script><script>var x=1</script></html>';
  const docs = extractEmbeddedJson(html);
  assert.equal(docs.length, 1);
  assert.deepEqual(docs[0], { require: [1] });
});

test('extractComments chuẩn hoá bình luận, tag, like và phản hồi', () => {
  const comments = extractComments(load('comments-payload.json'));
  assert.equal(comments.length, 3);
  const [a, b, c] = comments;

  assert.equal(a.id, '11111');
  assert.equal(a.author.id, '1001');
  assert.equal(a.author.name, 'Nguyễn Văn A');
  assert.equal(a.taggedUsers.length, 5);
  assert.equal(a.likes, 12);
  assert.equal(a.replies, 3);
  assert.equal(a.isTopLevel, true);
  assert.equal(a.createdAt.toISOString(), new Date(1759500000 * 1000).toISOString());
  assert.match(a.url, /comment_id=11111/);

  // Tag trùng và tag Page không tính, tag chính mình được giữ để luật xử lý.
  assert.equal(b.id, '22222');
  assert.equal(b.taggedUsers.length, 3);
  assert.equal(b.taggedSelf, true);
  assert.equal(b.likes, 40);
  assert.equal(b.replies, 1);

  // Bình luận trả lời: id giải mã từ base64, không phải top-level, like cộng từ top_reactions.
  assert.equal(c.id, '33333');
  assert.equal(c.isTopLevel, false);
  assert.equal(c.parentId, '11111');
  assert.equal(c.likes, 3);
  assert.equal(c.replies, 0);
});

test('extractComments bỏ qua object không phải Comment', () => {
  assert.deepEqual(extractComments({ data: { __typename: 'User', author: {} } }), []);
  assert.deepEqual(extractComments(null), []);
});

test('extractShareActors đọc người chia sẻ kèm chế độ riêng tư', () => {
  const actors = extractShareActors(load('shares-payload.json'));
  const byId = new Map(actors.map((a) => [a.id, a]));
  assert.equal(actors.length, 3);
  assert.equal(byId.get('1001').isPublic, true);
  assert.equal(byId.get('1001').privacy, 'Công khai');
  assert.equal(byId.get('1005').isPublic, false);
  assert.equal(byId.get('1005').privacy, 'Bạn bè | friends');
  assert.equal(byId.get('1006').isPublic, undefined);
  assert.equal(byId.get('1006').url, 'https://www.facebook.com/profile.php?id=1006');
});
