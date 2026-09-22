const api = require('../../services/cloud');

const pad = (n) => (n < 10 ? '0' + n : '' + n);
const fmtDate = (d) =>
  d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());

Page({
  data: {
    ready: false,
    totalCount: 0,
    goodCount: 0,
    badCount: 0,
    goodRate: 0,
    goodStreak: 0,
    bestStreak: 0,
    recent14: [],
    monthGood: 0,
    monthBad: 0,
    monthGoodPct: 0,
    monthBadPct: 0,
    monthName: '',
    verdict: '',
  },

  onShow() {
    this.loadStats();
  },

  onPullDownRefresh() {
    this.loadStats(true);
  },

  async loadStats(isPullDown) {
    if (!isPullDown) wx.showLoading({ title: '统计中' });
    try {
      const all = await api.listRatings();

      const map = {};
      all.forEach((it) => (map[it.date] = it));

      const goodCount = all.filter((x) => x.type === 'good').length;
      const totalCount = all.length;
      const goodRate = totalCount ? Math.round((goodCount / totalCount) * 100) : 0;

      // 连续好评：从「今天」或「最近有记录的一天」往回数连续 good
      let cur = new Date();
      if (!map[fmtDate(cur)]) {
        cur = all.length ? new Date(all[0].date + 'T00:00:00') : null;
      }
      let goodStreak = 0;
      while (cur) {
        const rec = map[fmtDate(cur)];
        if (rec && rec.type === 'good') {
          goodStreak += 1;
          cur.setDate(cur.getDate() - 1);
        } else {
          break;
        }
      }

      // 历史最长连续好评
      let bestStreak = 0;
      let run = 0;
      const asc = all.slice().sort((a, b) => (a.date < b.date ? -1 : 1));
      let prev = null;
      asc.forEach((it) => {
        const d = new Date(it.date + 'T00:00:00');
        const contiguous =
          prev !== null &&
          Math.round((d - prev) / 86400000) === 1;
        run = it.type === 'good' ? (contiguous ? run + 1 : 1) : 0;
        if (run > bestStreak) bestStreak = run;
        prev = d;
      });

      // 最近 14 天小格子
      const recent14 = [];
      const today = new Date();
      for (let i = 13; i >= 0; i--) {
        const d = new Date(today.getTime());
        d.setDate(today.getDate() - i);
        const key = fmtDate(d);
        const rec = map[key];
        recent14.push({
          date: key,
          dayNum: d.getDate(),
          emoji: rec ? (rec.type === 'good' ? '👍' : '👎') : '·',
          cls: rec ? (rec.type === 'good' ? 'cell-good' : 'cell-bad') : 'cell-none',
          isToday: i === 0,
        });
      }

      // 本月统计
      const monthPrefix = fmtDate(today).slice(0, 7);
      const monthName = today.getFullYear() + ' 年 ' + (today.getMonth() + 1) + ' 月';
      const monthGood = all.filter(
        (x) => x.date.indexOf(monthPrefix) === 0 && x.type === 'good'
      ).length;
      const monthBad = all.filter(
        (x) => x.date.indexOf(monthPrefix) === 0 && x.type === 'bad'
      ).length;

      const monthTotal = monthGood + monthBad;
      const monthGoodPct = monthTotal ? (monthGood * 100) / monthTotal : 0;
      const monthBadPct = monthTotal ? (monthBad * 100) / monthTotal : 0;

      let verdict = '还没开始记录';
      if (totalCount) {
        if (goodRate >= 90) verdict = '模范男友，无可挑剔 ✨';
        else if (goodRate >= 70) verdict = '表现优秀，继续保持 💕';
        else if (goodRate >= 50) verdict = '勉强及格，还需努力 🤔';
        else if (goodRate >= 30) verdict = '问题不少，注意整改 ⚠️';
        else verdict = '情况危急，速速反省 🚨';
      }

      this.setData(
        {
          ready: true,
          totalCount,
          goodCount,
          badCount: totalCount - goodCount,
          goodRate,
          goodStreak,
          bestStreak,
          recent14,
          monthGood,
          monthBad,
          monthGoodPct,
          monthBadPct,
          monthName,
          verdict,
        },
        () => this.drawRing(totalCount ? goodRate / 100 : 0)
      );
    } catch (e) {
      if (api.isBindingError(e)) {
        if (!this.bindingPrompted) {
          this.bindingPrompted = true;
          wx.showModal({
            title: '先完成双人绑定',
            content: '绑定后才能生成两个人的共同成绩单。',
            confirmText: '去绑定',
            confirmColor: '#ff6b81',
            success: (res) => {
              if (res.confirm) wx.navigateTo({ url: '/pages/bind/bind' });
            },
            complete: () => {
              this.bindingPrompted = false;
            },
          });
        }
      } else {
        wx.showToast({ title: '统计失败：' + (e.message || ''), icon: 'none' });
      }
    } finally {
      if (!isPullDown) wx.hideLoading();
      else wx.stopPullDownRefresh();
    }
  },

  // 环形好评率
  drawRing(percent) {
    const query = this.createSelectorQuery();
    query
      .select('#ring')
      .fields({ node: true, size: true })
      .exec((res) => {
        if (!res || !res[0] || !res[0].node) return;
        const node = res[0].node;
        const width = res[0].width;
        const height = res[0].height;
        const ctx = node.getContext('2d');
        const dpr = wx.getSystemInfoSync().pixelRatio || 2;
        node.width = width * dpr;
        node.height = height * dpr;
        ctx.scale(dpr, dpr);
        ctx.clearRect(0, 0, width, height);

        const cx = width / 2;
        const cy = height / 2;
        const r = width / 2 - 9;

        // 底环
        ctx.beginPath();
        ctx.arc(cx, cy, r, 0, Math.PI * 2);
        ctx.strokeStyle = '#f2dfe5';
        ctx.lineWidth = 14;
        ctx.lineCap = 'round';
        ctx.stroke();

        // 进度环
        if (percent > 0) {
          ctx.beginPath();
          ctx.arc(
            cx,
            cy,
            r,
            -Math.PI / 2,
            -Math.PI / 2 + Math.PI * 2 * Math.min(percent, 1)
          );
          ctx.strokeStyle = '#ff6b81';
          ctx.lineWidth = 14;
          ctx.lineCap = 'round';
          ctx.stroke();
        }
      });
  },

  // ---------- 图片成绩单 ----------

  makePoster() {
    if (!this.data.totalCount) {
      wx.showToast({ title: '还没有数据，先去评价吧', icon: 'none' });
      return;
    }
    wx.showLoading({ title: '生成中', mask: true });
    const W = 750;
    const H = 1200;
    const query = this.createSelectorQuery();
    query
      .select('#poster')
      .fields({ node: true, size: true })
      .exec((res) => {
        if (!res || !res[0] || !res[0].node) {
          wx.hideLoading();
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
    this.posterPath = path;
    wx.showActionSheet({
      itemList: ['保存到相册', '预览大图（可长按转发）'],
      success: (r) => {
        if (r.tapIndex === 0) this.savePoster(path);
        else wx.previewImage({ urls: [path] });
      },
    });
  },

  savePoster(path) {
    wx.saveImageToPhotosAlbum({
      filePath: path,
      success: () => wx.showToast({ title: '已保存到相册 💕', icon: 'none' }),
      fail: (e) => {
        if (/auth/i.test(e.errMsg || '')) {
          wx.showModal({
            title: '需要相册权限',
            content: '请允许保存图片到相册',
            confirmText: '去设置',
            success: (m) => {
              if (m.confirm) wx.openSetting();
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

    // 渐变背景
    const bg = ctx.createLinearGradient(0, 0, 0, H);
    bg.addColorStop(0, '#fff0f3');
    bg.addColorStop(1, '#ffd4dd');
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, W, H);

    // 白卡
    this.roundRect(ctx, 32, 32, W - 64, H - 64, 36);
    ctx.fillStyle = '#ffffff';
    ctx.fill();

    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    // 标题
    ctx.fillStyle = '#4a3540';
    ctx.font = 'bold 44px sans-serif';
    ctx.fillText('热念 · 男友表现成绩单', cx, 118);

    const now = new Date();
    const dateLabel =
      now.getFullYear() +
      '.' +
      pad(now.getMonth() + 1) +
      '.' +
      pad(now.getDate()) +
      '  ·  累计评价 ' +
      d.totalCount +
      ' 天';
    ctx.fillStyle = '#c0a8b0';
    ctx.font = '22px sans-serif';
    ctx.fillText(dateLabel, cx, 172);

    // 好评率环
    const ringY = 380;
    const ringR = 108;
    ctx.lineWidth = 16;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.arc(cx, ringY, ringR, 0, Math.PI * 2);
    ctx.strokeStyle = '#f2dfe5';
    ctx.stroke();

    const pct = Math.min(d.goodRate / 100, 1);
    if (pct > 0) {
      ctx.beginPath();
      ctx.arc(
        cx,
        ringY,
        ringR,
        -Math.PI / 2,
        -Math.PI / 2 + Math.PI * 2 * pct
      );
      ctx.strokeStyle = '#ff6b81';
      ctx.stroke();
    }

    ctx.fillStyle = '#ff6b81';
    ctx.font = 'bold 84px sans-serif';
    ctx.fillText(d.goodRate + '%', cx, ringY - 8);
    ctx.fillStyle = '#b08090';
    ctx.font = '22px sans-serif';
    ctx.fillText('好评率', cx, ringY + 52);

    // 评语胶囊
    ctx.font = 'bold 28px sans-serif';
    const verdict = d.verdict || '';
    const vw = ctx.measureText(verdict).width + 88;
    this.roundRect(ctx, cx - vw / 2, 528, vw, 66, 33);
    ctx.fillStyle = '#fff0f3';
    ctx.fill();
    ctx.fillStyle = '#4a3540';
    ctx.fillText(verdict, cx, 561);

    // KPI 三列
    const kpis = [
      [d.goodCount + ' 天', '好评'],
      [d.badCount + ' 天', '差评'],
      [d.goodStreak + ' 天', '连续好评'],
    ];
    const kx = [175, 375, 575];
    const kcolors = ['#ff6b81', '#90a4ae', '#ff8fab'];
    kpis.forEach((k, i) => {
      ctx.fillStyle = kcolors[i];
      ctx.font = 'bold 46px sans-serif';
      ctx.fillText(k[0], kx[i], 674);
      ctx.fillStyle = '#b08090';
      ctx.font = '22px sans-serif';
      ctx.fillText(k[1], kx[i], 722);
    });

    // 分隔线
    ctx.strokeStyle = '#faeef1';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(90, 784);
    ctx.lineTo(W - 90, 784);
    ctx.stroke();

    // 最近 14 天
    ctx.textAlign = 'left';
    ctx.fillStyle = '#4a3540';
    ctx.font = 'bold 26px sans-serif';
    ctx.fillText('最近 14 天', 90, 838);
    ctx.textAlign = 'center';

    const cell = 68;
    const gap = 12;
    const cols = 7;
    const totalW = cols * cell + (cols - 1) * gap;
    const leftTop = (W - totalW) / 2;
    const gridTop = 872;
    d.recent14.forEach((it, i) => {
      const col = i % cols;
      const row = Math.floor(i / cols);
      const x = leftTop + col * (cell + gap);
      const y = gridTop + row * (cell + gap);
      this.roundRect(ctx, x, y, cell, cell, 14);
      ctx.fillStyle =
        it.cls === 'cell-good'
          ? '#ffe3e8'
          : it.cls === 'cell-bad'
          ? '#eceff1'
          : '#faf3f5';
      ctx.fill();
      if (it.isToday) {
        this.roundRect(ctx, x + 1.5, y + 1.5, cell - 3, cell - 3, 13);
        ctx.strokeStyle = '#ff6b81';
        ctx.lineWidth = 3;
        ctx.stroke();
      }
      const midX = x + cell / 2;
      const midY = y + cell / 2;
      if (it.cls === 'cell-none') {
        ctx.fillStyle = '#d8c0c8';
        ctx.font = '24px sans-serif';
        ctx.fillText(String(it.dayNum), midX, midY);
      } else {
        ctx.font = '30px sans-serif';
        ctx.fillText(it.emoji, midX, midY);
      }
    });

    // 脚注
    ctx.strokeStyle = '#faeef1';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(90, 1072);
    ctx.lineTo(W - 90, 1072);
    ctx.stroke();

    ctx.fillStyle = '#d8c0c8';
    ctx.font = '22px sans-serif';
    ctx.fillText('热念 · 把每天的相处认真留住', cx, 1116);
  },
});
