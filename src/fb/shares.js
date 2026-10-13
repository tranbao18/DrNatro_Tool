// Mở hộp thoại "Người đã chia sẻ bài viết" và gom danh sách người chia sẻ.
import path from 'node:path';
import { attachGraphqlCollector, extractShareActors } from './graphql.js';
import { sleep, parseCompactNumber } from '../util.js';
import { debugScreenshot } from './debug.js';
import { postScope, closeExtraDialogs } from './dialogs.js';

const SHARE_COUNT = /^\s*\d[\d.,]*\s*(lượt chia sẻ|chia sẻ|shares?)\s*$/i;
const SHARE_HINT = /chia sẻ|share/i;

/** Dòng "N lượt chia sẻ" dưới bài: ưu tiên phần tử có vai trò nút bấm, dự phòng tìm theo chữ. */
async function findShareCount(page, timeout = 2000) {
  for (const locator of [page.getByRole('button', { name: SHARE_COUNT }), page.getByText(SHARE_COUNT)]) {
    const first = locator.first();
    if (await first.isVisible({ timeout }).catch(() => false)) return first;
  }
  return null;
}

/**
 * Facebook chỉ dựng phần dưới của bài (ảnh, sự kiện, dòng "N bình luận · N lượt chia sẻ") khi người xem cuộn
 * tới đó. Từ đầu bài cuộn dần xuống từng đoạn như người thật, mỗi đoạn kiểm tra một lần.
 */
async function scrollDownToShareCount(page, steps = 16) {
  // Mỗi bước kiểm tra cả kiểu cũ ("N lượt chia sẻ" bấm được) và thanh gọn (số nằm trong nút Share): Facebook gỡ
  // thanh này khỏi trang khi đã cuộn qua, nên phải đọc ngay lúc nó đang hiện.
  for (let i = 0; i < steps; i += 1) {
    const button = await findShareCount(page, 300);
    if (button) return { button, total: null };
    const total = await compactShareCount(page);
    if (total !== null) return { button: null, total };
    await page.mouse.wheel(0, 450);
    await sleep(700);
  }
  return { button: await findShareCount(page, 1000), total: null };
}

/**
 * Thanh gọn "👍 N · 💬 N · ↗ N" (Facebook cho một số trình duyệt): con số lượt chia sẻ nằm trong chính nút
 * Share (bấm vào là mở khung đăng chia sẻ), không có chỗ mở danh sách người chia sẻ. Trả về số lượt chia sẻ hoặc null.
 */
async function compactShareCount(page) {
  const scope = await postScope(page);
  const buttons = scope.locator('[role="button"][aria-label="Share"], [role="button"][aria-label="Chia sẻ"]');
  const texts = await buttons.evaluateAll((els) => els.map((el) => (el.innerText || '').trim())).catch(() => []);
  for (const t of texts) {
    const n = parseCompactNumber(t);
    if (n !== null) return n;
  }
  return null;
}

/**
 * Sau khi tải hết bình luận, trang (hoặc hộp thoại bài viết) đang cuộn tận cuối và Facebook có thể đã bỏ
 * phần chân bài ("N lượt chia sẻ") khỏi trang. Cuộn về đầu bài trước khi tìm.
 */
async function scrollToPostTop(page) {
  const scope = await postScope(page);
  const box = scope === page ? null : await scope.boundingBox().catch(() => null);
  const viewport = page.viewportSize() || { width: 1280, height: 900 };
  if (box) await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  else await page.mouse.move(viewport.width / 2, viewport.height / 2);
  for (let i = 0; i < 20; i += 1) {
    await page.mouse.wheel(0, -4000);
    await sleep(150);
  }
  await sleep(1500);
}

/**
 * Facebook chỉ hiển thị phần chân bài ("N bình luận · N lượt chia sẻ") khi nó lọt vào khung nhìn. Bài dài thì
 * cuộn về đầu vẫn chưa thấy: cuộn tới nút "Bình luận" trên thanh Thích/Bình luận/Chia sẻ của bài (ngay dưới
 * dòng số lượt chia sẻ). Trả về chữ của khu vực chân bài để ghi nhật ký khi vẫn không tìm thấy.
 */
async function scrollToPostFooter(page) {
  const scope = await postScope(page);
  const action = scope.getByRole('button', { name: /^(bình luận|comment)$/i }).first();
  if (!(await action.count())) return '';
  await action.scrollIntoViewIfNeeded({ timeout: 3000 }).catch(() => {});
  await page.mouse.wheel(0, -250).catch(() => {});
  await sleep(1500);
  return action
    .evaluate((el) => {
      let n = el;
      for (let i = 0; i < 6 && n.parentElement; i += 1) n = n.parentElement;
      return (n.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 200);
    })
    .catch(() => '');
}

