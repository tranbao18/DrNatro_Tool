// Mở hộp thoại "Người đã chia sẻ bài viết" và gom danh sách người chia sẻ.
import path from 'node:path';
import { attachGraphqlCollector, extractShareActors } from './graphql.js';
import { sleep } from '../util.js';

const SHARE_COUNT = /^\s*\d[\d.,]*\s*(lượt chia sẻ|chia sẻ|shares?)\s*$/i;

export async function collectShares(page, config, logger, { rootDir }) {
  const dumpDir = config.debug.dumpGraphql ? path.join(rootDir, 'data', 'debug', 'shares') : undefined;
  const collector = attachGraphqlCollector(page, { dumpDir, logger });
  const result = { found: false, sharers: new Map(), note: '' };
  try {
    const button = page.getByRole('button', { name: SHARE_COUNT }).first();
    if (!(await button.isVisible({ timeout: 4000 }).catch(() => false))) {
      result.note = 'Không tìm thấy nút số lượt chia sẻ trên bài viết (có thể chưa ai chia sẻ).';
      logger.warn(result.note);
      return result;
    }
    const started = Date.now();
    await button.click();
    await sleep(3000);
    const dialog = page.locator('div[role="dialog"]').last();
    if (!(await dialog.isVisible({ timeout: 5000 }).catch(() => false))) {
      result.note = 'Hộp thoại người chia sẻ không mở được.';
      logger.warn(result.note);
      return result;
    }
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
