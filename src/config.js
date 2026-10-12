// Đọc và kiểm tra config.json. File này nằm ở thư mục gốc của dự án.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const CONFIG_PATH = path.join(ROOT_DIR, 'config.json');

const DEFAULTS = {
  timezone: 'Asia/Ho_Chi_Minh',
  intervalMinutes: 60,
  finalRunLeadMinutes: 15,
  rules: { requiredTags: 5, countSelfTag: false, includeReplies: false },
  browser: { headless: false, profileDir: './data/profile', locale: 'vi-VN' },
  limits: {
    maxExpandClicks: 400,
    expandReplies: true,
    maxMemberChecksPerRun: 60,
    memberCacheHours: 24,
    minDelayMs: 1500,
    maxDelayMs: 4000,
    minCommentRatio: 0.8,
  },
  memberCheck: 'auto',
  debug: { dumpGraphql: false },
  ui: { port: 4321, openBrowser: true, publicUrl: '', googleClientId: '', allowedEmails: [] },
};

export function loadConfig({ requirePost = true } = {}) {
  const file = CONFIG_PATH;
  if (!fs.existsSync(file)) {
    throw new Error(
      'Chưa có file config.json. Hãy copy config.example.json thành config.json rồi điền thông tin.',
    );
  }
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    throw new Error(`config.json không đúng định dạng JSON: ${err.message}`);
  }

  const config = {
    ...DEFAULTS,
    ...raw,
    rules: { ...DEFAULTS.rules, ...(raw.rules || {}) },
    browser: { ...DEFAULTS.browser, ...(raw.browser || {}) },
    limits: { ...DEFAULTS.limits, ...(raw.limits || {}) },
    debug: { ...DEFAULTS.debug, ...(raw.debug || {}) },
    ui: { ...DEFAULTS.ui, ...(raw.ui || {}) },
  };

  const problems = [];
  if (requirePost && !/^https?:\/\/(www\.|m\.|web\.)?facebook\.com\//i.test(config.postUrl || '')) {
    problems.push('postUrl phải là link bài viết Facebook (bắt đầu bằng https://www.facebook.com/).');
  }
  if (!/facebook\.com\/groups\//i.test(config.groupUrl || '')) {
    problems.push('groupUrl phải là link group dạng https://www.facebook.com/groups/<id>.');
  }
  if (!config.sheetId || !/^[A-Za-z0-9_-]{20,}$/.test(config.sheetId)) {
    problems.push('sheetId phải là ID của Google Sheet (chuỗi giữa /d/ và /edit trong link).');
  }
  if (!config.serviceAccountFile) {
    problems.push('serviceAccountFile phải trỏ tới file JSON của Google Service Account.');
  }
  if (Number.isNaN(Date.parse(config.freezeAt || ''))) {
    problems.push('freezeAt phải là ngày giờ hợp lệ, ví dụ 2026-10-21T00:00:00+07:00.');
  }
  if (!(config.finalRunLeadMinutes >= 0)) {
    problems.push('finalRunLeadMinutes phải là số phút >= 0 (0 để tắt lần chạy chốt cuối).');
  }
  if (!(config.limits.minCommentRatio >= 0 && config.limits.minCommentRatio <= 1)) {
    problems.push('limits.minCommentRatio phải nằm trong khoảng 0 đến 1 (0 để tắt kiểm tra tụt bình luận).');
  }
  if (config.ui.publicUrl) {
    let url = null;
    try {
      url = new URL(config.ui.publicUrl);
    } catch {
      // Báo lỗi bên dưới.
    }
    if (!url || url.protocol !== 'https:' || url.pathname !== '/') {
      problems.push('ui.publicUrl phải là địa chỉ https không kèm đường dẫn, ví dụ https://minigame.drnatro.net');
    }
    // Giao diện có quyền chạy quét và sửa Google Sheet: không cho mở ra Internet nếu thiếu đăng nhập Google.
    if (!/\.apps\.googleusercontent\.com$/.test(config.ui.googleClientId || '')) {
      problems.push('Khi đặt ui.publicUrl phải điền ui.googleClientId (Client ID dạng ...apps.googleusercontent.com) để bật đăng nhập bằng Google.');
    }
  }
  if (!Array.isArray(config.ui.allowedEmails)) {
    problems.push('ui.allowedEmails phải là danh sách Gmail, ví dụ ["ten@gmail.com"].');
  }
  if (!(config.rules.requiredTags >= 1)) {
    problems.push('rules.requiredTags phải là số >= 1.');
  }
  if (problems.length) {
    throw new Error('config.json có lỗi:\n- ' + problems.join('\n- '));
  }

  config.serviceAccountPath = path.resolve(ROOT_DIR, config.serviceAccountFile);
  config.profilePath = path.resolve(ROOT_DIR, config.browser.profileDir);
  config.freezeDate = new Date(config.freezeAt);
  // Lần chạy chốt cuối: bắt đầu trước mốc chốt một khoảng để đọc xong số liệu sát giờ chốt.
  config.finalRunDate = new Date(config.freezeDate.getTime() - config.finalRunLeadMinutes * 60_000);
  return config;
}
