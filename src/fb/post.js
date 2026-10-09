// Mở bài viết, chuyển sang "Tất cả bình luận", bấm "Xem thêm" tới khi hết,
// và gom toàn bộ bình luận từ dữ liệu GraphQL.
import path from 'node:path';
import { attachGraphqlCollector, extractComments, extractEmbeddedJson } from './graphql.js';
import { looksLoggedOut } from '../browser.js';
import { randomDelay, sleep } from '../util.js';

// Nút mở rộng bình luận / phản hồi (tiếng Việt và tiếng Anh).
const EXPAND_KEYWORD = /(bình luận|comment|phản hồi|câu trả lời|repl(y|ies))/i;
const EXPAND_PREFIX = /^(xem|view|\d)/i;
const EXPAND_EXCLUDE = /^(viết|write|bình luận$|comment$|trả lời$|reply$|xem thêm$|see more$)/i;
const REPLY_LABEL = /(phản hồi|câu trả lời|repl(y|ies))/i;

const SORT_BUTTON = /^(phù hợp nhất|most relevant|mới nhất|newest|tất cả bình luận|all comments|cũ nhất|oldest)$/i;
const SORT_ALL = /(tất cả bình luận|all comments)/i;

export function isExpandLabel(name) {
  const n = String(name || '').trim();
  if (!n || !EXPAND_PREFIX.test(n) || !EXPAND_KEYWORD.test(n)) return false;
  if (EXPAND_EXCLUDE.test(n)) return false;
  return true;
}

export function isReplyExpandLabel(name) {
  return isExpandLabel(name) && REPLY_LABEL.test(name);
}

async function scrollContainer(page) {
  const dialog = page.locator('div[role="dialog"]').last();
  try {
    if (await dialog.isVisible({ timeout: 500 })) {
      const box = await dialog.boundingBox();
      if (box) await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await page.mouse.wheel(0, 2500);
      return;
    }
  } catch {
    // Không có hộp thoại, cuộn trang chính.
  }
  await page.mouse.wheel(0, 2500);
  await page.keyboard.press('End').catch(() => {});
}

async function switchToAllComments(page, logger) {
  try {
    const sortButton = page.getByRole('button', { name: SORT_BUTTON }).first();
    if (!(await sortButton.isVisible({ timeout: 3000 }))) {
      logger.warn('Không tìm thấy nút sắp xếp bình luận, giữ nguyên thứ tự mặc định.');
      return false;
    }
    const current = (await sortButton.innerText().catch(() => '')).trim();
    if (SORT_ALL.test(current)) return true;
    await sortButton.click();
    await sleep(1200);
    const option = page.getByRole('menuitem', { name: SORT_ALL }).first();
    if (await option.isVisible({ timeout: 3000 }).catch(() => false)) {
      await option.click();
    } else {
      await page.getByText(SORT_ALL).last().click({ timeout: 3000 });
    }
    await sleep(2000);
    logger.info('Đã chuyển sang chế độ "Tất cả bình luận".');
    return true;
  } catch (err) {
    logger.warn(`Không chuyển được sang "Tất cả bình luận": ${err.message}`);
    return false;
  }
}

/** Trả về danh sách nút mở rộng đang hiển thị, ưu tiên nút tải thêm bình luận trước nút phản hồi. */
async function findExpandButtons(page, { expandReplies }) {
  const buttons = page.getByRole('button', { name: EXPAND_KEYWORD });
  const count = await buttons.count();
  const top = [];
  const replies = [];
  for (let i = 0; i < count && i < 80; i += 1) {
    const b = buttons.nth(i);
    let name = '';
    try {
      name = (await b.innerText({ timeout: 500 })).trim();
    } catch {
      continue;
    }
    if (!isExpandLabel(name)) continue;
    if (isReplyExpandLabel(name)) {
      if (expandReplies) replies.push({ locator: b, name });
    } else {
      top.push({ locator: b, name });
    }
  }
  return top.concat(replies);
}

/**
 * Thu thập toàn bộ bình luận của bài viết.
 * @returns {{ comments: Map<string, object>, payloadCount: number }}
 */
export async function collectPostComments(page, config, logger, { rootDir }) {
  const dumpDir = config.debug.dumpGraphql ? path.join(rootDir, 'data', 'debug', 'graphql') : undefined;
  const collector = attachGraphqlCollector(page, { dumpDir, logger });
  const comments = new Map();
  const absorb = (list) => {
    for (const c of list) {
      if (!c.id) continue;
      const prev = comments.get(c.id);
      // Giữ bản có nhiều thông tin nhất (số like/phản hồi đã đọc được).
      if (!prev) comments.set(c.id, c);
      else {
        comments.set(c.id, {
          ...prev,
          ...c,
          likes: c.likes ?? prev.likes,
          replies: c.replies ?? prev.replies,
          taggedUsers: c.taggedUsers.length >= prev.taggedUsers.length ? c.taggedUsers : prev.taggedUsers,
          url: c.url || prev.url,
        });
      }
    }
  };

  logger.info(`Mở bài viết: ${config.postUrl}`);
  await page.goto(config.postUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await sleep(4000);
  if (looksLoggedOut(page.url())) {
    throw new Error('Facebook yêu cầu đăng nhập lại. Chạy "npm run login".');
  }

  // Bình luận đầu tiên thường nằm sẵn trong HTML.
  try {
    const html = await page.content();
    for (const json of extractEmbeddedJson(html)) absorb(extractComments(json));
  } catch (err) {
    logger.warn(`Không đọc được JSON nhúng: ${err.message}`);
  }

  await switchToAllComments(page, logger);

  const { maxExpandClicks, expandReplies, minDelayMs, maxDelayMs } = config.limits;
  let clicks = 0;
  let idleRounds = 0;
  let rounds = 0;
  while (clicks < maxExpandClicks && idleRounds < 3 && rounds < maxExpandClicks * 2) {
    rounds += 1;
    const buttons = await findExpandButtons(page, { expandReplies });
    let clickedThisRound = 0;
    for (const { locator, name } of buttons.slice(0, 6)) {
      if (clicks >= maxExpandClicks) break;
      try {
        await locator.scrollIntoViewIfNeeded({ timeout: 2000 });
        await locator.click({ timeout: 3000 });
        clicks += 1;
        clickedThisRound += 1;
        logger.debug(`Bấm "${name}" (${clicks})`);
        await randomDelay(minDelayMs, maxDelayMs);
      } catch {
        // Nút có thể đã biến mất sau khi tải thêm.
      }
    }
    await scrollContainer(page);
    await sleep(1500);
    for (const p of collector.payloads) absorb(extractComments(p.data));
    idleRounds = clickedThisRound === 0 ? idleRounds + 1 : 0;
    if (rounds % 10 === 0) logger.info(`Đang tải bình luận... đã bấm ${clicks} nút, gom được ${comments.size} bình luận.`);
  }

  // Quét lại toàn bộ payload lần cuối để không sót.
  for (const p of collector.payloads) absorb(extractComments(p.data));
  collector.stop();

  if (clicks >= maxExpandClicks) {
    logger.warn(`Đã chạm giới hạn limits.maxExpandClicks=${maxExpandClicks}, có thể chưa tải hết bình luận.`);
  }
  logger.info(`Thu được ${comments.size} bình luận (bấm ${clicks} nút, ${collector.payloads.length} payload GraphQL).`);
  return { comments, payloadCount: collector.payloads.length };
}
