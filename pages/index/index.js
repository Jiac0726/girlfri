const app = getApp();

const WEEKS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
const pad = (n) => (n < 10 ? '0' + n : '' + n);
const fmtDate = (d) =>
  d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());

Page({
  data: {
    dateStr: '',
    dayNum: '',
    yearMonth: '',
    weekDay: '',
    type: '', // 'good' | 'bad'
    reason: '',
    submitted: false,
    loading: false,
  },

  onLoad() {
    const now = new Date();
    this.setData({
      dateStr: fmtDate(now),
      dayNum: pad(now.getDate()),
      yearMonth: now.getFullYear() + '.' + pad(now.getMonth() + 1),
      weekDay: WEEKS[now.getDay()],
    });
  },

  onShow() {
    this.loadToday();
  },

  // 查询今天是否已经评价过
  async loadToday() {
    try {
      const db = wx.cloud.database();
      const res = await db
        .collection(app.globalData.COLLECTION)
        .doc(this.data.dateStr)
        .get();
      const doc = res.data || {};
      this.setData({
        type: doc.type || '',
        reason: doc.reason || '',
        submitted: !!doc.type,
      });
    } catch (e) {
      // 文档不存在 = 今天还没评价（-1 为 document not found）
      this.setData({ type: '', reason: '', submitted: false });
    }
  },

  selectGood() {
    this.setData({ type: app.globalData.GOOD });
  },

  selectBad() {
    this.setData({ type: app.globalData.BAD });
  },

  onReasonInput(e) {
    this.setData({ reason: e.detail.value });
  },

  // 提交/覆盖今天的评价：用日期当 _id，天然保证一天只有一条
  async submit() {
    if (!this.data.type || this.data.loading) return;
    this.setData({ loading: true });
    wx.showLoading({ title: '提交中', mask: true });
    try {
      const db = wx.cloud.database();
      await db.collection(app.globalData.COLLECTION).doc(this.data.dateStr).set({
        data: {
          date: this.data.dateStr,
          type: this.data.type,
          reason: this.data.reason.trim(),
          updatedAt: db.serverDate(),
        },
      });
      wx.hideLoading();
      wx.showToast({
        title: this.data.type === 'good' ? '好评收到 💕' : '差评已记录 🥺',
        icon: 'none',
      });
      this.setData({ submitted: true });
    } catch (e) {
      wx.hideLoading();
      wx.showToast({
        title: '提交失败：' + (e.errMsg || e.message || '未知错误'),
        icon: 'none',
      });
    } finally {
      this.setData({ loading: false });
    }
  },
});
