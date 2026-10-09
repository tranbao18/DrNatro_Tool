// Kiểm tra một user có phải thành viên group hay không.
// Cách làm: tài khoản admin mở trang hồ sơ thành viên trong group
//   https://www.facebook.com/groups/<group>/user/<uid>/
// Thành viên: trang hiện thông tin tham gia nhóm. Không phải thành viên: Facebook báo
// nội dung không khả dụng. Trường hợp không rõ sẽ trả về "unknown" để duyệt tay.
import { looksLoggedOut } from '../browser.js';
import { randomDelay, sleep } from '../util.js';

const MEMBER_RE =
  /(đã tham gia|tham gia nhóm vào|tham gia vào|joined (on|the group|group|in)|joined \w+ \d{1,2},? \d{4}|joined \d{4}|member since|thành viên từ|thành viên kể từ|hoạt động trong nhóm|activity in (the |this )?group|bài viết trong nhóm|group activity|giới thiệu về .{1,80} trong nhóm|about .{1,80} in (this|the) group|quản trị viên nhóm|group admin|người kiểm duyệt nhóm|group moderator)/i;

// "không khả dụng" chỉ tính khi đi kèm "nội dung/trang/liên kết", vì chữ này hay xuất hiện
// trong bài viết của chính thành viên (ví dụ "sản phẩm tạm thời không khả dụng").
const NOT_AVAILABLE_RE =
  /(nội dung này hiện không hiển thị|this content isn't available|content isn't available right now|(nội dung|trang|liên kết)( này)?( hiện)?( đang)? không khả dụng|hiện không xem được|trang này không tồn tại|page isn't available|page not found|không tìm thấy trang|không phải là thành viên|is not a member|không còn là thành viên|no longer a member|đã rời nhóm|left the group)/i;

export function classifyMemberPage({ finalUrl, uid, bodyText }) {
  const text = String(bodyText || '');
  const memberMatch = text.match(MEMBER_RE);
  const missingMatch = text.match(NOT_AVAILABLE_RE);
  // Trang vừa có dấu hiệu thành viên vừa có chữ "không khả dụng/rời nhóm": không tự loại, để team duyệt tay.
  if (memberMatch && missingMatch) {
    return { status: 'unknown', evidence: `conflict:${memberMatch[0]} | ${missingMatch[0]}` };
  }
  if (missingMatch) return { status: 'not_member', evidence: missingMatch[0] };
  if (!new RegExp(`/user/${uid}`).test(finalUrl)) {
    return { status: 'unknown', evidence: `redirect:${finalUrl}` };
  }
  if (memberMatch) return { status: 'member', evidence: memberMatch[0] };
  return { status: 'unknown', evidence: 'no-marker' };
}

export async function checkMembership(page, config, uid, logger) {
  const groupUrl = config.groupUrl.replace(/\/+$/, '');
  const url = `${groupUrl}/user/${uid}/`;
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45_000 });
    await sleep(2500);
    if (looksLoggedOut(page.url())) {
      throw new Error('Facebook yêu cầu đăng nhập lại khi kiểm tra thành viên.');
    }
    const bodyText = await page.locator('body').innerText({ timeout: 10_000 }).catch(() => '');
    const result = classifyMemberPage({ finalUrl: page.url(), uid, bodyText });
    logger.debug(`Thành viên ${uid}: ${result.status} (${result.evidence})`);
    await randomDelay(config.limits.minDelayMs, config.limits.maxDelayMs);
    return result;
  } catch (err) {
    if (/đăng nhập/.test(err.message)) throw err;
    logger.warn(`Không kiểm tra được thành viên ${uid}: ${err.message}`);
    return { status: 'unknown', evidence: `error:${err.message}` };
  }
}

/** Trả về trạng thái từ cache nếu còn hạn, ngược lại undefined. */
export function cachedMemberStatus(state, uid, cacheHours, now = Date.now()) {
  const entry = state.members?.[uid];
  if (!entry || !entry.checkedAt) return undefined;
  const ageHours = (now - new Date(entry.checkedAt).getTime()) / 36e5;
  // Kết quả "unknown" được kiểm tra lại sớm hơn (mỗi 6 giờ) để có cơ hội tự xác nhận.
  const ttl = entry.status === 'unknown' ? Math.min(cacheHours, 6) : cacheHours;
  return ageHours <= ttl ? entry.status : undefined;
}
