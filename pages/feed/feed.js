const api = require('../../services/cloud');
const view = require('../../services/entry-view');
const drafts = require('../../services/entry-drafts');

Page(Object.assign({}, view.entryActions, {
  data: {
    authLoading: true,
    loading: false,
    loadingMore: false,
    bindingStatus: 'loading',
    entries: [],
    nextCursor: null,
    hasMore: false,
    error: '',
    moreError: '',
    busyEntryId: '',
    today: '',
    dateLabel: '',
  },

  onShow() {
    this._disposed = false;
    this.refresh();
  },

  onUnload() {
    this._disposed = true;
    this._listToken = (this._listToken || 0) + 1;
  },

  onPullDownRefresh() {
    this.refresh(true);
  },

  onReachBottom() {
    this.loadMore();
  },

  async refresh(pull) {
    const token = this._listToken = (this._listToken || 0) + 1;
    this.setData({ authLoading: true, loading: true, loadingMore: false, error: '', moreError: '' });

    try {
      const session = await api.getSession();
      if (token !== this._listToken || this._disposed) return;

      const active = session.bindingStatus === 'active';
      const scope = active ? session.coupleId : '';
      drafts.activate(scope || '');
      if (scope !== this._scope) {
        this.setData({ entries: [], nextCursor: null, hasMore: false });
      }
      this._scope = scope;

      const today = view.todayUTC8(session);
      this.setData({
        authLoading: false,
        bindingStatus: session.bindingStatus || 'unbound',
        today,
        dateLabel: Number(today.slice(5, 7)) + '月' + Number(today.slice(8)) + '日',
      });

      if (!active) {
        this.setData({ entries: [], nextCursor: null, hasMore: false });
        return;
      }
      if (!scope) throw new Error('关系资料未就绪，请重试');

      const result = await api.listEntries({ limit: 20 });
      if (token !== this._listToken || this._disposed) return;
      this._imageRetries = {};
      this.setData({
        entries: view.viewEntries(result.items, today),
        nextCursor: result.nextCursor || null,
        hasMore: !!result.nextCursor,
      });
    } catch (error) {
      if (token !== this._listToken || this._disposed) return;
      if (api.isBindingError(error)) {
        this._scope = '';
        drafts.activate('');
        this.setData({ bindingStatus: 'unbound', entries: [], hasMore: false, nextCursor: null });
      } else {
        this.setData({ error: error.message || '日常没有加载出来，请重试' });
      }
    } finally {
      if (token === this._listToken && !this._disposed) {
        this.setData({ authLoading: false, loading: false });
      }
      if (pull) wx.stopPullDownRefresh();
    }
  },

  async loadMore() {
    if (this.data.loading || this.data.authLoading || this.data.loadingMore || !this.data.hasMore) return;
    const token = this._listToken;
    const cursor = this.data.nextCursor;
    this.setData({ loadingMore: true, moreError: '' });

    try {
      const result = await api.listEntries({ cursor, limit: 20 });
      if (token !== this._listToken || this._disposed) return;
      this.setData({
        entries: view.appendEntries(this.data.entries, view.viewEntries(result.items, this.data.today)),
        nextCursor: result.nextCursor || null,
        hasMore: !!result.nextCursor,
      });
    } catch (error) {
      if (token === this._listToken && !this._disposed) {
        this.setData({ moreError: error.message || '加载更多失败，请重试' });
      }
    } finally {
      if (token === this._listToken && !this._disposed) this.setData({ loadingMore: false });
    }
  },

  retry() {
    this.refresh();
  },

  afterEntryDeleted() {
    return this.refresh();
  },

  writeEntry() {
    if (!this.data.loading && !this.data.authLoading && this.data.bindingStatus === 'active' && this._scope) {
      wx.navigateTo({ url: '/pages/entry/entry' });
    }
  },

  goBind() {
    wx.navigateTo({ url: '/pages/bind/bind' });
  },
}));
