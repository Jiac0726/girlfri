const api = require('../../services/cloud');

const PRESETS = ['和好一次', '选餐一次', '选片一次', '撒娇一次'];

function dateLabel(value) {
  if (!value) return '';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n) => (n < 10 ? '0' + n : '' + n);
  return (
    d.getFullYear() +
    '-' +
    pad(d.getMonth() + 1) +
    '-' +
    pad(d.getDate()) +
    ' ' +
    pad(d.getHours()) +
    ':' +
    pad(d.getMinutes())
  );
}

function viewCard(item) {
  const row = Object.assign({}, item);
  row.createdLabel = dateLabel(item.createdAt);
  row.usedLabel = dateLabel(item.usedAt);
  row.revokedLabel = dateLabel(item.revokedAt);
  row.statusLabel =
    item.status === 'used'
      ? '已使用'
      : item.status === 'revoked'
      ? '已撤回'
      : '可使用';
  return row;
}

Page({
  data: {
    loading: false,
    saving: false,
    presets: PRESETS,
    name: '',
    note: '',
    receivedActive: [],
    sentActive: [],
    history: [],
  },

  onShow() {
    this.loadCards();
  },

  async loadCards() {
    if (this.data.loading) return;
    this.setData({ loading: true });

    try {
      const data = await api.listPrivilegeCards();
      const cards = (Array.isArray(data) ? data : []).map(viewCard);

      this.setData({
        receivedActive: cards.filter(
          (item) => item.status === 'active' && item.receivedByMe
        ),
        sentActive: cards.filter(
          (item) => item.status === 'active' && item.fromMe
        ),
        history: cards.filter((item) => item.status !== 'active'),
      });
    } catch (e) {
      if (api.isBindingError(e)) {
        wx.showModal({
          title: '先完成双人绑定',
          content: '绑定后才能给 TA 发放和使用特权卡。',
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
      this.setData({ loading: false });
    }
  },

  choosePreset(e) {
    this.setData({ name: e.currentTarget.dataset.name || '' });
  },

  onNameInput(e) {
    this.setData({ name: e.detail.value });
  },

  onNoteInput(e) {
    this.setData({ note: e.detail.value });
  },

  async createCard() {
    if (this.data.saving) return;

    const name = String(this.data.name || '').trim();
    const note = String(this.data.note || '').trim();

    if (!name) {
      wx.showToast({ title: '先写特权卡名称', icon: 'none' });
      return;
    }

    this.setData({ saving: true });
    wx.showLoading({ title: '发卡中', mask: true });

    try {
      await api.createPrivilegeCard(name, note);
      this.setData({ name: '', note: '' });
      await this.loadCards();
      wx.showToast({ title: '已经发给 TA 啦 🎟️', icon: 'none' });
    } catch (e) {
      wx.showToast({ title: e.message || '发放失败', icon: 'none' });
    } finally {
      wx.hideLoading();
      this.setData({ saving: false });
    }
  },

  useCard(e) {
    const id = e.currentTarget.dataset.id;
    const item = this.data.receivedActive.find((row) => row.id === id);
    if (!item) return;

    wx.showModal({
      title: '使用这张特权卡？',
      content:
        '确认使用「' +
        item.name +
        '」？使用后会进入历史记录，不能再次使用。',
      confirmText: '立即使用',
      confirmColor: '#ff6b81',
      success: async (res) => {
        if (!res.confirm) return;

        wx.showLoading({ title: '使用中', mask: true });
        try {
          await api.usePrivilegeCard(id);
          await this.loadCards();
          wx.showToast({ title: '特权卡已使用 ✨', icon: 'none' });
        } catch (err) {
          wx.showToast({ title: err.message || '使用失败', icon: 'none' });
        } finally {
          wx.hideLoading();
        }
      },
    });
  },

  revokeCard(e) {
    const id = e.currentTarget.dataset.id;
    const item = this.data.sentActive.find((row) => row.id === id);
    if (!item) return;

    wx.showModal({
      title: '撤回这张卡？',
      content: '撤回「' + item.name + '」后，TA 将不能再使用它。',
      confirmText: '撤回',
      confirmColor: '#ff6b81',
      success: async (res) => {
        if (!res.confirm) return;

        wx.showLoading({ title: '撤回中', mask: true });
        try {
          await api.revokePrivilegeCard(id);
          await this.loadCards();
          wx.showToast({ title: '已撤回', icon: 'none' });
        } catch (err) {
          wx.showToast({ title: err.message || '撤回失败', icon: 'none' });
        } finally {
          wx.hideLoading();
        }
      },
    });
  },
});
