const api = require('../../services/cloud');

const WEEK_LABELS = ['一', '二', '三', '四', '五', '六', '日'];
const pad = (n) => (n < 10 ? '0' + n : '' + n);

function pickLongest(arr) {
  let best = null;
  arr.forEach((it) => {
    const len = ((it && it.reason) || '').trim().length;
    if (!len) return;
    if (!best || len > best.reason.trim().length) best = it;
  });
  return best;
}

Page({
  data: {
    year: 0,
    month: 0,
    monthLabel: '',
    canPrev: false,
    canNext: false,
    weeks: WEEK_LABELS,
    calendar: [],
    goodCount: 0,
    badCount: 0,
    goodRate: 0,
    monthBestStreak: 0,
    star: null,
    fail: null,
    essay: null,
    hasData: false,
  },

  onLoad() {
    const now = new Date();
    this.viewYear = now.getFullYear();
    this.viewMonth = now.getMonth();
    this.earliest = null;
    this.allRatings = [];
  },

  onShow() {
    this.refreshAll();
  },

  promptBinding() {
    if (this.bindingPrompted) return;
    this.bindingPrompted = true;
    wx.showModal({
      title: '先完成双人绑定',
      content: '绑定后才能查看共同月报。',
      confirmText: '去绑定',
      confirmColor: '#ff6b81',
      success: (res) => {
        if (res.confirm) wx.navigateTo({ url: '/pages/bind/bind' });
      },
      complete: () => {
        this.bindingPrompted = false;
      },
    });
  },

  async refreshAll() {
    wx.showLoading({ title: '加载中' });
    try {
      const all = await api.listRatings();
      this.allRatings = all.slice();

      if (all.length) {
        const oldest = all[all.length - 1];
        const d = new Date(oldest.date + 'T00:00:00');
        this.earliest = { y: d.getFullYear(), m: d.getMonth() };
      } else {
        this.earliest = null;
      }

      this.render();
    } catch (e) {
      this.allRatings = [];
      this.earliest = null;
      this.render();
      if (api.isBindingError(e)) this.promptBinding();
      else wx.showToast({ title: '加载失败：' + (e.message || ''), icon: 'none' });
    } finally {
      wx.hideLoading();
    }
  },

  prevMonth() {
    if (!this.data.canPrev) return;
    this.viewMonth -= 1;
    if (this.viewMonth < 0) {
      this.viewMonth = 11;
      this.viewYear -= 1;
    }
    this.render();
  },

  nextMonth() {
    if (!this.data.canNext) return;
    this.viewMonth += 1;
    if (this.viewMonth > 11) {
      this.viewMonth = 0;
      this.viewYear += 1;
    }
    this.render();
  },

  render() {
    const y = this.viewYear;
    const m = this.viewMonth;
    const daysInMonth = new Date(y, m + 1, 0).getDate();
    const startStr = y + '-' + pad(m + 1) + '-01';
    const endStr = y + '-' + pad(m + 1) + '-' + pad(daysInMonth);

    const now = new Date();
    const isCurrent = y === now.getFullYear() && m === now.getMonth();

    let canPrev = false;
    if (this.earliest) {
      canPrev =
        y > this.earliest.y || (y === this.earliest.y && m > this.earliest.m);
    }

    const all = (this.allRatings || [])
      .filter((it) => it.date >= startStr && it.date <= endStr)
      .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

    const map = {};
    all.forEach((it) => (map[it.date] = it));

    const goodList = all.filter((x) => x.type === 'good');
    const goodCount = goodList.length;
    const badCount = all.length - goodCount;
    const goodRate = all.length ? Math.round((goodCount / all.length) * 100) : 0;

    let run = 0;
    let monthBestStreak = 0;
    for (let d = 1; d <= daysInMonth; d++) {
      const rec = map[y + '-' + pad(m + 1) + '-' + pad(d)];
      run = rec && rec.type === 'good' ? run + 1 : 0;
      if (run > monthBestStreak) monthBestStreak = run;
    }

    const first = new Date(y, m, 1);
    const offset = (first.getDay() + 6) % 7;
    const todayStr =
      now.getFullYear() + '-' + pad(now.getMonth() + 1) + '-' + pad(now.getDate());
    const calendar = [];

    for (let i = 0; i < offset; i++) {
      calendar.push({ key: 'e' + i, empty: true });
    }

    for (let d = 1; d <= daysInMonth; d++) {
      const key = y + '-' + pad(m + 1) + '-' + pad(d);
      const rec = map[key];
      calendar.push({
        key,
        empty: false,
        dayNum: d,
        emoji: rec ? (rec.type === 'good' ? '👍' : '👎') : '',
        cls: rec
          ? rec.type === 'good'
            ? 'cal-good'
            : 'cal-bad'
          : 'cal-none',
        isToday: key === todayStr,
      });
    }

    while (calendar.length % 7 !== 0) {
      calendar.push({ key: 't' + calendar.length, empty: true });
    }

    const badList = all.filter((x) => x.type === 'bad');
    let star = pickLongest(goodList);
    if (!star && goodList.length) star = goodList[goodList.length - 1];
    let fail = pickLongest(badList);
    if (!fail && badList.length) fail = badList[badList.length - 1];
    const essay = pickLongest(all);

    this.setData({
      year: y,
      month: m,
      monthLabel: y + ' 年 ' + (m + 1) + ' 月',
      canPrev,
      canNext: !isCurrent,
      calendar,
      goodCount,
      badCount,
      goodRate,
      monthBestStreak,
      star,
      fail,
      essay,
      hasData: all.length > 0,
    });
  },
});
