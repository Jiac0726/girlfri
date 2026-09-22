const app = getApp();

const PAGE_SIZE = 20;
const WEEK_LABELS = ['一', '二', '三', '四', '五', '六', '日'];
const pad = (n) => (n < 10 ? '0' + n : '' + n);

// 取「备注最长」的一条（最有故事的一条）
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
    canPrev: true,
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
    this.initEarliest().then(() => this.render());
  },

  onShow() {
    // 从评价页切回来时，若已初始化则刷新
    if (this.viewYear !== undefined && this.earliest !== undefined && this.inited) {
      this.render();
    }
  },

  // 找到最早一条记录所在的月份，用来限制「往前翻」
  async initEarliest() {
    try {
      const db = wx.cloud.database();
      const res = await db
        .collection(app.globalData.COLLECTION)
        .orderBy('date', 'asc')
        .limit(1)
        .get();
      if (res.data && res.data.length) {
        const d = new Date(res.data[0].date + 'T00:00:00');
        this.earliest = { y: d.getFullYear(), m: d.getMonth() };
      } else {
        this.earliest = null;
      }
    } catch (e) {
      this.earliest = null;
    }
    this.inited = true;
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

  async render() {
    const y = this.viewYear;
    const m = this.viewMonth; // 0-based
    const daysInMonth = new Date(y, m + 1, 0).getDate();
    const startStr = y + '-' + pad(m + 1) + '-01';
    const endStr = y + '-' + pad(m + 1) + '-' + pad(daysInMonth);

    // 能否前后翻月
    const now = new Date();
    const isCurrent =
      y === now.getFullYear() && m === now.getMonth();
    let canPrev = true;
    if (this.earliest) {
      canPrev =
        y > this.earliest.y || (y === this.earliest.y && m > this.earliest.m);
    } else {
      canPrev = y > 2020 || (y === 2020 && m > 0);
    }

    wx.showLoading({ title: '加载中' });
    try {
      const db = wx.cloud.database();
      const _ = db.command;
      const all = [];
      let skip = 0;
      for (;;) {
        const res = await db
          .collection(app.globalData.COLLECTION)
          .where({ date: _.gte(startStr).and(_.lte(endStr)) })
          .orderBy('date', 'asc')
          .skip(skip)
          .limit(PAGE_SIZE)
          .get();
        all.push.apply(all, res.data || []);
        if (!res.data || res.data.length < PAGE_SIZE) break;
        skip += PAGE_SIZE;
      }

      const map = {};
      all.forEach((it) => (map[it.date] = it));

      const goodList = all.filter((x) => x.type === 'good');
      const goodCount = goodList.length;
      const badCount = all.length - goodCount;
      const goodRate = all.length ? Math.round((goodCount / all.length) * 100) : 0;

      // 本月最长连续好评（按日历连续天数算）
      let run = 0;
      let monthBestStreak = 0;
      for (let d = 1; d <= daysInMonth; d++) {
        const rec = map[y + '-' + pad(m + 1) + '-' + pad(d)];
        run = rec && rec.type === 'good' ? run + 1 : 0;
        if (run > monthBestStreak) monthBestStreak = run;
      }

      // 日历格子（周一起）
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

      // 本月之最
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
    } catch (e) {
      wx.showToast({
        title: '加载失败：' + (e.errMsg || e.message || ''),
        icon: 'none',
      });
    } finally {
      wx.hideLoading();
    }
  },
});
