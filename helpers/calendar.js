const pad = value => String(value).padStart(2, '0');

function calendarMonth(month, days = []) {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) return [];
  const [year, number] = month.split('-').map(Number);
  const first = new Date(month + '-01T00:00:00Z');
  const offset = (first.getUTCDay() + 6) % 7;
  const count = new Date(Date.UTC(year, number, 0)).getUTCDate();
  const records = new Map(days.map(day => [day.date, day]));
  const cells = [];
  for (let i = 0; i < Math.ceil((offset + count) / 7) * 7; i++) {
    const day = i - offset + 1;
    const date = day > 0 && day <= count ? month + '-' + pad(day) : '';
    const stats = records.get(date) || {};
    cells.push({ key: date || 'blank-' + i, date, label: date ? day : '', recorded: Number(stats.count) > 0, shared: !!(stats.fromMeCount && stats.partnerCount) });
  }
  return cells;
}

function shiftMonth(month, step) {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) return month;
  const date = new Date(month + '-01T00:00:00Z');
  date.setUTCMonth(date.getUTCMonth() + step);
  return date.toISOString().slice(0, 7);
}

module.exports = { calendarMonth, shiftMonth };
