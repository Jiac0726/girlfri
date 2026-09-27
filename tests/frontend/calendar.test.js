const test = require('node:test');
const assert = require('node:assert/strict');
const { calendarMonth, shiftMonth } = require('../../helpers/calendar');

test('calendar starts on Monday and keeps leap day and trailing blanks', () => {
  const cells = calendarMonth('2024-02', [{ date: '2024-02-29', count: 2, fromMeCount: 1, partnerCount: 1 }]);
  assert.equal(cells.length, 35);
  assert.equal(cells[0].date, '');
  assert.equal(cells[3].date, '2024-02-01');
  assert.equal(cells.filter(cell => cell.date).length, 29);
  assert.equal(cells.find(cell => cell.date === '2024-02-29').shared, true);
  assert.equal(cells.at(-1).date, '');
});

test('calendar marks only real records and month navigation crosses year boundaries', () => {
  const cells = calendarMonth('2026-09', [{ date: '2026-09-23', count: 1, fromMeCount: 1, partnerCount: 0 }]);
  assert.equal(cells.find(cell => cell.date === '2026-09-23').recorded, true);
  assert.equal(cells.find(cell => cell.date === '2026-09-23').shared, false);
  assert.equal(cells.find(cell => cell.date === '2026-09-24').recorded, false);
  assert.equal(shiftMonth('2026-12', 1), '2027-01');
  assert.equal(shiftMonth('2026-01', -1), '2025-12');
});
