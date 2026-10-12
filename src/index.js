#!/usr/bin/env node
// Điểm vào dòng lệnh.
//   npm run login        : mở trình duyệt để đăng nhập Facebook (một lần)
//   npm start            : chạy quét một lần
//   npm run watch        : chạy lặp lại mỗi intervalMinutes phút
//   npm run check-sheet  : kiểm tra kết nối Google Sheet
//   npm run ui           : mở giao diện quản lý trên trình duyệt
import { exec } from 'node:child_process';
import { loadConfig, ROOT_DIR, CONFIG_PATH } from './config.js';
import { createLogger } from './logger.js';
import { launchBrowser, getLoggedInUserId } from './browser.js';
import { createSheetsClient, TABS } from './sheets.js';
import { runOnce, isFrozen } from './run.js';
import { sleep, formatDateTime } from './util.js';
import { createUiServer } from './ui/server.js';
import { createGoogleVerifier } from './ui/jwt.js';

const command = process.argv[2] || 'help';

async function login(config, logger) {
  const context = await launchBrowser(config, { headless: false });
  const page = context.pages()[0] || (await context.newPage());
  await page.goto('https://www.facebook.com/', { waitUntil: 'domcontentloaded' });
  const existing = await getLoggedInUserId(context);
  if (existing) {
    logger.info(`Trình duyệt đã đăng nhập sẵn tài khoản ID ${existing}. Đóng cửa sổ để kết thúc, hoặc đăng xuất và đăng nhập tài khoản khác.`);
  } else {
    logger.info('Hãy đăng nhập Facebook bằng TÀI KHOẢN PHỤ (admin group) trong cửa sổ vừa mở. Tool sẽ tự nhận khi đăng nhập xong.');
  }
  for (let i = 0; i < 600; i += 1) {
    await sleep(2000);
    if (context.pages().length === 0) break;
    const uid = await getLoggedInUserId(context);
    if (uid && !existing) {
      logger.info(`Đăng nhập thành công, tài khoản ID ${uid}. Phiên đăng nhập đã được lưu trong ${config.profilePath}.`);
      await sleep(3000);
      break;
    }
  }
  await context.close().catch(() => {});
}

async function checkSheet(config, logger) {
  const sheets = createSheetsClient(config.serviceAccountPath);
  const meta = await sheets.getSpreadsheet(config.sheetId);
  logger.info(`Kết nối Google Sheet OK: "${meta.properties.title}" (service account ${sheets.email}).`);
  const tabs = (meta.sheets || []).map((s) => s.properties.title);
  logger.info(`Các tab hiện có: ${tabs.join(', ')}`);
  logger.info(`Khi chạy, tool sẽ tạo/ghi các tab: ${Object.values(TABS).join(', ')}.`);
}

async function watch(config, logger) {
  const intervalMs = Math.max(5, config.intervalMinutes) * 60_000;
  logger.info(`Chế độ watch: chạy mỗi ${config.intervalMinutes} phút. Nhấn Ctrl+C để dừng.`);
  for (;;) {
    try {
      const result = await runOnce(config, logger);
      if (result.frozen) {
        logger.info('Đã chốt kết quả, dừng chế độ watch.');
        return;
      }
    } catch (err) {
      logger.error(`Lỗi trong lần chạy, sẽ thử lại sau: ${err.message}`);
    }
    // Nếu lần chạy chốt cuối rơi vào trước lần chạy định kỳ tiếp theo thì thức dậy đúng giờ đó (cộng 1 giây cho chắc).
    const now = Date.now();
    const finalAt = config.finalRunDate.getTime() + 1000;
    const isFinalNext = now < finalAt && finalAt < now + intervalMs && config.finalRunDate < config.freezeDate;
    const next = new Date(isFinalNext ? finalAt : now + intervalMs);
    logger.info(`Lần chạy tiếp theo lúc ${formatDateTime(next, config.timezone)}${isFinalNext ? ' (lần chạy chốt cuối)' : ''}.`);
    await sleep(next.getTime() - now);
  }
}

function openBrowser(url) {
  const cmd = process.platform === 'win32' ? `start "" "${url}"` : process.platform === 'darwin' ? `open "${url}"` : `xdg-open "${url}"`;
  exec(cmd, () => {});
}

async function ui(config, logger) {
  // --no-open: dùng khi giao diện tự bật cùng Windows, không mở trình duyệt mỗi lần đăng nhập.
  const shouldOpen = config.ui.openBrowser && !process.argv.includes('--no-open');
  const sheets = createSheetsClient(config.serviceAccountPath);
  const verifyGoogle = config.ui.googleClientId ? createGoogleVerifier({ clientId: config.ui.googleClientId }) : null;
  const server = createUiServer({ config, rootDir: ROOT_DIR, configPath: CONFIG_PATH, sheets, logger, verifyGoogle });
  const url = `http://127.0.0.1:${config.ui.port}/`;
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(config.ui.port, '127.0.0.1', resolve);
    });
  } catch (err) {
    if (err.code !== 'EADDRINUSE') throw err;
    logger.warn(`Cổng ${config.ui.port} đang được dùng, có thể giao diện đã mở ở cửa sổ khác: ${url}`);
    if (shouldOpen) openBrowser(url);
    return;
  }
  logger.info(
    process.argv.includes('--no-open')
      ? `Giao diện quản lý (chạy ẩn): ${url}. Khởi động lại bằng scripts\\restart-ui.ps1.`
      : `Giao diện quản lý: ${url} (giữ cửa sổ này mở trong lúc dùng, nhấn Ctrl+C để tắt).`,
  );
  if (config.ui.publicUrl) {
    logger.info(`Team truy cập từ xa: ${config.ui.publicUrl} (qua Cloudflare Tunnel, đăng nhập bằng Google; Gmail mới phải được cho phép trên máy này).`);
  }
  if (shouldOpen) openBrowser(url);
}

function help() {
  console.log(`DrNatro Minigame Tool
Lệnh:
  npm run login        Đăng nhập Facebook (chạy một lần, dùng tài khoản phụ là admin group)
  npm run check-sheet  Kiểm tra kết nối Google Sheet
  npm start            Quét một lần và ghi sheet
  npm run watch        Chạy lặp mỗi intervalMinutes phút (mặc định 60)
  npm run ui           Mở giao diện quản lý trên trình duyệt
  npm test             Chạy kiểm thử logic
`);
}

async function main() {
  if (command === 'help' || command === '--help' || command === '-h') {
    help();
    return;
  }
  const config = loadConfig({ requirePost: command === 'run' || command === 'watch' });
  const logger = createLogger({ rootDir: ROOT_DIR, timeZone: config.timezone });
  switch (command) {
    case 'login':
      await login(config, logger);
      break;
    case 'check-sheet':
      await checkSheet(config, logger);
      break;
    case 'run': {
      if (isFrozen(config)) logger.info('Lưu ý: đã qua mốc chốt, lần chạy này chỉ ghi trạng thái chốt.');
      await runOnce(config, logger);
      break;
    }
    case 'watch':
      await watch(config, logger);
      break;
    case 'ui':
      await ui(config, logger);
      break;
    default:
      help();
      process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(`\nLỖI: ${err.message}`);
  if (process.env.DEBUG) console.error(err.stack);
  process.exitCode = 1;
});
