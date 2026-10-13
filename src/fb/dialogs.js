// Hộp thoại trên trang Facebook: bài viết thường mở dạng hộp thoại; các hộp phụ (danh sách người thả cảm xúc,
// thông báo...) có thể đè lên trên. Mọi thao tác cuộn/tìm phải nhắm vào hộp thoại bài viết, không phải hộp phụ.
import { sleep } from '../util.js';

const visibleDialogs = (page) => page.locator('div[role="dialog"]').filter({ visible: true });

export function countVisibleDialogs(page) {
  return visibleDialogs(page).count();
}

/** Hộp thoại bài viết = hộp thoại đang hiện có diện tích lớn nhất; không có hộp thoại thì dùng cả trang. */
export async function postScope(page) {
  const dialogs = visibleDialogs(page);
  const areas = await dialogs
    .evaluateAll((els) =>
      els.map((el) => {
        const r = el.getBoundingClientRect();
        return r.width * r.height;
      }),
    )
    .catch(() => []);
  if (!areas.length) return page;
  return dialogs.nth(areas.indexOf(Math.max(...areas)));
}

/** Đóng các hộp phụ đè lên bài (Esc đóng hộp trên cùng) cho tới khi chỉ còn `keep` hộp thoại. */
export async function closeExtraDialogs(page, keep) {
  for (let i = 0; i < 3 && (await countVisibleDialogs(page)) > keep; i += 1) {
    await page.keyboard.press('Escape').catch(() => {});
    await sleep(600);
  }
}
