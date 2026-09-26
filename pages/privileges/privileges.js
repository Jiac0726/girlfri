const api = require('../../services/cloud');
const h = require('../../helpers/interactions');
const labels = { available: '可以申请兑现', requested: '等待赠送方确认', used: '已兑现', revoked: '已撤回', rejected: '未同意', cancelled: '申请已撤销' };
function present(x) { return Object.assign({}, x, { statusLabel: labels[x.status] || x.status, createdLabel: h.dateLabel(x.createdAt) }); }
Page({
  data: { loading: false, saving: false, busyId: '', title: '', note: '', items: [], nextCursor: '', error: '', bindingRequired: false, uncertain: false, historyId: '', history: [], historyCursor: '', historyLoading: false, historyError: '' },
  onShow() { this.load(); },
  onUnload() { this._disposed = true; this._token = (this._token || 0) + 1; this._historyToken = (this._historyToken || 0) + 1; },
  async onPullDownRefresh() { try { await this.load(); } finally { wx.stopPullDownRefresh(); } },
  async load(append) {
    append = append === true;
    if (append && (this.data.loading || !this.data.nextCursor)) return;
    const token = this._token = (this._token || 0) + 1;
    this.setData({ loading: true, error: '' });
    try {
      const result = await api.listCoupons({ cursor: append ? this.data.nextCursor : undefined, limit: 20 });
      if (token !== this._token) return;
      this.setData({ items: append ? h.mergeItems(this.data.items, result.items.map(present)) : result.items.map(present), nextCursor: result.nextCursor || '', bindingRequired: false });
    } catch (error) {
      if (token !== this._token) return;
      this.setData({ error: error.message || '加载失败，请重试', bindingRequired: api.isBindingError(error) });
      if (api.isBindingError(error)) this.setData({ items: [], nextCursor: '' });
    } finally { if (token === this._token) this.setData({ loading: false }); }
  },
  loadMore() { return this.load(true); },
  goBind() { wx.navigateTo({ url: '/pages/bind/bind' }); },
  onTitle(e) { if (!this.data.saving && !this.data.uncertain) this.setData({ title: e.detail.value }); },
  onNote(e) { if (!this.data.saving && !this.data.uncertain) this.setData({ note: e.detail.value }); },
  async gift() {
    if (this.data.saving || this.data.busyId || this.data.bindingRequired) return;
    if (!this._gift && !this.data.title.trim()) return wx.showToast({ title: '给这张券起个名字', icon: 'none' });
    this.setData({ saving: true });
    try {
      if (!this._gift) {
        if (!await h.confirmAction('把这张心意券送给 TA？', 'TA 申请兑现后，还需要你确认。', '赠送')) return;
        this._gift = { requestId: api.newRequestId(), title: this.data.title.trim(), note: this.data.note.trim() };
      }
      await api.giftCoupon(this._gift); this._gift = null;
      this.setData({ title: '', note: '', uncertain: false }); await this.load();
      wx.showToast({ title: '已送给 TA', icon: 'none' });
    } catch (error) {
      const uncertain = h.isUncertain(error);
      if (!uncertain) this._gift = null;
      this.setData({ uncertain, error: uncertain ? '赠送结果待确认，请重试确认，避免重复赠送。' : error.message });
    } finally { if (!this._disposed) this.setData({ saving: false }); }
  },
  async act(e) {
    if (this.data.busyId || this.data.saving) return;
    const { id, action } = e.currentTarget.dataset;
    const item = this.data.items.find(x => x.id === id);
    if (!item) return;
    const allowed = action === 'request' ? item.receivedByMe && item.status === 'available' :
      action === 'revoke' ? item.fromMe && item.status === 'available' :
      action === 'cancel' ? item.receivedByMe && item.status === 'requested' :
      ['accept','reject'].includes(action) && item.fromMe && item.status === 'requested';
    if (!allowed) return;
    const titles = { request: '申请兑现这张券？', revoke: '撤回这张券？', cancel: '撤销兑现申请？', accept: '确认已兑现这张券？', reject: '暂不同意兑现？' };
    const content = { request: 'TA 确认后才算兑现。', revoke: '撤回后 TA 将不能再使用。', cancel: '这张券会恢复为可申请状态。', accept: '确认后将记为已兑现，不能再次使用。', reject: '这张券会恢复为可申请状态，可商量后重新申请。' };
    this.setData({ busyId: id });
    const payload = { id, expectedVersion: item.version };
    const key = action + ':' + JSON.stringify(payload);
    try {
      if (!await h.confirmAction(titles[action], content[action])) return;
      payload.requestId = h.requestIdFor(this, key, api);
      if (action === 'request') await api.requestCoupon(payload);
      else if (action === 'revoke') await api.revokeCoupon(payload);
      else if (action === 'cancel') await api.cancelCouponRequest(payload);
      else await api.respondCoupon(Object.assign(payload, { decision: action }));
      h.clearRequestId(this, key); await this.load();
      if (this.data.historyId === id) await this.loadHistory();
    } catch (error) {
      this.setData({ error: error.message || '操作结果未确认，请重试' });
      if (!h.isUncertain(error)) { h.clearRequestId(this, key); await this.load(); }
    } finally { if (!this._disposed) this.setData({ busyId: '' }); }
  },
  showHistory(e) { this.setData({ historyId: e.currentTarget.dataset.id, history: [], historyCursor: '', historyError: '' }); this.loadHistory(); },
  closeHistory() { this._historyToken = (this._historyToken || 0) + 1; this.setData({ historyId: '', historyLoading: false }); },
  async loadHistory(append) {
    append = append === true;
    if (!this.data.historyId || (append && (this.data.historyLoading || !this.data.historyCursor))) return;
    const token = this._historyToken = (this._historyToken || 0) + 1;
    this.setData({ historyLoading: true, historyError: '' });
    try {
      const result = await api.getCouponHistory({ id: this.data.historyId, cursor: append ? this.data.historyCursor : undefined, limit: 20 });
      if (token !== this._historyToken) return;
      this.setData({ history: append ? h.mergeItems(this.data.history, result.items.map(present)) : result.items.map(present), historyCursor: result.nextCursor || '' });
    } catch (error) { if (token === this._historyToken) this.setData({ historyError: error.message || '历史加载失败' }); }
    finally { if (token === this._historyToken) this.setData({ historyLoading: false }); }
  },
  moreHistory() { this.loadHistory(true); },
});
