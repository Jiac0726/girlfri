const api = require('../../services/cloud');
const view = require('../../services/entry-view');
const drafts = require('../../services/entry-drafts');

Page({
  data: {
    authLoading: true,
    loading: false,
    bindingStatus: 'loading',
    error: '',
    today: '',
    dateLabel: '',
    weekday: '',
    ratings: view.RATINGS,
    recentDays: [],
    monthLabel: '',
    totalEntries: 0,
    recordDays: 0,
    sharedDays: 0,
    todayEntries: 0,
    missCount: 0,
    missSending: false,
  },

  onShow() {
    this._disposed = false;
    this.refresh();
  },

  onUnload() {
    this._disposed = true;
    this._token = (this._token || 0) + 1;
  },

  onPullDownRefresh() {
    this.refresh(true);
  },

  async refresh(pull) {
    const token = this._token = (this._token || 0) + 1;
    this.setData({ authLoading: true, loading: true, error: '' });

    try {
      const session = await api.getSession();
      if (token !== this._token || this._disposed) return;

      const active = session.bindingStatus === 'active';
      const scope = active ? session.coupleId : '';
      drafts.activate(scope || '');
      this._scope = scope;

      const today = view.todayUTC8(session);
      const month = today.slice(0, 7);
      this.setData({
        authLoading: false,
        bindingStatus: session.bindingStatus || 'unbound',
        today,
        dateLabel: Number(today.slice(5, 7)) + '月' + Number(today.slice(8)) + '日',
        weekday: ['星期日','星期一','星期二','星期三','星期四','星期五','星期六'][new Date(today + 'T00:00:00Z').getUTCDay()],
        monthLabel: Number(today.slice(5, 7)) + '月',
        missCount: Math.max(0, Number(session.missCount || 0)),
      });

      if (!active) {
        this.setData({ totalEntries: 0, recordDays: 0, sharedDays: 0, todayEntries: 0, recentDays: [] });
        return;
      }
      if (!scope) throw new Error('关系资料未就绪，请重试');

      const stats = await api.getEntryMonth(month);
      if (token !== this._token || this._disposed) return;
      const todayStat = (stats.days || []).find(day => day.date === today);
      // Only show dates in the month covered by this summary.
      const recorded = new Set((stats.days || []).filter(day => day.count > 0).map(day => day.date));
      const recentDays = [];
      for (let day = Math.max(1, Number(today.slice(8)) - 6); day <= Number(today.slice(8)); day++) {
        const date = month + '-' + String(day).padStart(2, '0');
        recentDays.push({ date, label: day + '日', recorded: recorded.has(date) });
      }
      this.setData({
        recentDays,
        totalEntries: Number(stats.totalEntries || 0),
        recordDays: Number(stats.recordDays || 0),
        sharedDays: Number(stats.sharedDays || 0),
        todayEntries: todayStat ? Number(todayStat.count || 0) : 0,
      });
    } catch (error) {
      if (token !== this._token || this._disposed) return;
      if (api.isBindingError(error)) {
        this._scope = '';
        drafts.activate('');
        this.setData({
          bindingStatus: 'unbound',
          totalEntries: 0,
          recordDays: 0,
          sharedDays: 0,
          todayEntries: 0,
          missCount: 0,
        });
      } else {
        this.setData({ error: error.message || '日常概览没有加载出来，请重试' });
      }
    } finally {
      if (token === this._token && !this._disposed) {
        this.setData({ authLoading: false, loading: false });
      }
      if (pull) wx.stopPullDownRefresh();
    }
  },

  retry() {
    this.refresh();
  },

  async sendMiss() {
    if (this.data.loading || this.data.authLoading || this.data.missSending || this.data.bindingStatus !== 'active' || !this._scope) return;
    const payload = this._missPending || { requestId: api.newRequestId() };
    this._missPending = payload;
    this.setData({ missSending: true });
    try {
      const result = await api.sendMiss(payload);
      this._missPending = null;
      wx.showToast({
        title: result && result.notified
          ? '想念送达，已即时提醒 TA ♡'
          : '想念送达，未发送微信即时提醒',
        icon: 'none',
      });
    } catch (error) {
      if (!view.isUncertain(error)) this._missPending = null;
      wx.showToast({ title: error.message || '这次想念没送出去', icon: 'none' });
    } finally {
      if (!this._disposed) this.setData({ missSending: false });
    }
  },

  writeEntry() {
    if (!this.data.loading && !this.data.authLoading && this.data.bindingStatus === 'active' && this._scope) {
      wx.navigateTo({ url: '/pages/entry/entry' });
    }
  },

  startRating(e) {
    const type = e.currentTarget.dataset.type;
    if (!view.RATINGS.some(item => item.type === type) || this.data.loading || this.data.authLoading || this.data.bindingStatus !== 'active' || !this._scope) return;
    wx.navigateTo({ url: '/pages/entry/entry?rating=' + type });
  },

  goDailyFeed() {
    if (!this.data.loading && !this.data.authLoading && this.data.bindingStatus === 'active' && this._scope) {
      wx.navigateTo({ url: '/pages/feed/feed' });
    }
  },

  goBind() {
    wx.navigateTo({ url: '/pages/bind/bind' });
  },

  goProfile() {
    wx.switchTab({ url: '/pages/profile/profile' });
  },
});