/** Các chữ và nhãn ẩn (aria-label) có "chia sẻ", ghi vào nhật ký để chẩn đoán khi Facebook đổi giao diện. */
async function shareHints(page) {
  const texts = await page
    .getByText(SHARE_HINT)
    .evaluateAll((els) =>
      els.slice(0, 12).map((el) => {
        const text = (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 50);
        const role = el.closest('[role]')?.getAttribute('role') || el.tagName.toLowerCase();
        return `${role}: "${text}"`;
      }),
    )
    .catch(() => []);
  const labels = await page
    .locator('[aria-label]')
    .evaluateAll((els) =>
      [...new Set(els.map((el) => el.getAttribute('aria-label') || ''))]
        .filter((l) => /chia sẻ|share/i.test(l))
        .slice(0, 12)
        .map((l) => `aria-label: "${l.slice(0, 50)}"`),
    )
    .catch(() => []);
  return texts.concat(labels);
}

export async function collectShares(page, config, logger, { rootDir }) {
  const dumpDir = config.debug.dumpGraphql ? path.join(rootDir, 'data', 'debug', 'shares') : undefined;
  const collector = attachGraphqlCollector(page, { dumpDir, logger });
  const result = { found: false, sharers: new Map(), note: '', shareTotal: null };
  try {
    // Hộp phụ lỡ mở trong lúc đọc bình luận (danh sách cảm xúc...) che mất bài: đóng trước khi tìm.
    await closeExtraDialogs(page, 1);
    await scrollToPostTop(page);
    const scanned = await scrollDownToShareCount(page);
    let button = scanned.button;
    let footer = '';
    if (!button && scanned.total === null) {
      footer = await scrollToPostFooter(page);
      button = await findShareCount(page);
    }
    if (!button) {
      const total = scanned.total ?? (await compactShareCount(page));
      if (total !== null) {
        result.shareTotal = total;
        result.note =
          config.shareCheck === 'auto'
            ? `Facebook hiển thị thanh gọn nên không mở được danh sách người chia sẻ (bài có ${total} lượt chia sẻ). Tool kiểm tra share trên trang cá nhân của từng người; ai không xem được thì kiểm tra tay.`
            : `Facebook hiển thị thanh gọn nên không mở được danh sách người chia sẻ (bài có ${total} lượt chia sẻ): kiểm tra share bằng tay.`;
        logger.warn(result.note);
        return result;
      }
      result.note = 'Không tìm thấy nút số lượt chia sẻ trên bài viết (có thể chưa ai chia sẻ).';
      logger.warn(result.note);
      if (footer) logger.warn(`Chẩn đoán: chữ ở khu vực chân bài: "${footer}"`);
      const hints = await shareHints(page);
      if (hints.length) logger.warn(`Chẩn đoán: các chữ có "chia sẻ" đang hiện trên trang: ${hints.join(' | ')}`);
      await debugScreenshot(page, rootDir, 'khong-thay-luot-chia-se', logger);
      return result;
    }
    // Bài viết có thể đang mở sẵn trong một hộp thoại: phải chờ hộp thoại MỚI (danh sách người chia sẻ) hiện ra,
    // không được lấy nhầm hộp thoại bài viết.
    const dialogs = page.locator('div[role="dialog"]').filter({ visible: true });
    const before = await dialogs.count();
    const started = Date.now();
    await button.click();
    let opened = false;
    for (let i = 0; i < 20 && !opened; i += 1) {
      await sleep(500);
      opened = (await dialogs.count()) > before;
    }
    if (!opened) {
      result.note = 'Đã bấm số lượt chia sẻ nhưng hộp thoại người chia sẻ không mở được.';
      logger.warn(result.note);
      return result;
    }
    const dialog = dialogs.last();
    await sleep(1500);
    result.found = true;

    // Cuộn hộp thoại tới khi không tải thêm.
    let lastCount = -1;
    let stable = 0;
    for (let i = 0; i < 150 && stable < 4; i += 1) {
      const box = await dialog.boundingBox().catch(() => null);
      if (box) await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await page.mouse.wheel(0, 2000);
      await sleep(1500);
      const count = collector.since(started).length;
      if (count === lastCount) stable += 1;
      else stable = 0;
      lastCount = count;
    }

    for (const p of collector.since(started)) {
      for (const actor of extractShareActors(p.data)) result.sharers.set(actor.id, actor);
    }

    // Dự phòng: đọc link trong hộp thoại nếu GraphQL không cho ID.
    if (result.sharers.size === 0) {
      const links = await dialog.locator('a[href]').evaluateAll((els) =>
        els.map((a) => ({ href: a.getAttribute('href') || '', text: (a.textContent || '').trim() })),
      );
      for (const { href, text } of links) {
        const m = href.match(/profile\.php\?id=(\d+)/) || href.match(/\/groups\/[^/]+\/user\/(\d+)/);
        if (m) result.sharers.set(m[1], { id: m[1], name: text, url: href, privacy: '', isPublic: undefined });
      }
      if (result.sharers.size) result.note = 'Danh sách share lấy từ giao diện (dự phòng).';
    }
    await page.keyboard.press('Escape').catch(() => {});
    logger.info(`Danh sách chia sẻ: ${result.sharers.size} người.`);
    return result;
  } catch (err) {
    result.note = `Lỗi khi đọc danh sách chia sẻ: ${err.message}`;
    logger.warn(result.note);
    return result;
  } finally {
    collector.stop();
  }
}
