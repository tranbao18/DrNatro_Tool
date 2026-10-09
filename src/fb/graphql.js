// Bắt và phân tích dữ liệu GraphQL mà trang Facebook tải về.
//
// Thay vì đọc giao diện (dễ đổi, phụ thuộc ngôn ngữ), tool lắng nghe các phản hồi
// /api/graphql/ và dữ liệu JSON nhúng trong HTML, rồi quét sâu để tìm các node
// bình luận ("Comment") và bài chia sẻ ("Story"). Cách này cho ID user chính xác.
import fs from 'node:fs';
import path from 'node:path';
import { firstNumber, profileUrlFor } from '../util.js';

const MAX_DEPTH = 60;

/** Tách chuỗi có nhiều JSON (mỗi dòng một JSON) thành mảng object. */
export function parseMultiJson(text) {
  const out = [];
  if (!text) return out;
  const trimmed = text.trim();
  if (!trimmed) return out;
  try {
    out.push(JSON.parse(trimmed));
    return out;
  } catch {
    // Facebook thường trả về nhiều JSON nối nhau bằng xuống dòng.
  }
  for (const line of trimmed.split(/\r?\n/)) {
    const l = line.trim();
    if (!l.startsWith('{') && !l.startsWith('[')) continue;
    try {
      out.push(JSON.parse(l));
    } catch {
      // Bỏ qua dòng hỏng.
    }
  }
  return out;
}

/** Lấy các khối <script type="application/json"> nhúng trong HTML. */
export function extractEmbeddedJson(html) {
  const out = [];
  if (!html) return out;
  const re = /<script[^>]*type="application\/json"[^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    const body = m[1].trim();
    if (!body.startsWith('{') && !body.startsWith('[')) continue;
    try {
      out.push(JSON.parse(body));
    } catch {
      // Khối không phải JSON thuần.
    }
  }
  return out;
}

/** Duyệt sâu mọi object trong cây JSON. visitor trả về false để không đi sâu hơn. */
export function walk(root, visitor) {
  const stack = [[root, 0]];
  while (stack.length) {
    const [node, depth] = stack.pop();
    if (!node || typeof node !== 'object' || depth > MAX_DEPTH) continue;
    if (Array.isArray(node)) {
      // Đẩy ngược để duyệt theo đúng thứ tự xuất hiện trong tài liệu.
      for (let i = node.length - 1; i >= 0; i -= 1) stack.push([node[i], depth + 1]);
      continue;
    }
    const goDeeper = visitor(node);
    if (goDeeper === false) continue;
    const keys = Object.keys(node);
    for (let i = keys.length - 1; i >= 0; i -= 1) stack.push([node[keys[i]], depth + 1]);
  }
}

function isCommentNode(node) {
  if (node.__typename !== 'Comment') return false;
  if (!node.author || typeof node.author !== 'object') return false;
  return 'body' in node || 'preferred_body' in node || 'feedback' in node;
}

function decodeCommentId(node) {
  if (node.legacy_fbid) return String(node.legacy_fbid);
  if (node.legacy_token) return String(node.legacy_token);
  if (typeof node.id === 'string') {
    try {
      const decoded = Buffer.from(node.id, 'base64').toString('utf8');
      // Dạng "comment:<post>_<comment>"
      const m = decoded.match(/comment:(?:\d+_)?(\d+)/);
      if (m) return m[1];
    } catch {
      // Không phải base64.
    }
    return node.id;
  }
  return undefined;
}

function sumTopReactions(top) {
  const edges = top?.edges;
  if (!Array.isArray(edges) || !edges.length) return undefined;
  let total = 0;
  let found = false;
  for (const e of edges) {
    const n = firstNumber(e?.reaction_count, e?.node?.reaction_count, e?.count);
    if (n !== undefined) {
      total += n;
      found = true;
    }
  }
  return found ? total : undefined;
}

function readLikes(node) {
  const f = node.feedback || {};
  return firstNumber(
    f.reactors?.count,
    f.reaction_count?.count,
    f.reactors?.count_reduced,
    f.reaction_count?.count_reduced,
    f.likers?.count,
    sumTopReactions(f.top_reactions),
    f.i18n_reaction_count,
    node.reaction_count,
    node.like_count,
  );
}

function readReplies(node) {
  const f = node.feedback || {};
  const summary = f.comments_count_summary_renderer?.feedback || {};
  return firstNumber(
    f.replies_fields?.total_count,
    f.total_comment_count,
    f.comment_count?.total_count,
    f.comment_rendering_instance?.comments?.total_count,
    summary.comment_rendering_instance?.comments?.total_count,
    summary.total_comment_count,
    summary.comment_count?.total_count,
    f.replies_connection?.count,
    f.comments?.total_count,
    node.reply_count,
    node.replies_count,
  );
}

function readMentions(node, authorId) {
  const ranges = []
    .concat(node.body?.ranges || [])
    .concat(node.preferred_body?.ranges || [])
    .concat(node.body_renderer?.ranges || []);
  const users = new Map();
  for (const r of ranges) {
    const entity = r?.entity;
    if (!entity || typeof entity !== 'object') continue;
    const type = entity.__typename;
    if (type !== 'User') continue;
    const id = entity.id ? String(entity.id) : null;
    if (!id) continue;
    users.set(id, { id, name: entity.name, url: entity.url });
  }
  return { taggedUsers: [...users.values()], taggedSelf: authorId ? users.has(authorId) : false };
}

