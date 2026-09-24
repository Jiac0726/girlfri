const api = require('../../services/cloud');

const PRESETS = ['亲嘴权', '抱抱权', '贴贴权', '选片权'];

Page({
  data: {
    loading: false,
    saving: false,
    presets: PRESETS,
    myPermissions: [],
    receivedPermissions: [],
    name: '',
    note: '',
    editingId: '',
  },

  onShow() {
    this.loadPermissions();
  },

  async loadPermissions() {
    const request = this._listRequest = (this._listRequest || 0) + 1;
    this.setData({ loading: true });

    try {
      const items = await api.listPermissions();
      if (request !== this._listRequest) return;
      const list = Array.isArray(items) ? items : [];
      this.setData({
        myPermissions: list.filter((item) => item.fromMe),
        receivedPermissions: list.filter((item) => !item.fromMe),
      });
    } catch (e) {
      if (request !== this._listRequest) return;
      if (api.isBindingError(e)) {
        wx.showModal({
          title: '先完成双人绑定',
          content: '绑定后才能和 TA 管理彼此的权限。',
          confirmText: '去绑定',
          confirmColor: '#ff6b81',
          success: (res) => {
            if (res.confirm) wx.navigateTo({ url: '/pages/bind/bind' });
            else wx.navigateBack();
          },
        });
      } else {
        wx.showToast({ title: e.message || '加载失败', icon: 'none' });
      }
    } finally {
      if (request === this._listRequest) this.setData({ loading: false });
    }
  },

  onNameInput(e) {
    this.setData({ name: e.detail.value });
  },

  onNoteInput(e) {
    this.setData({ note: e.detail.value });
  },

  choosePreset(e) {
    this.setData({ name: e.currentTarget.dataset.name || '' });
  },

  startEdit(e) {
    const id = e.currentTarget.dataset.id;
    const item = this.data.myPermissions.find((row) => row.id === id);
    if (!item) return;

    this.setData({
      editingId: item.id,
      name: item.name || '',
      note: item.note || '',
    });

    wx.pageScrollTo({ scrollTop: 0, duration: 220 });
  },

  cancelEdit() {
    this.setData({ editingId: '', name: '', note: '' });
  },

  async submitPermission() {
    if (this.data.saving) return;

    const name = String(this.data.name || '').trim();
    const note = String(this.data.note || '').trim();

    if (!name) {
      wx.showToast({ title: '先写一个权限名称', icon: 'none' });
      return;
    }

    this.setData({ saving: true });
    wx.showLoading({
      title: this.data.editingId ? '保存中' : '发放中',
      mask: true,
    });

    try {
      if (this.data.editingId) {
        await api.updatePermission(this.data.editingId, name, note);
        wx.showToast({ title: '权限已更新', icon: 'none' });
      } else {
        await api.createPermission(name, note);
        wx.showToast({ title: '已经给 TA 啦 💕', icon: 'none' });
      }

      this.setData({ editingId: '', name: '', note: '' });
      await this.loadPermissions();
    } catch (e) {
      wx.showToast({ title: e.message || '保存失败', icon: 'none' });
    } finally {
      wx.hideLoading();
      this.setData({ saving: false });
    }
  },

  async onToggle(e) {
    const id = e.currentTarget.dataset.id;
    const enabled = !!e.detail.value;

    try {
      await api.togglePermission(id, enabled);
      await this.loadPermissions();
      wx.showToast({
        title: enabled ? '权限已恢复' : '权限已暂停',
        icon: 'none',
      });
    } catch (err) {
      wx.showToast({ title: err.message || '操作失败', icon: 'none' });
      await this.loadPermissions();
    }
  },

  deletePermission(e) {
    const id = e.currentTarget.dataset.id;
    const item = this.data.myPermissions.find((row) => row.id === id);
    if (!item) return;

    wx.showModal({
      title: '删除这项权限？',
      content: '删除「' + item.name + '」后，TA 也会立即看不到。',
      confirmText: '删除',
      confirmColor: '#ff6b81',
      success: async (res) => {
        if (!res.confirm) return;

        try {
          await api.deletePermission(id);
          if (this.data.editingId === id) this.cancelEdit();
          await this.loadPermissions();
          wx.showToast({ title: '已删除', icon: 'none' });
        } catch (err) {
          wx.showToast({ title: err.message || '删除失败', icon: 'none' });
        }
      },
    });
  },
});
