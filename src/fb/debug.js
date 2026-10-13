// Ảnh chụp màn hình để chẩn đoán khi Facebook hiển thị khác với cách tool đang tìm (lưu ở data/debug, không lên Git).
import fs from 'node:fs';
import path from 'node:path';

export async function debugScreenshot(page, rootDir, name, logger) {
  try {
    const dir = path.join(rootDir, 'data', 'debug');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${new Date().toISOString().replace(/[:.]/g, '-')}-${name}.png`);
    await page.screenshot({ path: file });
    logger.warn(`Đã lưu ảnh chụp màn hình để chẩn đoán: ${path.relative(rootDir, file)}`);
  } catch (err) {
    logger.debug?.(`Không chụp được màn hình chẩn đoán: ${err.message}`);
  }
}
