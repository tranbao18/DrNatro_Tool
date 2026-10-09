// Kiểm thử luồng duyệt trang bằng một "Facebook giả" chạy trên localhost:
// trang bài viết có JSON nhúng, nút "Xem thêm bình luận" gọi /api/graphql/,
// hộp thoại chia sẻ, và trang hồ sơ thành viên. Cần Chromium của Playwright.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchBrowser } from '../src/browser.js';
import { collectPostComments } from '../src/fb/post.js';
import { collectShares } from '../src/fb/shares.js';
import { checkMembership } from '../src/fb/members.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = (name) => fs.readFileSync(path.join(here, 'fixtures', name), 'utf8');
const silent = { info() {}, warn() {}, error() {}, debug() {} };

function firstCommentOnly(payloadText) {
  const payload = JSON.parse(payloadText);
  const edges = payload.data.node.comment_rendering_instance_for_feed_location.comments.edges;
  const first = JSON.parse(JSON.stringify(payload));
  first.data.node.comment_rendering_instance_for_feed_location.comments.edges = [edges[0]];
  const rest = JSON.parse(JSON.stringify(payload));
  rest.data.node.comment_rendering_instance_for_feed_location.comments.edges = edges.slice(1);
  return { first: JSON.stringify(first), rest: JSON.stringify(rest) };
}

const PAGE = (embedded) => `<!doctype html><html><head><meta charset="utf-8"><title>Bài viết</title></head><body>
<script type="application/json" data-content-len="1">${embedded}</script>
<div id="post">
  <div role="button" id="share-count" tabindex="0">3 lượt chia sẻ</div>
  <div role="button" id="sort" tabindex="0">Phù hợp nhất</div>
  <div id="menu" style="display:none" role="menu"><div role="menuitem" tabindex="0">Tất cả bình luận</div></div>
  <div id="comments"><div>Bình luận 1</div></div>
  <div role="button" id="more" tabindex="0">Xem thêm bình luận</div>
  <div role="button" id="write" tabindex="0">Viết bình luận...</div>
</div>
<div id="dialog" role="dialog" style="display:none;height:300px;overflow:auto"><div style="height:2000px">Người đã chia sẻ</div></div>
<script>
  const gql = (name) => fetch('/api/graphql/', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'fb_api_req_friendly_name=' + name + '&doc_id=1' }).then(r => r.text());
  document.getElementById('sort').onclick = () => { document.getElementById('menu').style.display = 'block'; };
  document.querySelector('[role=menuitem]').onclick = () => { document.getElementById('menu').style.display = 'none'; document.getElementById('sort').textContent = 'Tất cả bình luận'; };
  document.getElementById('more').onclick = async () => {
    await gql('CommentsListComponentsPaginationQuery');
    document.getElementById('comments').insertAdjacentHTML('beforeend', '<div>Bình luận 2</div><div role="button" id="replies" tabindex="0">Xem tất cả 1 phản hồi</div>');
    document.getElementById('more').remove();
    document.getElementById('replies').onclick = async () => { await gql('Depth1CommentsListPaginationQuery'); document.getElementById('replies').remove(); };
  };
  document.getElementById('share-count').onclick = async () => { document.getElementById('dialog').style.display = 'block'; await gql('CometUFIShareActorsListDialogQuery'); };
</script></body></html>`;

function startServer() {
  const { first, rest } = firstCommentOnly(fixture('comments-payload.json'));
  const shares = fixture('shares-payload.json');
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    if (req.method === 'POST' && url.pathname === '/api/graphql/') {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        res.setHeader('content-type', 'application/json');
        if (/Share/.test(body)) res.end(shares);
        else if (/Depth1/.test(body)) res.end('{"data":{}}\n{"label":"deferred"}\n');
        else res.end(rest + '\n{"label":"deferred","data":{}}\n');
      });
      return;
    }
    if (url.pathname === '/post') {
      res.setHeader('content-type', 'text/html; charset=utf-8');
      res.end(PAGE(first));
      return;
    }
    const member = url.pathname.match(/^\/groups\/(\d+)\/user\/(\d+)\/?$/);
    if (member) {
      res.setHeader('content-type', 'text/html; charset=utf-8');
      if (member[2] === '1001') res.end('<html><body><h1>Nguyễn Văn A</h1><div>Đã tham gia nhóm vào 2 năm trước</div></body></html>');
      else if (member[2] === '1002') res.end('<html><body><div>Nội dung này hiện không hiển thị</div></body></html>');
      else res.end('<html><body><div>Trang trắng</div></body></html>');
      return;
    }
    res.statusCode = 404;
    res.end('not found');
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

test('duyệt bài viết giả: gom bình luận, danh sách share và kiểm tra thành viên', { timeout: 120_000 }, async () => {
  const server = await startServer();
  const base = `http://127.0.0.1:${server.address().port}`;
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'drnatro-e2e-'));
  const config = {
    postUrl: `${base}/post`,
    groupUrl: `${base}/groups/1644256277377552`,
    timezone: 'Asia/Ho_Chi_Minh',
    profilePath: path.join(rootDir, 'profile'),
    browser: { headless: true, locale: 'vi-VN' },
    limits: { maxExpandClicks: 20, expandReplies: true, minDelayMs: 10, maxDelayMs: 20 },
    debug: { dumpGraphql: true },
  };
  const context = await launchBrowser(config, { headless: true });
  try {
    const page = context.pages()[0] || (await context.newPage());

    const { comments } = await collectPostComments(page, config, silent, { rootDir });
    assert.equal(comments.size, 3, 'phải gom đủ 3 bình luận: 1 từ HTML nhúng, 2 từ GraphQL');
    assert.equal(comments.get('11111').likes, 12);
    assert.equal(comments.get('22222').author.name, 'Trần Thị B');
    assert.equal(comments.get('33333').isTopLevel, false);
    assert.equal(await page.locator('#sort').innerText(), 'Tất cả bình luận');
    assert.equal(await page.locator('#more').count(), 0, 'nút Xem thêm phải đã được bấm');
    assert.equal(await page.locator('#replies').count(), 0, 'nút xem phản hồi phải đã được bấm');
    assert.ok(fs.readdirSync(path.join(rootDir, 'data', 'debug', 'graphql')).length >= 2, 'phải dump payload khi bật debug');

    const shares = await collectShares(page, config, silent, { rootDir });
    assert.equal(shares.found, true);
    assert.deepEqual([...shares.sharers.keys()].sort(), ['1001', '1005', '1006']);
    assert.equal(shares.sharers.get('1001').isPublic, true);

    assert.equal((await checkMembership(page, config, '1001', silent)).status, 'member');
    assert.equal((await checkMembership(page, config, '1002', silent)).status, 'not_member');
    assert.equal((await checkMembership(page, config, '1003', silent)).status, 'unknown');
  } finally {
    await context.close();
    server.close();
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});
