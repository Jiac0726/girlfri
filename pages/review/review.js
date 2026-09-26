const api = require('../../services/cloud');
const view = require('../../services/entry-view');
Page(Object.assign({}, view.entryActions, {
  data: { loading: true, loadingMore: false, bindingStatus: 'loading', month: '', monthLabel: '', today: '', selectedDay: '', selectedDayLabel: '', days: [], totalEntries: 0, recordDays: 0, sharedDays: 0, entries: [], nextCursor: null, hasMore: false, error: '', busyEntryId: '' },
  onShow() { this._disposed = false; this.refresh(); },
  onUnload() { this._disposed = true; this._token = (this._token || 0) + 1; },
  async onPullDownRefresh() { try { await this.refresh(); } finally { wx.stopPullDownRefresh(); } },
  onReachBottom() { this.loadMore(); },
  changeMonth(e) {
    this.setData({ month: e.detail.value, selectedDay: '', selectedDayLabel: '' });
    this.refresh();
  },
  chooseDay(e) {
    const day = e.currentTarget.dataset.day;
    const next = this.data.selectedDay === day ? '' : day;
    this.setData({ selectedDay: next, selectedDayLabel: next ? Number(next.slice(8)) + '日' : '' });
    this.refresh();
  },
  clearDay() {
    if (!this.data.selectedDay) return;
    this.setData({ selectedDay: '', selectedDayLabel: '' });
    this.refresh();
  },
  async refresh() {
    const token = this._token = (this._token || 0) + 1;
    this.setData({ loading: true, loadingMore: false, error: '' });
    try {
      const session = await api.getSession();
      if (token !== this._token || this._disposed) return;
      if (this._scope !== (session.coupleId || '')) this.setData({ entries: [], days: [], nextCursor: null, hasMore: false, totalEntries: 0, recordDays: 0, sharedDays: 0 });
      this._scope = session.coupleId || '';
      const today = view.todayUTC8(session), month = this.data.month || today.slice(0, 7);
      this.setData({
        bindingStatus: session.bindingStatus,
        today,
        month,
        monthLabel: Number(month.slice(5, 7)) + '月',
        selectedDayLabel: this.data.selectedDay ? Number(this.data.selectedDay.slice(8)) + '日' : '',
      });
      if (session.bindingStatus !== 'active') { this.setData({ entries: [], days: [], hasMore: false, totalEntries: 0, recordDays: 0, sharedDays: 0 }); return; }
      const [stats, result] = await Promise.all([api.getEntryMonth(month), api.listEntries({ month, day: this.data.selectedDay || undefined, limit: 20 })]);
      if (token !== this._token || this._disposed) return;
      this._imageRetries = {};
      const days = (stats.days || []).map(day => Object.assign({}, day, { dayLabel: Number(day.date.slice(8)) + '日' }));
      this.setData(Object.assign({}, stats, {
        days,
        entries: view.viewEntries(result.items, today),
        nextCursor: result.nextCursor,
        hasMore: !!result.nextCursor,
      }));
    } catch (error) {
      if (token === this._token && !this._disposed) {
        this.setData({ error: error.message || '回顾加载失败' });
        if (api.isBindingError(error)) this.setData({ bindingStatus: 'unbound', entries: [], days: [], hasMore: false, totalEntries: 0, recordDays: 0, sharedDays: 0 });
      }
    }
    finally { if (token === this._token && !this._disposed) this.setData({ loading: false }); }
  },
  async loadMore() {
    if (this.data.loading || this.data.loadingMore || !this.data.hasMore) return;
    const token = this._token; this.setData({ loadingMore: true });
    try {
      const result = await api.listEntries({ month: this.data.month, day: this.data.selectedDay || undefined, cursor: this.data.nextCursor, limit: 20 });
      if (token === this._token && !this._disposed) this.setData({ entries: view.appendEntries(this.data.entries, view.viewEntries(result.items, this.data.today)), nextCursor: result.nextCursor, hasMore: !!result.nextCursor });
    } catch (error) { if (token === this._token && !this._disposed) this.setData({ error: error.message || '加载失败，请重试' }); }
    finally { if (token === this._token && !this._disposed) this.setData({ loadingMore: false }); }
  },
  afterEntryDeleted() { return this.refresh(); },
  goBind() { wx.navigateTo({ url: '/pages/bind/bind' }); },
}));
