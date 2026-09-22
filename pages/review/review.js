const api = require('../../services/cloud');

const WEEK_LABELS = ['一', '二', '三', '四', '五', '六', '日'];
const WEEKS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
const pad = (n) => (n < 10 ? '0' + n : '' + n);
const fmtDate = (d) =>
  d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());

function groupByDate(list) {
  const map = {};
  list.forEach((it) => {
    if (!map[it.date]) map[it.date] = [];
    map[it.date].push(it);
  });
  return map;
}

function emojiFor(type) {
  return type === 'good' ? '👍' : '👎';
}

function dailyState(records) {
  const rows = records || [];
  const mine = rows.find((x) => x.fromMe);
  const partner = rows.find((x) => !x.fromMe);

  if (!rows.length) {
    return {
      emoji: '',
      cls: 'cal-none',
      mutualGood: false,
    };
  }

  const mutualGood =
    rows.length === 2 && rows.every((x) => x.type === 'good');
  const allBad = rows.every((x) => x.type === 'bad');
  const hasBad = rows.some((x) => x.type === 'bad');

  return {
    emoji:
      (mine ? emojiFor(mine.type) : '·') +
      (partner ? emojiFor(partner.type) : '·'),
    cls: mutualGood
      ? 'cal-good'
      : allBad
      ? 'cal-bad'
      : hasBad
      ? 'cal-mixed'
      : 'cal-partial',
    mutualGood,
  };
}

function pickLongest(arr) {
  let best = null;
  arr.forEach((it) => {
    const len = String((it && it.reason) || '').trim().length;
    if (!len) return;
    if (!best || len > String(best.reason || '').trim().length) best = it;
  });
  return best;
}

function relationshipVerdict(rate, total) {
  if (!total) return '还没有开始留下共同记录';
  if (rate >= 90) return '最近很会彼此肯定 ✨';
  if (rate >= 70) return '相处状态不错，继续认真回应 💕';
  if (rate >= 50) return '有甜有刺，值得多聊聊 🤝';
  if (rate >= 30) return '小摩擦偏多，记得及时沟通 🌧';
  return '最近低气压偏多，把感受说开会更好 🌱';
}

