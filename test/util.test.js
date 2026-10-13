import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCompactNumber } from '../src/util.js';

test('parseCompactNumber đọc số dạng gọn của Facebook', () => {
  const cases = [
    ['9', 9],
    ['13', 13],
    ['1,2K', 1200],
    ['1,2 N', 1200],
    ['5,1K', 5100],
    ['1,5 Tr', 1500000],
    ['1.5M', 1500000],
    ['1.234', 1234],
    ['abc', null],
    ['', null],
  ];
  for (const [text, want] of cases) assert.equal(parseCompactNumber(text), want, text);
});
