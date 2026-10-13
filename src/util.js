// Tiện ích dùng chung: thời gian, độ trễ, chuỗi.

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function randomInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

/** Ngủ một khoảng ngẫu nhiên trong [minMs, maxMs] để thao tác giống người thật. */
export function randomDelay(minMs, maxMs) {
  return sleep(randomInt(minMs, maxMs));
}

/** Định dạng ngày giờ theo múi giờ, ví dụ "04/10/2026 15:30:12". */
export function formatDateTime(date, timeZone) {
  const parts = new Intl.DateTimeFormat('vi-VN', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(date);
  const get = (type) => parts.find((p) => p.type === type)?.value ?? '';
  return `${get('day')}/${get('month')}/${get('year')} ${get('hour')}:${get('minute')}:${get('second')}`;
}

/** Khoá ngày dạng "YYYY-MM-DD" theo múi giờ. */
export function dateKey(date, timeZone) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const get = (type) => parts.find((p) => p.type === type)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

export function toInt(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.trunc(value);
  if (typeof value === 'string') {
    const cleaned = value.replace(/[^\d]/g, '');
    if (cleaned) return parseInt(cleaned, 10);
  }
  return undefined;
}

/** Trả về giá trị số hữu hạn đầu tiên trong danh sách ứng viên. */
export function firstNumber(...candidates) {
  for (const c of candidates) {
    const n = toInt(c);
    if (n !== undefined) return n;
  }
  return undefined;
}

export function truncate(text, max = 500) {
  if (!text) return '';
  const s = String(text).replace(/\s+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/** Lấy group ID từ link group, ví dụ https://www.facebook.com/groups/123/ -> "123". */
export function parseGroupId(groupUrl) {
  const m = String(groupUrl).match(/facebook\.com\/groups\/([^/?#]+)/i);
  return m ? m[1] : null;
}

export function profileUrlFor(userId) {
  return `https://www.facebook.com/profile.php?id=${userId}`;
}

/** Số dạng gọn của Facebook: "9" -> 9, "1,2K" / "1,2 N" -> 1200, "1,5 Tr" / "1.5M" -> 1500000. Không đọc được -> null. */
export function parseCompactNumber(text) {
  const m = String(text || '').trim().match(/^(\d+(?:[.,]\d+)?)\s*(K|N|Tr|M)?$/i);
  if (!m) return null;
  const unit = (m[2] || '').toLowerCase();
  const mult = unit === 'k' || unit === 'n' ? 1000 : unit === 'tr' || unit === 'm' ? 1_000_000 : 1;
  // Không có đơn vị thì "1.234" / "1,234" là dấu phân cách hàng nghìn; có đơn vị thì là dấu thập phân.
  const value = mult === 1 ? Number(m[1].replace(/[.,]/g, '')) : Number(m[1].replace(',', '.'));
  return Math.round(value * mult);
}
