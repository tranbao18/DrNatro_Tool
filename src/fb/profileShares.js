// Kiểm tra điều kiện "share bài viết ở chế độ Công khai" bằng trang cá nhân công khai của người tham gia.
// Facebook có giao diện (thanh gọn) không mở được danh sách người chia sẻ, nên tool mở tường cá nhân của từng người
// và tìm trong dữ liệu trang (JSON nhúng + GraphQL) một bài do chính họ đăng có attached_story là bài minigame.
// ID của attached_story giải mã base64 có dạng "S:_I<tác giả gốc>:VK:<mã bài>" hoặc "S:_I<tác giả>:<mã bài>:<mã bài>".
// Tài khoản của tool không kết bạn với người tham gia, nên thấy được bài share thường nghĩa là bài đó công khai;
// chế độ riêng tư vẫn được đọc thêm (privacy_scope của chính bài share, bỏ qua phần bài gốc) để chắc chắn.
import { walk, extractEmbeddedJson, attachGraphqlCollector } from './graphql.js';
import { looksLoggedOut } from '../browser.js';
import { randomDelay, sleep } from '../util.js';

/** Mã số bài viết trong link: .../permalink/<id>, .../posts/<id>, story_fbid=<id>, fbid=<id>. */
export function postIdFromUrl(url) {
  const m = String(url || '').match(/(?:permalink|posts)\/(\d+)|[?&](?:story_fbid|fbid)=(\d+)/);
  return m ? m[1] || m[2] : null;
}

function decodeStoryId(id) {
  try {
    return Buffer.from(String(id || ''), 'base64').toString('utf8');
  } catch {
    return '';
  }
}

/**
 * Chế độ riêng tư của chính bài share. Bài gốc trong group xuất hiện lặp lại ở nhiều chỗ bên trong bài share, kèm
 * chế độ "Nhóm công khai" của group: bỏ qua nhãn có chữ Nhóm/Group, chỉ lấy nhãn của bài trên trang cá nhân
 * (Công khai, Bạn bè, Chỉ mình tôi, Tùy chỉnh...). Không đọc được thì trả về null.
 */
function sharePrivacy(story) {
  let found = null;
  walk(story, (node) => {
    if (found || node === story.attached_story) return false;
    const scope = node.privacy_scope;
    if (scope && typeof scope === 'object') {
      const label = String(scope.description || scope.label || '').trim();
      if (label && !/nhóm|group/i.test(label)) {
        found = { label, isPublic: /^(công khai|public)$/i.test(label) };
        return false;
      }
    }
    return true;
  });
  return found;
}

/**
 * Tìm trong các tài liệu JSON một bài do `uid` đăng, chia sẻ bài `postId`.
 * @returns {{ privacy: { label: string, isPublic: boolean } | null } | null}
 */
export function findPostShare(docs, { uid, postId }) {
  let hit = null;
  for (const doc of docs) {
    walk(doc, (node) => {
      if (hit) return false;
      if (node.__typename !== 'Story' || !node.attached_story || typeof node.attached_story !== 'object') return true;
      const parts = decodeStoryId(node.attached_story.id).split(':');
      const actorId = String((node.actors || [])[0]?.id || '');
      if (parts.includes(String(postId)) && actorId === String(uid)) {
        hit = { privacy: sharePrivacy(node) };
        return false;
      }
      return true;
    });
    if (hit) break;
  }
  return hit;
}

const UNAVAILABLE_RE = /(nội dung này hiện không hiển thị|this content isn't available|trang này không khả dụng|page isn't available|bạn hiện không xem được nội dung này)/i;

/**
 * Mở trang cá nhân công khai của `uid` và tìm bài share bài minigame.
 * @returns {Promise<{ status: 'shared'|'shared_private'|'not_found'|'unknown', privacy: string, evidence: string }>}
 */
export async function checkProfileShare(page, config, uid, postId, logger) {
  const collector = attachGraphqlCollector(page, { logger });
  try {
    await page.goto(`https://www.facebook.com/profile.php?id=${uid}`, { waitUntil: 'domcontentloaded', timeout: 45_000 });
    await sleep(3500);
    if (looksLoggedOut(page.url())) throw new Error('Facebook yêu cầu đăng nhập lại khi kiểm tra share.');
    const bodyText = await page.locator('body').innerText({ timeout: 10_000 }).catch(() => '');
    if (UNAVAILABLE_RE.test(bodyText)) return { status: 'unknown', privacy: '', evidence: 'không xem được trang cá nhân' };

    // Các bài đầu tường nằm sẵn trong HTML (JSON nhúng); bài cũ hơn tải thêm qua GraphQL khi cuộn.
    const embedded = extractEmbeddedJson(await page.content());
    const steps = config.limits.shareScrollSteps;
    for (let step = 0; step <= steps; step += 1) {
      const hit = findPostShare(embedded.concat(collector.payloads.map((p) => p.data)), { uid, postId });
      if (hit) {
        const label = hit.privacy?.label || '';
        // Không đọc được chế độ: tài khoản tool (không phải bạn bè) vẫn thấy bài, coi như công khai.
        const isPublic = hit.privacy ? hit.privacy.isPublic : true;
        return { status: isPublic ? 'shared' : 'shared_private', privacy: label || 'Công khai', evidence: `bước cuộn ${step}` };
      }
      if (step < steps) {
        await page.mouse.wheel(0, 2500);
        await sleep(1500);
      }
    }
    return { status: 'not_found', privacy: '', evidence: `không thấy sau ${steps} bước cuộn` };
  } catch (err) {
    if (/đăng nhập/.test(err.message)) throw err;
    logger.warn(`Không kiểm tra được share của ${uid}: ${err.message}`);
    return { status: 'unknown', privacy: '', evidence: `error:${err.message}` };
  } finally {
    collector.stop();
    await randomDelay(config.limits.minDelayMs, config.limits.maxDelayMs);
  }
}

/** Trạng thái share từ cache nếu còn hạn: đã thấy share thì giữ luôn; chưa thấy / không rõ thì kiểm tra lại sau cacheHours. */
export function cachedShareStatus(state, uid, postId, cacheHours, now = Date.now()) {
  const entry = state.profileShares?.[uid];
  if (!entry || entry.postId !== String(postId) || !entry.checkedAt) return undefined;
  if (entry.status === 'shared') return entry;
  const ageHours = (now - new Date(entry.checkedAt).getTime()) / 36e5;
  return ageHours <= cacheHours ? entry : undefined;
}
