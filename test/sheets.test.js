import test from 'node:test';
import assert from 'node:assert/strict';
import { parseManualColumns, mergeManual, buildMainRows, mergeHistory, toCell, MAIN_HEADER, HISTORY_HEADER, COL } from '../src/sheets.js';
import { STATUS } from '../src/rules.js';

const TZ = 'Asia/Ho_Chi_Minh';

test('parseManualColumns đọc cột duyệt tay theo header', () => {
  const rows = [MAIN_HEADER, [], ['1', 'A', 'url', '1001', STATUS.PENDING, '', 5, '', '', 'OK', 'ghi chú'], ['2', 'B', 'url', '1002']];
  const manual = parseManualColumns(rows);
  assert.deepEqual(manual, { 1001: { decision: 'OK', note: 'ghi chú' } });
  assert.deepEqual(parseManualColumns([]), {});
});

test('parseManualColumns vẫn đọc được khi người dùng đổi vị trí cột', () => {
  const header = ['User ID', 'Tên', 'Duyệt tay (OK / LOẠI)', 'Ghi chú duyệt'];
  const manual = parseManualColumns([header, ['77', 'X', 'loại', 'spam']]);
  assert.deepEqual(manual, { 77: { decision: 'loại', note: 'spam' } });
});

test('mergeManual giữ quyết định của user tạm biến khỏi sheet, nhưng tôn trọng ô bị xoá trắng', () => {
  const saved = {
    1001: { decision: 'OK', note: 'đã xem share' },
    1002: { decision: 'LOẠI', note: 'spam' },
    1003: { decision: 'OK', note: '' },
  };
  // Lần quét này 1001 không có trên sheet (tải thiếu), 1002 bị team xoá trắng, 1004 mới được duyệt.
  const rows = [MAIN_HEADER, ['1', 'B', 'url', '1002', STATUS.PENDING, '', 5, '', '', '', ''], ['2', 'C', 'url', '1003', STATUS.QUALIFIED, '', 5, '', '', 'OK', 'đổi ghi chú'], ['3', 'D', 'url', '1004', STATUS.PENDING, '', 5, '', '', 'loại', '']];
  assert.deepEqual(mergeManual(saved, rows), {
    1001: { decision: 'OK', note: 'đã xem share' },
    1003: { decision: 'OK', note: 'đổi ghi chú' },
    1004: { decision: 'loại', note: '' },
  });
  assert.deepEqual(mergeManual(saved, []), saved, 'không đọc được sheet thì giữ nguyên bản lưu');
  assert.equal(saved[1002].decision, 'LOẠI', 'không sửa object gốc');
});

test('buildMainRows giữ đúng thứ tự cột và cột duyệt tay', () => {
  const record = {
    name: 'A',
    profileUrl: 'https://www.facebook.com/profile.php?id=1',
    uid: '1',
    status: STATUS.QUALIFIED,
    reasons: [],
    tagCount: 5,
    memberLabel: 'Thành viên',
    shareLabel: 'Đã share công khai',
    manualDecision: 'OK',
    manualNote: 'n',
    likes: 2,
    replies: 1,
    engagement: 3,
    updatedAt: new Date('2026-10-04T08:00:00+07:00'),
    comment: { createdAt: new Date('2026-10-01T10:30:00+07:00'), url: 'u', text: 'hello   world' },
  };
  const [row] = buildMainRows([record], TZ);
  assert.equal(row.length, MAIN_HEADER.length);
  assert.equal(row[COL.UID], '1');
  assert.equal(row[COL.MANUAL], 'OK');
  assert.equal(row[COL.MANUAL_NOTE], 'n');
  assert.equal(row[14], '04/10/2026 08:00:00');
  assert.equal(row[15], '01/10/2026 10:30:00');
  assert.equal(row[17], 'hello world');
});

test('mergeHistory cập nhật dòng cùng ngày và thêm dòng mới', () => {
  const now = new Date('2026-10-04T09:00:00+07:00');
  const existing = [HISTORY_HEADER, ['2026-10-03', '1', 'A', '1', '0', '1', 'x'], ['2026-10-04', '1', 'A', '2', '0', '2', 'y']];
  const records = [
    { uid: '1', name: 'A', likes: 5, replies: 1, engagement: 6 },
    { uid: '2', name: 'B', likes: 1, replies: 0, engagement: 1 },
  ];
  const merged = mergeHistory(existing, records, { dayKey: '2026-10-04', timeZone: TZ, now });
  assert.equal(merged.length, 4);
  assert.deepEqual(merged[2].slice(0, 6), ['2026-10-04', '1', 'A', 5, 1, 6]);
  assert.deepEqual(merged[3].slice(0, 6), ['2026-10-04', '2', 'B', 1, 0, 1]);
  assert.deepEqual(merged[1], existing[1]);
});

test('toCell bảo vệ User ID dài, ngày và chuỗi bắt đầu bằng dấu bằng', () => {
  assert.equal(toCell(12), 12);
  assert.equal(toCell('12'), 12);
  assert.equal(toCell('100012345678901234'), "'100012345678901234");
  assert.equal(toCell('2026-10-04'), "'2026-10-04");
  assert.equal(toCell('=SUM(A1)'), "'=SUM(A1)");
  assert.equal(toCell('https://www.facebook.com/profile.php?id=1'), 'https://www.facebook.com/profile.php?id=1');
  assert.equal(toCell(null), '');
  assert.equal(toCell(undefined), '');
});
