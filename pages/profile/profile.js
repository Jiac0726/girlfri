const api = require('../../services/cloud');

const MOODS = [
  { emoji: '🥰', label: '甜甜的' },
  { emoji: '😊', label: '开心' },
  { emoji: '😌', label: '平静' },
  { emoji: '🥺', label: '想抱抱' },
  { emoji: '😤', label: '有点气' },
  { emoji: '😢', label: '难过' },
  { emoji: '😴', label: '累了' },
  { emoji: '🤍', label: '想安静' },
];

function formatMoodTime(value) {
  if (!value) return '';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '';

  const pad = (n) => (n < 10 ? '0' + n : '' + n);
  const now = new Date();
  const sameDay =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate();

  if (sameDay) {
    return '今天 ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
  }

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

function viewProfile(profile) {
  const item = profile || {};
  return {
    moodEmoji: item.moodEmoji || '',
    moodText: item.moodText || '',
    moodUpdatedAt: item.moodUpdatedAt || '',
    moodUpdatedLabel: formatMoodTime(item.moodUpdatedAt),
    hasMood: !!item.hasMood,
  };
}

Page({
  data: {
    moods: MOODS,
    authLoading: true,
    saving: false,
    bindingStatus: 'loading',

    moodEmoji: '',
    moodText: '',
    savedMoodEmoji: '',
    savedMoodText: '',
    myUpdatedLabel: '',

    partner: {
      moodEmoji: '',
      moodText: '',
      moodUpdatedLabel: '',
      hasMood: false,
    },
  },

  onShow() {
    this.loadProfile();
  },

  onPullDownRefresh() {
    this.loadProfile(true);
  },

  async loadProfile(isPullDown) {
    if (!isPullDown) this.setData({ authLoading: true });

    try {
      const session = await api.getSession();
      const status = session.bindingStatus || 'unbound';

      if (status !== 'active') {
        this.setData({
          authLoading: false,
          bindingStatus: status,
          partner: viewProfile(null),
        });
        return;
      }

      const data = await api.getProfile();
      const me = viewProfile(data.me);
      const partner = viewProfile(data.partner);

      this.setData({
        authLoading: false,
        bindingStatus: 'active',
        moodEmoji: me.moodEmoji,
        moodText: me.moodText,
        savedMoodEmoji: me.moodEmoji,
        savedMoodText: me.moodText,
        myUpdatedLabel: me.moodUpdatedLabel,
        partner,
      });
    } catch (e) {
      if (api.isBindingError(e)) {
        this.setData({
          authLoading: false,
          bindingStatus: 'unbound',
          partner: viewProfile(null),
        });
      } else {
        this.setData({ authLoading: false });
        wx.showToast({ title: e.message || '个人页加载失败', icon: 'none' });
      }
    } finally {
      if (isPullDown) wx.stopPullDownRefresh();
    }
  },

  goBind() {
    wx.navigateTo({ url: '/pages/bind/bind' });
  },

  chooseMood(e) {
    if (this.data.bindingStatus !== 'active') return;
    this.setData({ moodEmoji: e.currentTarget.dataset.emoji || '' });
  },

  onMoodTextInput(e) {
    if (this.data.bindingStatus !== 'active') return;
    this.setData({ moodText: e.detail.value });
  },

  async saveMood() {
    if (this.data.saving || this.data.bindingStatus !== 'active') return;

    const moodEmoji = String(this.data.moodEmoji || '').trim();
    const moodText = String(this.data.moodText || '').trim();

    if (!moodEmoji && !moodText) {
      wx.showToast({ title: '选一个心情，或写一句感受', icon: 'none' });
      return;
    }

    this.setData({ saving: true });
    wx.showLoading({ title: '更新心情', mask: true });

    try {
      const result = await api.updateMood(moodEmoji, moodText);
      const me = viewProfile(result);

      this.setData({
        moodEmoji: me.moodEmoji,
        moodText: me.moodText,
        savedMoodEmoji: me.moodEmoji,
        savedMoodText: me.moodText,
        myUpdatedLabel: me.moodUpdatedLabel,
      });

      wx.showToast({ title: 'TA 已经可以看到啦 💗', icon: 'none' });
    } catch (e) {
      wx.showToast({ title: e.message || '更新失败', icon: 'none' });
    } finally {
      wx.hideLoading();
      this.setData({ saving: false });
    }
  },
});
