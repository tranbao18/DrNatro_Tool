// Mở trình duyệt Chromium với hồ sơ (profile) lưu sẵn đăng nhập Facebook.
import fs from 'node:fs';
import { chromium } from 'playwright';

export async function launchBrowser(config, { headless } = {}) {
  fs.mkdirSync(config.profilePath, { recursive: true });
  // Tuỳ chọn: dùng Google Chrome cài sẵn (browser.channel = "chrome") hoặc một file chạy cụ thể.
  const executablePath = process.env.PW_CHROMIUM_PATH || config.browser.executablePath || undefined;
  const channel = executablePath ? undefined : config.browser.channel || undefined;
  const context = await chromium.launchPersistentContext(config.profilePath, {
    headless: headless ?? config.browser.headless,
    executablePath,
    channel,
    locale: config.browser.locale || 'vi-VN',
    timezoneId: config.timezone,
    viewport: { width: 1280, height: 900 },
    args: ['--disable-blink-features=AutomationControlled', '--disable-notifications'],
    ignoreDefaultArgs: ['--enable-automation'],
  });
  context.setDefaultTimeout(30_000);
  return context;
}

/** Trả về ID tài khoản Facebook đang đăng nhập (cookie c_user), hoặc null. */
export async function getLoggedInUserId(context) {
  const cookies = await context.cookies('https://www.facebook.com');
  const c = cookies.find((k) => k.name === 'c_user');
  return c ? c.value : null;
}

export function looksLoggedOut(url) {
  return /facebook\.com\/(login|checkpoint|recover|two_step_verification)/i.test(url);
}

export async function assertLoggedIn(context, page) {
  const uid = await getLoggedInUserId(context);
  if (!uid || (page && looksLoggedOut(page.url()))) {
    throw new Error(
      'Trình duyệt chưa đăng nhập Facebook (hoặc bị checkpoint). Chạy "npm run login" để đăng nhập lại.',
    );
  }
  return uid;
}
