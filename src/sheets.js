// Ghi kết quả vào Google Sheet qua Sheets API v4 bằng Service Account.
import fs from 'node:fs';
import { JWT } from 'google-auth-library';
import { formatDateTime, truncate } from './util.js';
import { STATUS } from './rules.js';

const API = 'https://sheets.googleapis.com/v4/spreadsheets';

export const TABS = {
  MAIN: 'Danh sách',
  REJECTED: 'Bị loại',
  HISTORY: 'Lịch sử',
  SYSTEM: 'Hệ thống',
};

export const MAIN_HEADER = [
  'STT',
  'Tên Facebook',
  'Link trang cá nhân',
  'User ID',
  'Trạng thái',
  'Lý do / ghi chú tự động',
  'Số người tag',
  'Thành viên group (tự động)',
  'Share công khai (tự động)',
  'Duyệt tay (OK / LOẠI)',
  'Ghi chú duyệt',
  'Lượt thích',
  'Lượt trả lời',
  'Tổng tương tác',
  'Cập nhật lúc',
  'Thời gian bình luận',
  'Link bình luận',
  'Nội dung bình luận',
];

export const REJECTED_HEADER = [
  'STT',
  'Tên Facebook',
  'Link trang cá nhân',
  'User ID',
  'Lý do loại',
  'Số người tag nhiều nhất',
  'Cập nhật lúc',
  'Link bình luận',
  'Nội dung bình luận',
];

export const HISTORY_HEADER = ['Ngày', 'User ID', 'Tên Facebook', 'Lượt thích', 'Lượt trả lời', 'Tổng tương tác', 'Cập nhật lúc'];

// Cột cố định trong tab Danh sách (chỉ số từ 0).
export const COL = { UID: 3, STATUS: 4, REASON: 5, MANUAL: 9, MANUAL_NOTE: 10 };

