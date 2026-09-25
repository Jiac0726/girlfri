const api = require('../../services/cloud');

const REMINDER_TEMPLATE_ID = 'tb0gjEGNaTQfOvLVKNdWKekwa3fSTdyCQkkTSpuNjtk';
const REMINDER_TIME_OPTIONS = ['20:00', '20:30', '21:00', '21:30', '22:00', '22:30'];

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

function reminderIndex(time) {
  const index = REMINDER_TIME_OPTIONS.indexOf(time);
  return index >= 0 ? index : REMINDER_TIME_OPTIONS.indexOf('21:30');
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

    reminderSaving: false,
    reminderEnabled: false,
    reminderTime: '21:30',
    reminderTimeOptions: REMINDER_TIME_OPTIONS,
    reminderTimeIndex: reminderIndex('21:30'),
    reminderStatusText: '未开启提醒',

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
          reminderEnabled: false,
          reminderStatusText: '完成绑定后可开启提醒',
        });
        return;
      }

      const [data, reminder] = await Promise.all([
        api.getProfile(),
        api.getReminderSettings().catch(() => ({
          enabled: false,
          time: '21:30',
          needsRenewal: false,
        })),
      ]);
      const me = viewProfile(data.me);
      const partner = viewProfile(data.partner);
      const reminderTime = reminder.time || '21:30';
      const enabled = !!reminder.enabled;

      this.setData({
        authLoading: false,
        bindingStatus: 'active',
        moodEmoji: me.moodEmoji,
        moodText: me.moodText,
        savedMoodEmoji: me.moodEmoji,
        savedMoodText: me.moodText,
        myUpdatedLabel: me.moodUpdatedLabel,
        partner,
        reminderEnabled: enabled,
        reminderTime,
        reminderTimeIndex: reminderIndex(reminderTime),
        reminderStatusText: enabled
          ? '已授权：若当天未评价，将在 ' + reminderTime + ' 提醒'
          : (reminder.needsRenewal ? '上一次提醒已发送，请再次开启' : '未开启提醒'),
      });
    } catch (e) {
      if (api.isBindingError(e)) {
        this.setData({
          authLoading: false,
          bindingStatus: 'unbound',
          partner: viewProfile(null),
          reminderEnabled: false,
          reminderStatusText: '完成绑定后可开启提醒',
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

  async onReminderToggle(e) {
    if (this.data.reminderSaving || this.data.bindingStatus !== 'active') return;
    const wantsOn = !!(e && e.detail && e.detail.value);

    if (!wantsOn) {
      this.setData({ reminderSaving: true });
      try {
        await api.updateReminderSettings(false, this.data.reminderTime);
        this.setData({
          reminderEnabled: false,
          reminderStatusText: '未开启提醒',
        });
      } catch (err) {
        this.setData({ reminderEnabled: true });
        wx.showToast({ title: err.message || '关闭失败', icon: 'none' });
      } finally {
        this.setData({ reminderSaving: false });
      }
      return;
    }

    this.setData({ reminderSaving: true });
    try {
      const res = await new Promise((resolve, reject) => {
        wx.requestSubscribeMessage({
          tmplIds: [REMINDER_TEMPLATE_ID],
          success: resolve,
          fail: reject,
        });
      });

      const decision = res && res[REMINDER_TEMPLATE_ID];
      if (decision !== 'accept') {
        this.setData({ reminderEnabled: false });
        wx.showToast({
          title: decision === 'ban' ? '请先在微信设置中允许订阅消息' : '需要允许通知才能开启提醒',
          icon: 'none',
        });
        return;
      }

      const reminder = await api.updateReminderSettings(true, this.data.reminderTime);
      this.setData({
        reminderEnabled: true,
        reminderStatusText: '已授权：若当天未评价，将在 ' + reminder.time + ' 提醒',
      });
      wx.showToast({ title: '未评价提醒已开启', icon: 'none' });
    } catch (err) {
      this.setData({ reminderEnabled: false });
      wx.showToast({ title: err.message || '订阅授权失败', icon: 'none' });
    } finally {
      this.setData({ reminderSaving: false });
    }
  },

  async onReminderTimeChange(e) {
    if (this.data.reminderSaving) return;
    const index = Number(e && e.detail && e.detail.value);
    const time = REMINDER_TIME_OPTIONS[index] || '21:30';
    const oldTime = this.data.reminderTime;
    const oldIndex = this.data.reminderTimeIndex;

    this.setData({
      reminderTime: time,
      reminderTimeIndex: reminderIndex(time),
      reminderSaving: true,
    });

    try {
      const reminder = await api.updateReminderSettings(this.data.reminderEnabled, time);
      this.setData({
        reminderTime: reminder.time,
        reminderTimeIndex: reminderIndex(reminder.time),
        reminderStatusText: reminder.enabled
          ? '已授权：若当天未评价，将在 ' + reminder.time + ' 提醒'
          : this.data.reminderStatusText,
      });
    } catch (err) {
      this.setData({ reminderTime: oldTime, reminderTimeIndex: oldIndex });
      wx.showToast({ title: err.message || '修改时间失败', icon: 'none' });
    } finally {
      this.setData({ reminderSaving: false });
    }
  },
});
