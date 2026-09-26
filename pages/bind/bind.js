const api = require('../../services/cloud');

function normalizeInviteCode(value) {
  return String(value || '').toUpperCase().replace(/[^A-Z2-9]/g, '').slice(0, 8);
}
function formatExpire(value) {
  if (!value) return '';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n) => (n < 10 ? '0' + n : '' + n);
  return pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
}

Page({
  data: { loading: true, bindingStatus: 'loading', errorMessage: '', inviteCode: '', inviteExpiresText: '', joinCode: '', isCreator: false, openedFromInvite: false, manualJoin: false },
  onLoad(options) {
    const code = normalizeInviteCode(options && options.inviteCode);
    if (code.length === 8) this.setData({ joinCode: code, openedFromInvite: true });
  },
  onShow() { this.refresh(); },
  async onPullDownRefresh() {
    try { if (!this.data.loading) await this.refresh(); }
    finally { wx.stopPullDownRefresh(); }
  },
  retrySession() { if (!this.data.loading) return this.refresh(); },
  onShareAppMessage() {
    const code = this.data.inviteCode;
    return { title: code ? '我想和你一起记录「热念」💕 点开接受我的邀请' : '来和我一起用「热念」💕', path: code ? '/pages/bind/bind?inviteCode=' + encodeURIComponent(code) + '&source=wechat_invite' : '/pages/bind/bind' };
  },
  async refresh(showToast) {
    const request = this._sessionRequest = (this._sessionRequest || 0) + 1;
    this.setData({ loading: true, errorMessage: '' });
    try { const session = await api.getSession(); if (request !== this._sessionRequest) return; this.applySession(session); if (showToast) wx.showToast({ title: '状态已刷新', icon: 'none' }); }
    catch (e) { if (request === this._sessionRequest) this.setData({ bindingStatus: 'error', errorMessage: '暂时无法获取绑定状态，请检查网络后重试。' }); }
    finally { if (request === this._sessionRequest) this.setData({ loading: false }); }
  },
  applySession(session) {
    const status = session.bindingStatus || (session.bound ? 'active' : 'unbound');
    this.setData({ bindingStatus: status, inviteCode: session.inviteCode || '', inviteExpired: !!session.inviteExpired, inviteExpiresText: formatExpire(session.inviteExpiresAt), isCreator: !!session.isCreator });
  },
  showManualJoin() { this.setData({ manualJoin: true }); },
  onJoinInput(e) { this.setData({ joinCode: normalizeInviteCode(e.detail.value) }); },
  useOtherCode() { this.setData({ openedFromInvite: false, manualJoin: true, joinCode: '' }); },
  async createInvite() {
    if (this.data.loading) return;
    this.setData({ loading: true }); wx.showLoading({ title: '生成中', mask: true });
    try { const session = await api.createInvite(); this.applySession(session); }
    catch (e) { wx.showToast({ title: e.message || '生成失败', icon: 'none' }); }
    finally { wx.hideLoading(); this.setData({ loading: false }); }
  },
  async joinPair() {
    if (this.data.loading) return;
    const code = normalizeInviteCode(this.data.joinCode);
    if (code.length !== 8) return wx.showToast({ title: '请输入 8 位绑定码', icon: 'none' });
    if (this.data.bindingStatus === 'waiting') {
      this.setData({ loading: true });
      const confirmed = await new Promise(resolve => wx.showModal({ title: '接受 TA 的邀请？', content: '绑定成功后，你之前发出的邀请将失效。如果绑定失败，原邀请会保留。', success: result => resolve(result.confirm), fail: () => resolve(false) }));
      this.setData({ loading: false });
      if (!confirmed) return;
    }
    this.setData({ loading: true }); wx.showLoading({ title: '绑定中', mask: true });
    try { const session = await api.joinPair(code); this.applySession(session); wx.showToast({ title: '绑定成功 💕', icon: 'none' }); }
    catch (e) { wx.showToast({ title: e.message || '绑定失败', icon: 'none' }); }
    finally { wx.hideLoading(); this.setData({ loading: false }); }
  },
  copyCode() { if (this.data.inviteCode && !this.data.inviteExpired) wx.setClipboardData({ data: this.data.inviteCode }); },
  async refreshInvite() {
    if (this.data.loading) return;
    this.setData({ loading: true });
    try { const session = await api.refreshInvite(); this.applySession(session); wx.showToast({ title: '绑定码已更新', icon: 'none' }); }
    catch (e) { wx.showToast({ title: e.message || '更新失败', icon: 'none' }); }
    finally { this.setData({ loading: false }); }
  },
  cancelInvite() {
    if (this.data.loading) return;
    this.setData({ loading: true });
    wx.showModal({ title: '取消这次邀请？', content: '取消后当前邀请和绑定码都会立即失效。', confirmColor: '#f05b72',
      success: async (res) => { if (!res.confirm) { this.setData({ loading: false }); return; } try { wx.showLoading({ title: '处理中', mask: true }); const session = await api.cancelInvite(); this.applySession(session); } catch (e) { wx.showToast({ title: e.message || '取消失败', icon: 'none' }); } finally { wx.hideLoading(); this.setData({ loading: false }); } },
      fail: () => this.setData({ loading: false })
    });
  },
  backHome() { wx.switchTab({ url: '/pages/index/index' }); }
});