function isTopLevel(node) {
  if (typeof node.depth === 'number') return node.depth === 0;
  if (node.comment_parent || node.comment_direct_parent || node.parent_comment) return false;
  if (node.parent_feedback && node.parent_feedback !== null && typeof node.parent_feedback === 'object') {
    // Bình luận trả lời có parent_feedback trỏ về bình luận cha.
    return !node.parent_feedback.id;
  }
  return true;
}

function parentId(node) {
  const p = node.comment_parent || node.comment_direct_parent || node.parent_comment;
  if (p && typeof p === 'object') return decodeCommentId(p);
  return undefined;
}

/** Chuẩn hoá một node Comment thành object gọn, dễ dùng. */
export function normalizeComment(node) {
  const author = node.author || {};
  const authorType = author.__typename || 'User';
  const authorId = author.id ? String(author.id) : null;
  const text = node.body?.text ?? node.preferred_body?.text ?? '';
  const createdTime = firstNumber(node.created_time, node.timestamp);
  const { taggedUsers, taggedSelf } = readMentions(node, authorId);
  const commentId = decodeCommentId(node);
  return {
    id: commentId,
    graphId: node.id,
    author: {
      id: authorId,
      type: authorType,
      name: author.name || '',
      url: author.url || (authorId ? profileUrlFor(authorId) : ''),
      anonymous: authorType !== 'User' || !authorId,
    },
    text: String(text || ''),
    taggedUsers,
    taggedSelf,
    likes: readLikes(node),
    replies: readReplies(node),
    createdAt: createdTime ? new Date(createdTime * 1000) : null,
    isTopLevel: isTopLevel(node),
    parentId: parentId(node),
    url: typeof node.url === 'string' ? node.url : undefined,
    isPostAuthor: node.is_author_original_poster === true,
  };
}

/** Tìm mọi node Comment trong một payload. */
export function extractComments(payload) {
  const found = [];
  walk(payload, (node) => {
    if (isCommentNode(node)) {
      found.push(normalizeComment(node));
    }
    return true;
  });
  return found;
}

function readPrivacy(story) {
  const scope = story.privacy_scope || story.privacy || {};
  const desc = scope.description || scope.label || scope.privacy_scope_renderer?.description;
  const icon = scope.icon_image?.name || scope.icon?.name;
  const type = scope.scope_type || scope.privacy_scope_renderer?.scope_type;
  const raw = [desc, icon, type].filter(Boolean).join(' | ');
  if (/public|công khai|everyone|mọi người/i.test(raw)) return { label: 'Công khai', raw, isPublic: true };
  if (raw) return { label: raw, raw, isPublic: false };
  return { label: '', raw: '', isPublic: undefined };
}

/** Tìm người đã chia sẻ bài viết trong payload của hộp thoại "Người đã chia sẻ". */
export function extractShareActors(payload) {
  const actors = new Map();
  const add = (user, privacy) => {
    if (!user || user.__typename !== 'User' || !user.id) return;
    const id = String(user.id);
    const existing = actors.get(id);
    const entry = {
      id,
      name: user.name || existing?.name || '',
      url: user.url || existing?.url || profileUrlFor(id),
      privacy: privacy?.label || existing?.privacy || '',
      isPublic: privacy?.isPublic ?? existing?.isPublic,
    };
    actors.set(id, entry);
  };
  walk(payload, (node) => {
    if (node.__typename === 'Story' && Array.isArray(node.actors)) {
      const privacy = readPrivacy(node);
      for (const a of node.actors) add(a, privacy);
    }
    for (const key of Object.keys(node)) {
      if (!/reshar|share/i.test(key)) continue;
      const edges = node[key]?.edges;
      if (!Array.isArray(edges)) continue;
      for (const e of edges) {
        const n = e?.node;
        if (!n) continue;
        if (n.__typename === 'User') add(n);
        else if (n.__typename === 'Story' && Array.isArray(n.actors)) {
          const privacy = readPrivacy(n);
          for (const a of n.actors) add(a, privacy);
        }
      }
    }
    return true;
  });
  return [...actors.values()];
}

function friendlyName(request) {
  try {
    const body = request.postData() || '';
    const m = body.match(/fb_api_req_friendly_name=([^&]+)/);
    if (m) return decodeURIComponent(m[1]);
  } catch {
    // Không đọc được body.
  }
  return '';
}

/**
 * Gắn bộ thu GraphQL vào page. Mọi phản hồi /api/graphql/ được parse và đưa vào
 * collector.payloads = [{ name, time, data }]. Dùng collector.since(t) để lấy
 * các payload nhận sau mốc thời gian t.
 */
export function attachGraphqlCollector(page, { dumpDir, logger } = {}) {
  const payloads = [];
  let counter = 0;
  if (dumpDir) fs.mkdirSync(dumpDir, { recursive: true });

  const handler = async (response) => {
    try {
      const url = response.url();
      if (!/\/api\/graphql\/?/.test(url)) return;
      const request = response.request();
      if (request.method() !== 'POST') return;
      const text = await response.text();
      const name = friendlyName(request);
      const time = Date.now();
      const docs = parseMultiJson(text);
      for (const data of docs) payloads.push({ name, time, data });
      if (dumpDir) {
        counter += 1;
        const file = path.join(dumpDir, `${String(counter).padStart(4, '0')}_${name || 'graphql'}.json`);
        fs.writeFileSync(file, text);
      }
    } catch (err) {
      logger?.debug?.('Không đọc được phản hồi GraphQL', { message: err.message });
    }
  };
  page.on('response', handler);

  return {
    payloads,
    since(time) {
      return payloads.filter((p) => p.time >= time);
    },
    stop() {
      page.off('response', handler);
    },
  };
}
