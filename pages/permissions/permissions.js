const api = require('../../services/cloud');
const helpers = require('../../helpers/interactions');
const PRESETS = [
  { title: '周末一起散步', content: '周末选一个双方方便的时间，放下手机一起散步。' },
  { title: '每周留一顿饭给彼此', content: '每周一起好好吃一顿饭，时间和地点提前商量。' },
  { title: '争执时先暂停一下', content: '情绪上来时可以先暂停，等彼此准备好再继续聊。' },
];
const LABELS = { pending: '等待回应', active: '共同生效', rejected: '未接受', withdrawn: '已撤回', superseded: '已被新版替换', ended: '已结束' };
function viewAgreement(item) {
  return Object.assign({}, item, {
    statusLabel: LABELS[item.status] || item.status,
    createdLabel: helpers.dateLabel(item.createdAt), updatedLabel: helpers.dateLabel(item.updatedAt),
    directionLabel: item.fromMe ? '我发起的' : 'TA 发起的',
    canRespond: item.status === 'pending' && !item.fromMe,
    canWithdraw: item.status === 'pending' && item.fromMe,
    canRevise: item.status === 'active', canEnd: item.status === 'active',
  });
}
Page({
  data: {
    loading: false, saving: false, busyId: '', ready: false, loadError: '', bindingRequired: false,
    presets: PRESETS, title: '', content: '', replacesId: '', expectedVersion: null, editUnavailable: false,
    items: [], pendingItems: [], activeItems: [], historyItems: [], nextCursor: '', uncertain: false,
  },
  onShow() { return this.loadAgreements(); },
  async onPullDownRefresh() { try { await this.loadAgreements(); } finally { wx.stopPullDownRefresh(); } },
  onUnload() { this._listRequest = (this._listRequest || 0) + 1; },
  async loadAgreements(append) {
    append = append === true;
    if (append && (this.data.loading || !this.data.nextCursor)) return;
    const request = this._listRequest = (this._listRequest || 0) + 1;
    this.setData({ loading: true, loadError: '' });
    try {
      const result = await api.listAgreements({ cursor: append ? this.data.nextCursor : undefined, limit: 20 });
      if (request !== this._listRequest) return;
      const incoming = (result.items || []).map(viewAgreement);
      const items = append ? helpers.mergeItems(this.data.items, incoming) : incoming;
      this.setData({ items, pendingItems: items.filter(x => x.status === 'pending'), activeItems: items.filter(x => x.status === 'active'),
        historyItems: items.filter(x => x.status !== 'pending' && x.status !== 'active'), nextCursor: result.nextCursor || '',
        ready: true, bindingRequired: false });
    } catch (error) {
      if (request !== this._listRequest) return;
      const bindingRequired = api.isBindingError(error);
      this.setData({ loadError: bindingRequired ? '绑定后才能和 TA 讨论共同约定。' : (error.message || '约定加载失败，请重试'), bindingRequired });
      if (bindingRequired) this.setData({ items: [], pendingItems: [], activeItems: [], historyItems: [], nextCursor: '', ready: false });
    } finally {
      if (request === this._listRequest) this.setData({ loading: false });
    }
  },
  loadMore() { return this.loadAgreements(true); },
  retryLoad() { return this.loadAgreements(); },
  goBind() { wx.navigateTo({ url: '/pages/bind/bind' }); },
  onTitleInput(event) { if (!this.data.saving && !this.data.uncertain) this.setData({ title: event.detail.value }); },
  onContentInput(event) { if (!this.data.saving && !this.data.uncertain) this.setData({ content: event.detail.value }); },
  choosePreset(event) {
    if (this.data.saving || this.data.uncertain) return;
    const item = PRESETS[Number(event.currentTarget.dataset.index)];
    if (item) this.setData({ title: item.title, content: item.content });
  },
  startRevision(event) {
    if (this.data.saving || this.data.busyId || this.data.uncertain) return;
    const item = this.data.items.find(row => row.id === event.currentTarget.dataset.id);
    if (!item || !item.canRevise) return;
    this.setData({ title: item.title, content: item.content || '', replacesId: item.id, expectedVersion: item.version, editUnavailable: false });
    wx.pageScrollTo({ scrollTop: 0, duration: 200 });
  },
  cancelEdit() {
    if (this.data.saving || this.data.uncertain) return;
    this.setData({ title: '', content: '', replacesId: '', expectedVersion: null, editUnavailable: false });
  },
  async submitAgreement() {
    if (this.data.saving || this.data.busyId || this.data.bindingRequired || this.data.editUnavailable) return;
    const title = String(this.data.title || '').trim(), content = String(this.data.content || '').trim();
    if (!title || !content) return wx.showToast({ title: '写下约定名称和具体内容', icon: 'none' });
    let payload = { title, content };
    if (this.data.replacesId) Object.assign(payload, { replacesId: this.data.replacesId, expectedVersion: this.data.expectedVersion });
    if (this._pendingProposal) payload = this._pendingProposal;
    const key = 'propose:' + JSON.stringify(payload);
    this.setData({ saving: true });
    try {
      if (!this._pendingProposal && !await helpers.confirmAction('发起这份共同约定？', '发起代表你已同意这些内容。TA 接受后才会共同生效。' + (payload.replacesId ? ' 等待期间，原约定继续有效。' : ''), '发起约定')) return;
      this._pendingProposal = payload;
      await api.proposeAgreement(Object.assign({ requestId: helpers.requestIdFor(this, key, api) }, payload));
      helpers.clearRequestId(this, key);
      this._pendingProposal = null;
      this.setData({ title: '', content: '', replacesId: '', expectedVersion: null, editUnavailable: false, uncertain: false });
      await this.loadAgreements();
      wx.showToast({ title: '已发起，等待 TA 回应', icon: 'none' });
    } catch (error) {
      const uncertain = helpers.isUncertain(error);
      if (!uncertain) this._pendingProposal = null;
      this.setData({ uncertain });
      await this.handleMutationError(error, payload.replacesId);
    } finally { this.setData({ saving: false }); }
  },
  async handleMutationError(error, editingId) {
    if (helpers.isConflict(error)) {
      await this.loadAgreements();
      if (editingId) {
        const latest = this.data.items.find(item => item.id === editingId);
        if (latest && latest.status === 'active') this.setData({ expectedVersion: latest.version });
        else this.setData({ editUnavailable: true });
      }
      wx.showToast({ title: '状态已更新，内容已保留，请确认后再试', icon: 'none' });
    } else {
      wx.showToast({ title: error.message || '操作未完成，请重试', icon: 'none' });
      if (api.isBindingError(error)) await this.loadAgreements();
    }
  },
  async agreementAction(event) {
    if (this.data.busyId || this.data.saving) return;
    const { id, action } = event.currentTarget.dataset;
    const item = this.data.items.find(row => row.id === id);
    if (!item) return;
    const allowed = (action === 'accept' || action === 'reject') ? item.canRespond : action === 'withdraw' ? item.canWithdraw : action === 'end' && item.canEnd;
    if (!allowed) return;
    const copy = {
      accept: ['接受这份约定？', '你和 TA 都同意后，约定将共同生效。' + (item.replacesId ? '它将替换原来的版本。' : ''), '接受约定'],
      reject: ['暂不接受这份约定？', 'TA 会看到你的回应，你们可以讨论后重新发起。', '暂不接受'],
      withdraw: ['撤回这份提议？', 'TA 将不能再接受这份提议。已有的生效版本不会改变。', '撤回'],
      end: ['结束这份约定？', '结束后对双方都不再生效，历史内容会保留。', '结束约定'],
    }[action];
    this.setData({ busyId: id });
    const payload = { id, expectedVersion: item.version };
    const key = action + ':' + JSON.stringify(payload);
    try {
      if (!await helpers.confirmAction(copy[0], copy[1], copy[2])) return;
      payload.requestId = helpers.requestIdFor(this, key, api);
      if (action === 'accept' || action === 'reject') await api.respondAgreement(Object.assign(payload, { decision: action }));
      else if (action === 'withdraw') await api.withdrawAgreement(payload);
      else await api.endAgreement(payload);
      helpers.clearRequestId(this, key);
      await this.loadAgreements();
      wx.showToast({ title: '约定状态已更新', icon: 'none' });
    } catch (error) { await this.handleMutationError(error); }
    finally { this.setData({ busyId: '' }); }
  },
});
