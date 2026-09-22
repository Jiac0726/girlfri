const api = require('../../services/cloud');

function formatExpire(value) {
  if (!value) return '';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n) => (n < 10 ? '0' + n : '' + n);
  return (
    pad(d.getMonth() + 1) +
    '-' +
    pad(d.getDate()) +
    ' ' +
    pad(d.getHours()) +
    ':' +
    pad(d.getMinutes())
  );
}

Page({
  data: {
    loading: true,
    bindingStatus: 'loading',
    inviteCode: '',
    inviteExpiresText: '',
    joinCode: '',
    isCreator: false,
  },

  onShow() {
    this.refresh();
  },

  async refresh(showToast) {
    this.setData({ loading: true });
    try {
      const session = await api.getSession();
      this.applySession(session);
      if (showToast) wx.showToast({ title: '状态已刷新', icon: 'none' });
    } catch (e) {
      wx.showToast({ title: e.message || '加载失败', icon: 'none' });
    } finally {
      this.setData({ loading: false });
    }
  },

  applySession(session) {
    const status = session.bindingStatus || (session.bound ? 'active' : 'unbound');
    this.setData({
      bindingStatus: status,
      inviteCode: session.inviteCode || '',
      inviteExpiresText: formatExpire(session.inviteExpiresAt),
      isCreator: !!session.isCreator,
    });
  },

  onJoinInput(e) {
    const value = String(e.detail.value || '')
      .toUpperCase()
      .replace(/[^A-Z2-9]/g, '')
      .slice(0, 8);
    this.setData({ joinCode: value });
  },

  async createInvite() {
    if (this.data.loading) return;
    this.setData({ loading: true });
    wx.showLoading({ title: '生成中', mask: true });
    try {
      const session = await api.createInvite();
      this.applySession(session);
    } catch (e) {
      wx.showToast({ title: e.message || '生成失败', icon: 'none' });
    } finally {
      wx.hideLoading();
      this.setData({ loading: false });
    }
  },

  async joinPair() {
    if (this.data.loading) return;
    const code = this.data.joinCode.trim();
    if (code.length !== 8) {
      wx.showToast({ title: '请输入 8 位绑定码', icon: 'none' });
      return;
    }

    this.setData({ loading: true });
    wx.showLoading({ title: '绑定中', mask: true });
    try {
      const session = await api.joinPair(code);
      this.applySession(session);
      wx.showToast({ title: '绑定成功 💕', icon: 'none' });
    } catch (e) {
      wx.showToast({ title: e.message || '绑定失败', icon: 'none' });
    } finally {
      wx.hideLoading();
      this.setData({ loading: false });
    }
  },

  copyCode() {
    if (!this.data.inviteCode) return;
    wx.setClipboardData({ data: this.data.inviteCode });
  },

  async refreshInvite() {
    if (this.data.loading) return;
    this.setData({ loading: true });
    try {
      const session = await api.refreshInvite();
      this.applySession(session);
      wx.showToast({ title: '绑定码已更新', icon: 'none' });
    } catch (e) {
      wx.showToast({ title: e.message || '更新失败', icon: 'none' });
    } finally {
      this.setData({ loading: false });
    }
  },

  cancelInvite() {
    wx.showModal({
      title: '取消这次邀请？',
      content: '取消后当前绑定码会立即失效，可以重新发起绑定。',
      confirmColor: '#ff6b81',
      success: async (res) => {
        if (!res.confirm) return;
        try {
          wx.showLoading({ title: '处理中', mask: true });
          const session = await api.cancelInvite();
          this.applySession(session);
        } catch (e) {
          wx.showToast({ title: e.message || '取消失败', icon: 'none' });
        } finally {
          wx.hideLoading();
        }
      },
    });
  },

  backHome() {
    wx.switchTab({ url: '/pages/index/index' });
  },
});