export function createSheetsClient(serviceAccountPath) {
  if (!fs.existsSync(serviceAccountPath)) {
    throw new Error(`Không tìm thấy file Service Account: ${serviceAccountPath}`);
  }
  const key = JSON.parse(fs.readFileSync(serviceAccountPath, 'utf8'));
  if (!key.client_email || !key.private_key) {
    throw new Error('File Service Account thiếu client_email hoặc private_key.');
  }
  const auth = new JWT({
    email: key.client_email,
    key: key.private_key,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  return new SheetsClient(auth, key.client_email);
}

export class SheetsClient {
  constructor(auth, email) {
    this.auth = auth;
    this.email = email;
  }

  async request(url, options = {}) {
    try {
      const res = await this.auth.request({ url, ...options });
      return res.data;
    } catch (err) {
      const status = err.response?.status;
      const msg = err.response?.data?.error?.message || err.message;
      if (status === 403) {
        throw new Error(`Google Sheets từ chối truy cập (403). Hãy share sheet cho ${this.email} với quyền Editor. Chi tiết: ${msg}`);
      }
      if (status === 404) {
        throw new Error(`Không tìm thấy Google Sheet (404). Kiểm tra lại sheetId. Chi tiết: ${msg}`);
      }
      throw new Error(`Lỗi Google Sheets API${status ? ` (${status})` : ''}: ${msg}`);
    }
  }

  async getSpreadsheet(sheetId) {
    return this.request(`${API}/${sheetId}?fields=properties.title,sheets.properties`);
  }

  async readRange(sheetId, range) {
    const data = await this.request(`${API}/${sheetId}/values/${encodeURIComponent(range)}`);
    return data.values || [];
  }

  async writeRange(sheetId, range, values) {
    return this.request(`${API}/${sheetId}/values/${encodeURIComponent(range)}?valueInputOption=USER_ENTERED`, {
      method: 'PUT',
      data: { range, majorDimension: 'ROWS', values },
    });
  }

  /** Ghi nhiều vùng rời nhau trong một lần gọi. data = [{ range, values }]. */
  async batchWriteRanges(sheetId, data) {
    return this.request(`${API}/${sheetId}/values:batchUpdate`, {
      method: 'POST',
      data: { valueInputOption: 'USER_ENTERED', data },
    });
  }

  async clearRange(sheetId, range) {
    return this.request(`${API}/${sheetId}/values/${encodeURIComponent(range)}:clear`, { method: 'POST', data: {} });
  }

  async batchUpdate(sheetId, requests) {
    if (!requests.length) return null;
    return this.request(`${API}/${sheetId}:batchUpdate`, { method: 'POST', data: { requests } });
  }

  /** Đảm bảo các tab tồn tại; trả về map tên -> sheetId số. */
  async ensureTabs(sheetId, names) {
    const meta = await this.getSpreadsheet(sheetId);
    const existing = new Map((meta.sheets || []).map((s) => [s.properties.title, s.properties]));
    const requests = [];

    // Nếu tab chính chưa có mà tab đầu tiên còn trống (Trang tính1/Sheet1) thì đổi tên dùng luôn.
    const first = (meta.sheets || [])[0]?.properties;
    if (!existing.has(TABS.MAIN) && first && /^(trang tính\s*1|sheet\s*1)$/i.test(first.title)) {
      const rows = await this.readRange(sheetId, `'${first.title}'!A1:C3`);
      if (!rows.length) {
        requests.push({ updateSheetProperties: { properties: { sheetId: first.sheetId, title: TABS.MAIN }, fields: 'title' } });
        existing.set(TABS.MAIN, { ...first, title: TABS.MAIN });
      }
    }
    for (const name of names) {
      if (!existing.has(name)) requests.push({ addSheet: { properties: { title: name } } });
    }
    if (requests.length) await this.batchUpdate(sheetId, requests);
    const after = await this.getSpreadsheet(sheetId);
    const map = new Map();
    for (const s of after.sheets || []) map.set(s.properties.title, s.properties.sheetId);
    return map;
  }

  /** Ghi bảng (header + rows) và xoá phần dư phía dưới. */
  async writeTable(sheetId, tab, header, rows) {
    const values = [header, ...rows].map((row) => row.map(toCell));
    await this.writeRange(sheetId, `'${tab}'!A1`, values);
    const from = values.length + 1;
    await this.clearRange(sheetId, `'${tab}'!A${from}:Z${from + 5000}`);
  }

  /** Định dạng header đậm, cố định dòng đầu, tô màu trạng thái. */
  async formatMainTab(sheetId, tabIds) {
    const requests = [];
    for (const [tab, sheetNum] of tabIds) {
      requests.push({
        repeatCell: {
          range: { sheetId: sheetNum, startRowIndex: 0, endRowIndex: 1 },
          cell: { userEnteredFormat: { textFormat: { bold: true }, backgroundColor: { red: 0.9, green: 0.9, blue: 0.9 } } },
          fields: 'userEnteredFormat(textFormat,backgroundColor)',
        },
      });
      requests.push({
        updateSheetProperties: { properties: { sheetId: sheetNum, gridProperties: { frozenRowCount: 1 } }, fields: 'gridProperties.frozenRowCount' },
      });
      if (tab === TABS.MAIN) {
        const colors = [
          [STATUS.QUALIFIED, { red: 0.78, green: 0.94, blue: 0.8 }],
          [STATUS.PENDING, { red: 1, green: 0.95, blue: 0.7 }],
          [STATUS.REJECTED, { red: 0.98, green: 0.82, blue: 0.82 }],
        ];
        colors.forEach(([text, color], index) => {
          requests.push({
            addConditionalFormatRule: {
              rule: {
                ranges: [{ sheetId: sheetNum, startRowIndex: 1, startColumnIndex: 4, endColumnIndex: 5 }],
                booleanRule: { condition: { type: 'TEXT_EQ', values: [{ userEnteredValue: text }] }, format: { backgroundColor: color } },
              },
              index,
            },
          });
        });
      }
    }
    await this.batchUpdate(sheetId, requests);
  }
}

/**
 * Chuẩn hoá giá trị ô trước khi ghi với valueInputOption=USER_ENTERED:
 * - số nhỏ giữ là số để sheet tính toán được;
 * - link http(s) giữ nguyên để sheet tự tạo liên kết;
 * - mọi chuỗi khác thêm dấu nháy đơn ở đầu để sheet lưu đúng dạng văn bản
 *   (tránh mất số 0, mất độ chính xác của User ID dài, và tránh chuỗi bắt đầu
 *   bằng "=" bị hiểu thành công thức).
 */
export function toCell(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'number') return Number.isFinite(value) ? value : '';
  if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE';
  const s = String(value);
  if (s === '') return '';
  if (/^\d{1,9}$/.test(s)) return Number(s);
  if (/^https?:\/\/\S+$/i.test(s)) return s;
  return `'${s}`;
}

/** Đọc cột duyệt tay hiện có trong tab Danh sách: uid -> { decision, note }. */
export function parseManualColumns(rows) {
  return mergeManual({}, rows);
}

/**
 * Gộp cột duyệt tay trên sheet vào bản đã lưu (state.json).
 * User đang có dòng trên sheet: lấy theo sheet, kể cả khi team đã xoá trắng quyết định.
 * User không còn dòng (bình luận tạm không tải được): giữ quyết định cũ để khôi phục khi họ quay lại.
 */
export function mergeManual(saved, rows) {
  const merged = { ...(saved || {}) };
  if (!rows.length) return merged;
  const header = rows[0] || [];
  const uidIdx = indexOfHeader(header, /user id/i, COL.UID);
  const manualIdx = indexOfHeader(header, /duyệt tay/i, COL.MANUAL);
  const noteIdx = indexOfHeader(header, /ghi chú duyệt/i, COL.MANUAL_NOTE);
  for (const row of rows.slice(1)) {
    const uid = String(row[uidIdx] || '').trim();
    if (!uid) continue;
    const decision = String(row[manualIdx] || '').trim();
    const note = String(row[noteIdx] || '').trim();
    if (decision || note) merged[uid] = { decision, note };
    else delete merged[uid];
  }
  return merged;
}

/** Chỉ số cột (từ 0) sang chữ cột của sheet: 0 -> A, 25 -> Z, 26 -> AA. */
export function columnLetter(index) {
  let n = index + 1;
  let out = '';
  while (n > 0) {
    const r = (n - 1) % 26;
    out = String.fromCharCode(65 + r) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
}

/**
 * Dựng các ô cần ghi khi duyệt tay trên giao diện: tìm dòng theo User ID (không theo số dòng,
 * vì bảng được sắp xếp lại sau mỗi lần quét), ghi Duyệt tay, Ghi chú duyệt và nếu có thì cả Trạng thái, Lý do.
 * @returns {{ rowNumber: number, data: Array<{ range: string, values: any[][] }> } | null} null nếu không thấy dòng
 */
export function buildManualUpdate(rows, uid, { decision, note, status, reasons }) {
  if (!rows.length) return null;
  const header = rows[0] || [];
  const idx = {
    uid: indexOfHeader(header, /user id/i, COL.UID),
    status: indexOfHeader(header, /^trạng thái/i, COL.STATUS),
    reason: indexOfHeader(header, /lý do/i, COL.REASON),
    manual: indexOfHeader(header, /duyệt tay/i, COL.MANUAL),
    note: indexOfHeader(header, /ghi chú duyệt/i, COL.MANUAL_NOTE),
  };
  const i = rows.findIndex((row, n) => n > 0 && String(row[idx.uid] || '').trim() === String(uid));
  if (i < 0) return null;
  const rowNumber = i + 1;
  const cell = (col, value) => ({ range: `'${TABS.MAIN}'!${columnLetter(col)}${rowNumber}`, values: [[toCell(value)]] });
  const data = [cell(idx.manual, decision), cell(idx.note, note)];
  if (status) data.push(cell(idx.status, status), cell(idx.reason, (reasons || []).join('; ')));
  return { rowNumber, data };
}

function indexOfHeader(header, re, fallback) {
  const i = header.findIndex((h) => re.test(String(h || '')));
  return i >= 0 ? i : fallback;
}

export function buildMainRows(records, timeZone) {
  return records.map((r, i) => [
    i + 1,
    r.name,
    r.profileUrl,
    r.uid,
    r.status,
    r.reasons.join('; '),
    r.tagCount,
    r.memberLabel,
    r.shareLabel,
    r.manualDecision,
    r.manualNote,
    r.likes,
    r.replies,
    r.engagement,
    formatDateTime(r.updatedAt, timeZone),
    r.comment?.createdAt ? formatDateTime(r.comment.createdAt, timeZone) : '',
    r.comment?.url || '',
    truncate(r.comment?.text, 300),
  ]);
}

export function buildRejectedRows(rejected, timeZone) {
  return rejected.map((r, i) => [
    i + 1,
    r.name,
    r.profileUrl,
    r.uid,
    r.reason,
    r.tagCount,
    formatDateTime(r.updatedAt, timeZone),
    r.comment?.url || '',
    truncate(r.comment?.text, 300),
  ]);
}

/** Gộp snapshot hôm nay vào lịch sử: mỗi (ngày, uid) một dòng, giữ giá trị mới nhất. */
export function mergeHistory(existingRows, records, { dayKey, timeZone, now }) {
  const header = HISTORY_HEADER;
  const body = existingRows.length ? existingRows.slice(1) : [];
  const index = new Map();
  body.forEach((row, i) => index.set(`${row[0]}|${row[1]}`, i));
  for (const r of records) {
    const row = [dayKey, r.uid, r.name, r.likes, r.replies, r.engagement, formatDateTime(now, timeZone)];
    const key = `${dayKey}|${r.uid}`;
    if (index.has(key)) body[index.get(key)] = row;
    else {
      index.set(key, body.length);
      body.push(row);
    }
  }
  return [header, ...body];
}

export function buildSystemRows(info) {
  return [
    ['Mục', 'Giá trị'],
    ['Lần chạy gần nhất', info.lastRun],
    ['Kết quả', info.result],
    ['Bài viết', info.postUrl],
    ['Số bình luận quét được', info.commentCount],
    ['Số user có bình luận', info.userCount],
    ['Đủ điều kiện', info.qualified],
    ['Chờ duyệt', info.pending],
    ['Loại (tab Danh sách)', info.rejected],
    ['Không đủ tag (tab Bị loại)', info.rejectedTags],
    ['Người chia sẻ đọc được', info.shareCount],
    ['Ghi chú share', info.shareNote],
    ['Kiểm tra thành viên trong lần chạy', info.memberChecks],
    ['Thời điểm chốt', info.freezeAt],
    ['Trạng thái chốt', info.freezeStatus],
    ['Lỗi gần nhất', info.lastError || ''],
  ];
}