Page({
  data: {
    loading: false,
    ready: false,

    totalCount: 0,
    goodCount: 0,
    badCount: 0,
    goodRate: 0,
    goodStreak: 0,
    bestStreak: 0,
    verdict: '',

    year: 0,
    month: 0,
    monthLabel: '',
    canPrev: false,
    canNext: false,
    weeks: WEEK_LABELS,
    calendar: [],
    monthGood: 0,
    monthBad: 0,
    monthGoodRate: 0,
    monthBestStreak: 0,

    star: null,
    fail: null,
    essay: null,

    historyList: [],
    historyTotal: 0,
    showAllHistory: false,
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

  onPullDownRefresh() {
    this.refreshAll(true);
  },

  promptBinding() {
    if (this.bindingPrompted) return;
    this.bindingPrompted = true;
    wx.showModal({
      title: '先完成双人绑定',
      content: '绑定后才能看到两个人的共同回顾。',
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

  async refreshAll(isPullDown) {
    if (this.data.loading) return;
    this.setData({ loading: true });
    if (!isPullDown) wx.showLoading({ title: '整理回顾中' });

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

      this.computeOverall();
      this.renderMonth();
      this.renderHistory();
      this.setData({ ready: true });
    } catch (e) {
      this.allRatings = [];
      this.earliest = null;
      this.resetView();

      if (api.isBindingError(e)) {
        this.promptBinding();
      } else {
        wx.showToast({
          title: '加载失败：' + (e.message || ''),
          icon: 'none',
        });
      }
    } finally {
      this.setData({ loading: false });
      if (isPullDown) wx.stopPullDownRefresh();
      else wx.hideLoading();
    }
  },

  resetView() {
    this.setData({
      ready: true,
      totalCount: 0,
      goodCount: 0,
      badCount: 0,
      goodRate: 0,
      goodStreak: 0,
      bestStreak: 0,
      verdict: relationshipVerdict(0, 0),
      calendar: [],
      monthGood: 0,
      monthBad: 0,
      monthGoodRate: 0,
      monthBestStreak: 0,
      star: null,
      fail: null,
      essay: null,
      historyList: [],
      historyTotal: 0,
    });
  },

  computeOverall() {
    const all = this.allRatings || [];
    const totalCount = all.length;
    const goodCount = all.filter((x) => x.type === 'good').length;
    const goodRate = totalCount
      ? Math.round((goodCount / totalCount) * 100)
      : 0;

    const byDate = groupByDate(all);
    const dates = Object.keys(byDate).sort();

    let goodStreak = 0;
    if (dates.length) {
      let cur = new Date(dates[dates.length - 1] + 'T00:00:00');
      while (cur) {
        const state = dailyState(byDate[fmtDate(cur)]);
        if (!state.mutualGood) break;
        goodStreak += 1;
        cur.setDate(cur.getDate() - 1);
      }
    }

    let bestStreak = 0;
    let run = 0;
    let prev = null;

    dates.forEach((date) => {
      const d = new Date(date + 'T00:00:00');
      const contiguous =
        prev !== null && Math.round((d - prev) / 86400000) === 1;

      if (dailyState(byDate[date]).mutualGood) {
        run = contiguous ? run + 1 : 1;
        if (run > bestStreak) bestStreak = run;
      } else {
        run = 0;
      }

      prev = d;
    });

    this.setData({
      totalCount,
      goodCount,
      badCount: totalCount - goodCount,
      goodRate,
      goodStreak,
      bestStreak,
      verdict: relationshipVerdict(goodRate, totalCount),
    });
  },

  prevMonth() {
    if (!this.data.canPrev) return;

    this.viewMonth -= 1;
    if (this.viewMonth < 0) {
      this.viewMonth = 11;
      this.viewYear -= 1;
    }

    this.renderMonth();
  },

  nextMonth() {
    if (!this.data.canNext) return;

    this.viewMonth += 1;
    if (this.viewMonth > 11) {
      this.viewMonth = 0;
      this.viewYear += 1;
    }

    this.renderMonth();
  },

  renderMonth() {
    const y = this.viewYear;
    const m = this.viewMonth;
    const daysInMonth = new Date(y, m + 1, 0).getDate();
    const start = y + '-' + pad(m + 1) + '-01';
    const end = y + '-' + pad(m + 1) + '-' + pad(daysInMonth);

    const now = new Date();
    const isCurrent =
      y === now.getFullYear() && m === now.getMonth();

    let canPrev = false;
    if (this.earliest) {
      canPrev =
        y > this.earliest.y ||
        (y === this.earliest.y && m > this.earliest.m);
    }

    const monthRows = (this.allRatings || [])
      .filter((it) => it.date >= start && it.date <= end)
      .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

    const byDate = groupByDate(monthRows);
    const goodRows = monthRows.filter((x) => x.type === 'good');
    const badRows = monthRows.filter((x) => x.type === 'bad');

    const monthGood = goodRows.length;
    const monthBad = badRows.length;
    const monthTotal = monthRows.length;
    const monthGoodRate = monthTotal
      ? Math.round((monthGood / monthTotal) * 100)
      : 0;

    let run = 0;
    let monthBestStreak = 0;
    for (let d = 1; d <= daysInMonth; d += 1) {
      const key = y + '-' + pad(m + 1) + '-' + pad(d);
      const state = dailyState(byDate[key]);
      run = state.mutualGood ? run + 1 : 0;
      if (run > monthBestStreak) monthBestStreak = run;
    }

    const first = new Date(y, m, 1);
    const offset = (first.getDay() + 6) % 7;
    const todayStr = fmtDate(now);
    const calendar = [];

    for (let i = 0; i < offset; i += 1) {
      calendar.push({ key: 'e' + i, empty: true });
    }

    for (let d = 1; d <= daysInMonth; d += 1) {
      const key = y + '-' + pad(m + 1) + '-' + pad(d);
      const state = dailyState(byDate[key]);

      calendar.push({
        key,
        empty: false,
        dayNum: d,
        emoji: state.emoji,
        cls: state.cls,
        isToday: key === todayStr,
      });
    }

    while (calendar.length % 7 !== 0) {
      calendar.push({
        key: 't' + calendar.length,
        empty: true,
      });
    }

    let star = pickLongest(goodRows);
    if (!star && goodRows.length) star = goodRows[goodRows.length - 1];

    let fail = pickLongest(badRows);
    if (!fail && badRows.length) fail = badRows[badRows.length - 1];

    const essay = pickLongest(monthRows);

    this.setData({
      year: y,
      month: m,
      monthLabel: y + ' 年 ' + (m + 1) + ' 月',
      canPrev,
      canNext: !isCurrent,
      calendar,
      monthGood,
      monthBad,
      monthGoodRate,
      monthBestStreak,
      star,
      fail,
      essay,
    });
  },

  renderHistory() {
    const rows = (this.allRatings || []).map((it) => {
      const d = new Date(it.date + 'T00:00:00');
      return Object.assign({}, it, {
        key: it.date + '-' + (it.fromMe ? 'mine' : 'partner'),
        weekDay: WEEKS[d.getDay()] || '',
        reason: String(it.reason || '').trim(),
      });
    });

    const limit = this.data.showAllHistory ? rows.length : 12;

    this.setData({
      historyList: rows.slice(0, limit),
      historyTotal: rows.length,
    });
  },

  toggleHistory() {
    this.setData(
      { showAllHistory: !this.data.showAllHistory },
      () => this.renderHistory()
    );
  },

  makePoster() {
    if (!this.data.totalCount) {
      wx.showToast({
        title: '还没有记录可以生成',
        icon: 'none',
      });
      return;
    }

    wx.showLoading({ title: '生成中', mask: true });

    const W = 750;
    const H = 1080;
    const query = this.createSelectorQuery();

    query
      .select('#poster')
      .fields({ node: true, size: true })
      .exec((res) => {
        if (!res || !res[0] || !res[0].node) {
          wx.hideLoading();
          wx.showToast({ title: '画布初始化失败', icon: 'none' });
          return;
        }

        const node = res[0].node;
        node.width = W;
        node.height = H;
        const ctx = node.getContext('2d');

        this.paintPoster(ctx, W, H);

        wx.canvasToTempFilePath({
          canvas: node,
          x: 0,
          y: 0,
          width: W,
          height: H,
          destWidth: W * 2,
          destHeight: H * 2,
          fileType: 'png',
          quality: 1,
          success: (fp) => {
            wx.hideLoading();
            this.posterMenu(fp.tempFilePath);
          },
          fail: () => {
            wx.hideLoading();
            wx.showToast({ title: '生成失败', icon: 'none' });
          },
        });
      });
  },

  posterMenu(path) {
    wx.showActionSheet({
      itemList: ['保存到相册', '预览大图'],
      success: (res) => {
        if (res.tapIndex === 0) this.savePoster(path);
        else wx.previewImage({ urls: [path] });
      },
    });
  },

  savePoster(path) {
    wx.saveImageToPhotosAlbum({
      filePath: path,
      success: () =>
        wx.showToast({ title: '已保存到相册 💕', icon: 'none' }),
      fail: (e) => {
        if (/auth/i.test(e.errMsg || '')) {
          wx.showModal({
            title: '需要相册权限',
            content: '请允许保存图片到相册。',
            confirmText: '去设置',
            success: (res) => {
              if (res.confirm) wx.openSetting();
            },
          });
        } else {
          wx.showToast({ title: '保存失败', icon: 'none' });
        }
      },
    });
  },

  roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + w - r, y);
    ctx.arcTo(x + w, y, x + w, y + r, r);
    ctx.lineTo(x + w, y + h - r);
    ctx.arcTo(x + w, y + h, x + w - r, y + h, r);
    ctx.lineTo(x + r, y + h);
    ctx.arcTo(x, y + h, x, y + h - r, r);
    ctx.lineTo(x, y + r);
    ctx.arcTo(x, y, x + r, y, r);
    ctx.closePath();
  },

  paintPoster(ctx, W, H) {
    const d = this.data;
    const cx = W / 2;

    const bg = ctx.createLinearGradient(0, 0, 0, H);
    bg.addColorStop(0, '#fff0f3');
    bg.addColorStop(1, '#ffdbe3');
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, W, H);

    this.roundRect(ctx, 32, 32, W - 64, H - 64, 36);
    ctx.fillStyle = '#ffffff';
    ctx.fill();

    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    ctx.fillStyle = '#4a3540';
    ctx.font = 'bold 46px sans-serif';
    ctx.fillText('热念 · 我们的回顾', cx, 118);

    ctx.fillStyle = '#b08090';
    ctx.font = '24px sans-serif';
    ctx.fillText(
      d.monthLabel + '  ·  累计 ' + d.totalCount + ' 条记录',
      cx,
      168
    );

    ctx.fillStyle = '#ff6b81';
    ctx.font = 'bold 106px sans-serif';
    ctx.fillText(d.goodRate + '%', cx, 332);

    ctx.fillStyle = '#b08090';
    ctx.font = '24px sans-serif';
    ctx.fillText('双方累计好评率', cx, 402);

    ctx.font = 'bold 28px sans-serif';
    const verdict = d.verdict || '';
    const vw = Math.min(ctx.measureText(verdict).width + 80, 610);
    this.roundRect(ctx, cx - vw / 2, 454, vw, 68, 34);
    ctx.fillStyle = '#fff0f3';
    ctx.fill();
    ctx.fillStyle = '#4a3540';
    ctx.fillText(verdict, cx, 488);

    const kpis = [
      [d.goodStreak + ' 天', '当前双向连好'],
      [d.bestStreak + ' 天', '历史最长'],
      [d.monthGoodRate + '%', '本月好评率'],
    ];
    const xs = [160, 375, 590];

    kpis.forEach((item, i) => {
      ctx.fillStyle = i === 1 ? '#4a3540' : '#ff6b81';
      ctx.font = 'bold 42px sans-serif';
      ctx.fillText(item[0], xs[i], 640);
      ctx.fillStyle = '#b08090';
      ctx.font = '21px sans-serif';
      ctx.fillText(item[1], xs[i], 686);
    });

    ctx.strokeStyle = '#faeef1';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(86, 752);
    ctx.lineTo(W - 86, 752);
    ctx.stroke();

    ctx.fillStyle = '#4a3540';
    ctx.font = 'bold 28px sans-serif';
    ctx.fillText(d.monthLabel + ' · 本月', cx, 812);

    ctx.fillStyle = '#ff6b81';
    ctx.font = 'bold 34px sans-serif';
    ctx.fillText('👍 ' + d.monthGood + ' 条', 245, 870);

    ctx.fillStyle = '#78909c';
    ctx.fillText('👎 ' + d.monthBad + ' 条', 505, 870);

    ctx.fillStyle = '#b08090';
    ctx.font = '22px sans-serif';
    ctx.fillText(
      '双方连续互给好评最长 ' + d.monthBestStreak + ' 天',
      cx,
      930
    );

    ctx.fillStyle = '#d1b7c0';
    ctx.font = '21px sans-serif';
    ctx.fillText('热念 · 把每天的相处认真留住', cx, 1005);
  },
});
