// Luật minigame: lọc bình luận hợp lệ và chọn bình luận tốt nhất của mỗi user.
// Toàn bộ hàm ở đây là hàm thuần (không gọi mạng) để dễ kiểm thử.
import { profileUrlFor } from './util.js';

export const STATUS = {
  QUALIFIED: 'ĐỦ ĐIỀU KIỆN',
  PENDING: 'CHỜ DUYỆT',
  REJECTED: 'LOẠI',
};

export const MEMBER_LABEL = {
  member: 'Thành viên',
  not_member: 'Không phải thành viên',
  unknown: 'Chưa xác nhận',
};

export function normalizeManual(value) {
  const v = String(value || '').trim().toLowerCase();
  if (!v) return '';
  if (['ok', 'đạt', 'dat', 'duyệt', 'duyet', 'đủ', 'du', 'yes', 'y', 'v', '✓'].includes(v)) return 'OK';
  if (['loại', 'loai', 'không', 'khong', 'no', 'n', 'x', 'reject', 'fail'].includes(v)) return 'LOẠI';
  return '';
}

/** Số người khác nhau được tag trong một bình luận. */
export function countTags(comment, rules) {
  const ids = new Set();
  for (const u of comment.taggedUsers || []) {
    if (!u?.id) continue;
    if (!rules.countSelfTag && comment.author?.id && u.id === comment.author.id) continue;
    ids.add(u.id);
  }
  return ids.size;
}

export function engagementOf(comment) {
  return (comment.likes ?? 0) + (comment.replies ?? 0);
}

function compareBest(a, b) {
  const diff = engagementOf(b) - engagementOf(a);
  if (diff !== 0) return diff;
  const likeDiff = (b.likes ?? 0) - (a.likes ?? 0);
  if (likeDiff !== 0) return likeDiff;
  const ta = a.createdAt ? a.createdAt.getTime() : Infinity;
  const tb = b.createdAt ? b.createdAt.getTime() : Infinity;
  return ta - tb;
}

/**
 * Gom bình luận theo user và chọn bình luận tốt nhất.
 * @param {Iterable<object>} comments
 * @param {object} rules { requiredTags, countSelfTag, includeReplies }
 * @returns {Map<string, { author, candidates, allComments, best, maxTags }>}
 */
export function groupByUser(comments, rules) {
  const users = new Map();
  for (const c of comments) {
    const uid = c.author?.id;
    if (!uid || c.author.anonymous) continue;
    if (!rules.includeReplies && !c.isTopLevel) continue;
    const tagCount = countTags(c, rules);
    const entry = users.get(uid) || { author: c.author, candidates: [], allComments: [], best: null, maxTags: 0 };
    const withTags = { ...c, tagCount };
    entry.allComments.push(withTags);
    entry.maxTags = Math.max(entry.maxTags, tagCount);
    if (tagCount >= rules.requiredTags) entry.candidates.push(withTags);
    if (!entry.author?.name && c.author?.name) entry.author = c.author;
    users.set(uid, entry);
  }
  for (const entry of users.values()) {
    entry.candidates.sort(compareBest);
    entry.allComments.sort(compareBest);
    entry.best = entry.candidates[0] || null;
  }
  return users;
}

/**
 * Tạo bản ghi cho từng user để ghi vào sheet.
 * @param {object} input
 * @param {Map} input.users kết quả groupByUser
 * @param {Map<string, object>} input.sharers id -> { name, privacy, isPublic }
 * @param {Record<string, string>} input.memberStatus uid -> member|not_member|unknown
 * @param {Record<string, { decision: string, note: string }>} input.manual uid -> duyệt tay
 * @param {boolean} input.sharesAvailable hộp thoại share có đọc được không
 */
export function buildRecords({ users, sharers, memberStatus, manual, sharesAvailable, rules, now = new Date() }) {
  const qualifiedList = [];
  const rejectedList = [];
  for (const [uid, entry] of users) {
    const name = entry.author?.name || '';
    const base = {
      uid,
      name,
      profileUrl: profileUrlFor(uid),
      updatedAt: now,
    };
    const manualEntry = manual?.[uid] || { decision: '', note: '' };
    const manualDecision = normalizeManual(manualEntry.decision);

    if (!entry.best) {
      const top = entry.allComments[0];
      rejectedList.push({
        ...base,
        reason: `Tag ${entry.maxTags}/${rules.requiredTags} người (chưa đủ trong cùng một bình luận)`,
        comment: top,
        tagCount: entry.maxTags,
      });
      continue;
    }

    const best = entry.best;
    const member = memberStatus?.[uid] || 'unknown';
    const share = sharers?.get(uid);
    const shareAuto = share ? (share.isPublic === false ? 'shared_private' : 'shared') : 'not_found';
    const reasons = [];
    let status;
    if (manualDecision === 'LOẠI') {
      status = STATUS.REJECTED;
      reasons.push('Duyệt tay: loại');
    } else if (manualDecision === 'OK') {
      status = STATUS.QUALIFIED;
      reasons.push('Duyệt tay: OK');
    } else if (member === 'not_member') {
      status = STATUS.REJECTED;
      reasons.push('Không phải thành viên group');
    } else if (member === 'member' && shareAuto === 'shared') {
      status = STATUS.QUALIFIED;
    } else {
      status = STATUS.PENDING;
      if (member !== 'member') reasons.push('Thành viên: chưa xác nhận tự động');
      if (shareAuto === 'not_found') {
        reasons.push(sharesAvailable ? 'Share: không thấy trong danh sách chia sẻ công khai' : 'Share: chưa đọc được danh sách chia sẻ');
      } else if (shareAuto === 'shared_private') {
        reasons.push(`Share: có chia sẻ nhưng chế độ "${share.privacy}"`);
      }
    }

    qualifiedList.push({
      ...base,
      status,
      reasons,
      tagCount: best.tagCount,
      memberAuto: member,
      memberLabel: MEMBER_LABEL[member] || MEMBER_LABEL.unknown,
      shareAuto,
      shareLabel:
        shareAuto === 'shared'
          ? 'Đã share công khai'
          : shareAuto === 'shared_private'
            ? `Có share (${share.privacy || 'không rõ chế độ'})`
            : 'Chưa xác nhận',
      manualDecision: manualEntry.decision || '',
      manualNote: manualEntry.note || '',
      likes: best.likes ?? 0,
      replies: best.replies ?? 0,
      engagement: engagementOf(best),
      comment: best,
      candidateCount: entry.candidates.length,
    });
  }

  const order = { [STATUS.QUALIFIED]: 0, [STATUS.PENDING]: 1, [STATUS.REJECTED]: 2 };
  qualifiedList.sort((a, b) => {
    const d = order[a.status] - order[b.status];
    if (d !== 0) return d;
    if (b.engagement !== a.engagement) return b.engagement - a.engagement;
    if (b.likes !== a.likes) return b.likes - a.likes;
    return a.name.localeCompare(b.name, 'vi');
  });
  rejectedList.sort((a, b) => b.tagCount - a.tagCount || a.name.localeCompare(b.name, 'vi'));
  return { records: qualifiedList, rejected: rejectedList };
}

export function summarize(records) {
  const counts = { [STATUS.QUALIFIED]: 0, [STATUS.PENDING]: 0, [STATUS.REJECTED]: 0 };
  for (const r of records) counts[r.status] = (counts[r.status] || 0) + 1;
  return counts;
}
