const app = getApp();
const api = require('../../services/cloud');

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
    type: '',
    reason: '',
    submitted: false,
    loading: false,
    authLoading: true,
    bindingStatus: 'loading',
    canRate: false,
    partnerRating: null,
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
    this.refreshSession();
  },

  async refreshSession() {
    this.setData({ authLoading: true });
    try {
      const session = await api.getSession();
      const active = session.bindingStatus === 'active';
      this.setData({
        authLoading: false,
        bindingStatus: session.bindingStatus || 'unbound',
        canRate: active,
      });

      if (active) {
        await this.loadToday();
      } else {
        this.setData({
          type: '',
          reason: '',
          submitted: false,
          partnerRating: null,
        });
      }
    } catch (e) {
      this.setData({ authLoading: false, bindingStatus: 'error' });
      wx.showToast({ title: e.message || '身份加载失败', icon: 'none' });
    }
  },

  async loadToday() {
    try {
      const data = await api.getToday();
      const doc = data.rating || {};
      this.setData({
        dateStr: data.date || this.data.dateStr,
        type: doc.type || '',
        reason: doc.reason || '',
        submitted: !!doc.type,
        canRate: !!data.canRate,
        partnerRating: data.partnerRating || null,
      });
    } catch (e) {
      if (api.isBindingError(e)) {
        this.setData({
          bindingStatus: 'unbound',
          type: '',
          reason: '',
          submitted: false,
          canRate: false,
          partnerRating: null,
        });
        return;
      }
      wx.showToast({ title: e.message || '加载失败', icon: 'none' });
    }
  },

  goBind() {
    wx.navigateTo({ url: '/pages/bind/bind' });
  },

  goPermissions() {
    if (this.data.bindingStatus !== 'active') {
      this.goBind();
      return;
    }
    wx.navigateTo({ url: '/pages/permissions/permissions' });
  },

  selectGood() {
    if (!this.data.canRate) return;
    this.setData({ type: app.globalData.GOOD });
  },

  selectBad() {
    if (!this.data.canRate) return;
    this.setData({ type: app.globalData.BAD });
  },

  onReasonInput(e) {
    if (!this.data.canRate) return;
    this.setData({ reason: e.detail.value });
  },

  async submit() {
    if (!this.data.canRate || !this.data.type || this.data.loading) return;
    this.setData({ loading: true });
    wx.showLoading({ title: '提交中', mask: true });

    try {
      const data = await api.saveToday(this.data.type, this.data.reason);
      const rating = data.rating || {};
      this.setData({
        dateStr: data.date || this.data.dateStr,
        type: rating.type || this.data.type,
        reason: rating.reason || '',
        submitted: true,
      });
      wx.showToast({
        title: this.data.type === 'good' ? '给 TA 的好评已记录 💕' : '给 TA 的差评已记录 🥺',
        icon: 'none',
      });
    } catch (e) {
      wx.showToast({ title: e.message || '提交失败', icon: 'none' });
    } finally {
      wx.hideLoading();
      this.setData({ loading: false });
    }
  },
});
