const api = require('../../services/cloud');
const { wxCall, normalizeLocalImage, makeCompatibleImage } = require('../../services/entry-view');
const MISS_TEMPLATE = 'RWnfT0dJaUjWh6e1XsFpLzgeI6naPdDE6Yq1VSbHusw';
const DAILY_TEMPLATE = 'tb0gjEGNaTQfOvLVKNdWKekwa3fSTdyCQkkTSpuNjtk';
const TIMES = ['20:00','20:30','21:00','21:30','22:00','22:30'];

function localFileSize(path) {
  return new Promise((resolve, reject) => {
    try {
      const fs = wx.getFileSystemManager();
      fs.stat({
        path,
        success: result => resolve(Number(result && result.stats && result.stats.size) || 0),
        fail: reject,
      });
    } catch (error) {
      reject(error);
    }
  });
}

Page({
  data: {
    version: 'V2',
    loading: false,
    bindingStatus: 'loading',
    accountStatusText: '正在读取账号状态',
    accountActionText: '查看',
    avatarUrl: '',
    avatarSaving: false,
    avatarReady: false,
    missNotifySaving: false,
    missNotifyReady: false,
    missNotifyQuota: 0,
    missNotifyStatusText: '正在读取提醒状态',
    reminderSaving: false,
    reminderReady: false,
    reminderEnabled: false,
    reminderTime: '21:30',
    reminderTimeOptions: TIMES,
    reminderTimeIndex: 3,
    reminderStatusText: '正在读取每日分享提醒',
    error: '',
  },

  onShow: function () {
    this.loadSettings();
  },

  loadSettings: async function () {
    if (this.data.loading || this.data.missNotifySaving || this.data.reminderSaving || this.data.avatarSaving) return;
    this.setData({ loading: true, error: '' });
    try {
      const session = await api.getSession();
      const bindingStatus = session.bindingStatus;
      this.applyAccount(session);
      if (bindingStatus !== 'active') {
        this.setData({
          missNotifyReady: false,
          missNotifyQuota: 0,
          missNotifyStatusText: '完成双人绑定后可开启想念提醒',
          avatarReady: false,
          avatarUrl: '',
          reminderReady: false,
          reminderEnabled: false,
          reminderStatusText: '完成双人绑定后可设置每日分享提醒',
        });
        return;
      }
      const [account, missNotify, reminder] = await Promise.all([
        api.getAccountProfile(),
        api.getMissNotifySettings(),
        api.getReminderSettings(),
      ]);
      this.applyAvatar(account);
      this.applyMissNotify(missNotify);
      this.applyReminder(reminder);
    } catch (error) {
      this.setData({
        error: error.message || '设置加载失败，请重试',
        avatarReady: false,
        missNotifyReady: false,
        reminderReady: false,
      });
      if (api.isBindingError && api.isBindingError(error)) {
        this.setData({
          bindingStatus: 'unbound',
          accountStatusText: '尚未绑定双人关系',
          accountActionText: '去绑定',
          avatarReady: false,
          avatarUrl: '',
          missNotifyQuota: 0,
          missNotifyStatusText: '完成双人绑定后可开启想念提醒',
          reminderEnabled: false,
          reminderStatusText: '完成双人绑定后可设置每日分享提醒',
        });
      }
    } finally {
      this.setData({ loading: false });
    }
  },

  applyAccount: function (session) {
    const status = session && session.bindingStatus || 'unbound';
    const statusText = status === 'active'
      ? '已完成双人绑定'
      : status === 'waiting'
        ? '正在等待 TA 加入'
        : '尚未绑定双人关系';
    const actionText = status === 'active'
      ? '查看状态'
      : status === 'waiting'
        ? '继续绑定'
        : '去绑定';
    this.setData({
      bindingStatus: status,
      accountStatusText: statusText,
      accountActionText: actionText,
    });
  },

  goAccountBinding: function () {
    wx.navigateTo({ url: '/pages/bind/bind' });
  },

  applyAvatar: function (value) {
    this._avatarVersion = Number(value && value.avatarVersion) || 0;
    this.setData({
      avatarReady: true,
      avatarUrl: value && value.avatarUrl || '',
    });
  },

  onChooseAvatar: async function (e) {
    if (this.data.avatarSaving || this.data.loading || this.data.bindingStatus !== 'active') return;
    let localPath = e && e.detail && e.detail.avatarUrl;
    if (!localPath) return;

    this.setData({ avatarSaving: true, error: '' });
    try {
      const normalized = await normalizeLocalImage(localPath);
      localPath = normalized.path;
      let converted = normalized.converted;

      let confirmed = null;
      for (let attempt = 0; attempt < 3 && !confirmed; attempt++) {
        try {
          const size = await localFileSize(localPath);
          if (!size || size > 20 * 1024 * 1024) throw new Error('头像不能超过 20 MB');
          const requestId = api.newRequestId();
          const prepared = await api.prepareMedia({ requestId, name: 'account-avatar', size });
          const uploaded = await wx.cloud.uploadFile({ cloudPath: prepared.cloudPath, filePath: localPath });
          confirmed = await api.confirmMedia({ id: prepared.id, fileID: uploaded.fileID });
        } catch (error) {
          if (error.code === 'INVALID_MEDIA_TYPE' && !converted) {
            localPath = await makeCompatibleImage(localPath);
            converted = true;
            continue;
          }
          if (['MEDIA_EXPIRED', 'MEDIA_UNAVAILABLE', 'MEDIA_PROCESSING'].includes(error.code) && attempt < 2) continue;
          throw error;
        }
      }
      if (!confirmed || !confirmed.id) throw new Error('头像上传未完成，请重试');

      const account = await api.updateAccountAvatar({
        requestId: api.newRequestId(),
        mediaId: confirmed.id,
        expectedVersion: this._avatarVersion || 0,
      });
      this.applyAvatar(account);
      wx.showToast({ title: '头像已更新', icon: 'success' });
    } catch (error) {
      wx.showToast({ title: error.message || '头像更新失败，请重试', icon: 'none' });
      try { this.applyAvatar(await api.getAccountProfile()); } catch (_) {}
    } finally {
      this.setData({ avatarSaving: false });
    }
  },

  applyReminder: function (value) {
    const index = TIMES.indexOf(value && value.time);
    this._reminderVersion = Number(value && value.version) || 0;
    this.setData({
      reminderReady: true,
      reminderEnabled: !!(value && value.enabled),
      reminderTime: index >= 0 ? value.time : '21:30',
      reminderTimeIndex: index >= 0 ? index : 3,
      reminderStatusText: value && value.enabled
        ? '已开启：当天未分享，将在 ' + value.time + ' 提醒'
        : value && value.needsRenewal
          ? '本次订阅已使用或失效，可再次开启'
          : '未开启每日分享提醒',
    });
  },

  onReminderToggle: async function (e) {
    if (this.data.reminderSaving || this.data.loading || !this.data.reminderReady || this.data.bindingStatus !== 'active') return;
    const enabled = !!e.detail.value;
    this.setData({ reminderSaving: true });
    try {
      if (enabled) {
        const result = await wxCall('requestSubscribeMessage', { tmplIds: [DAILY_TEMPLATE] });
        if (result[DAILY_TEMPLATE] !== 'accept') {
          this.setData({ reminderEnabled: false });
          wx.showToast({ title: '允许订阅后才能开启提醒', icon: 'none' });
          return;
        }
      }
      this.applyReminder(await api.updateReminderSettings(enabled, this.data.reminderTime, this._reminderVersion));
    } catch (error) {
      this.setData({ reminderReady: false, error: error.message || '每日分享提醒设置未确认，请刷新重试' });
      try { this.applyReminder(await api.getReminderSettings()); } catch (_) {}
    } finally {
      this.setData({ reminderSaving: false });
    }
  },

  onReminderTimeChange: async function (e) {
    if (this.data.reminderSaving || this.data.loading || !this.data.reminderReady || this.data.bindingStatus !== 'active') return;
    const time = TIMES[Number(e.detail.value)];
    if (!time) return;
    this.setData({ reminderSaving: true });
    try {
      this.applyReminder(await api.updateReminderSettings(this.data.reminderEnabled, time, this._reminderVersion));
    } catch (error) {
      this.setData({ reminderReady: false, error: error.message || '提醒时间设置未确认，请刷新重试' });
      try { this.applyReminder(await api.getReminderSettings()); } catch (_) {}
    } finally {
      this.setData({ reminderSaving: false });
    }
  },

  applyMissNotify: function (value) {
    this._missTemplateId = (value && value.templateId) || MISS_TEMPLATE;
    const quota = Math.max(0, Number(value && value.quota) || 0);
    this.setData({
      missNotifyReady: true,
      missNotifyQuota: quota,
      missNotifyStatusText: quota ? '已允许 ' + quota + ' 次想念提醒' : '没有可用提醒次数',
    });
  },

  authorizeMissNotify: async function () {
    if (this.data.missNotifySaving || this.data.loading || !this.data.missNotifyReady || this.data.bindingStatus !== 'active') return;
    this.setData({ missNotifySaving: true });
    const templateId = this._missTemplateId || MISS_TEMPLATE;
    let stage = '微信订阅授权';
    try {
      const result = await wxCall('requestSubscribeMessage', { tmplIds: [templateId] });
      if (result[templateId] !== 'accept') {
        const status = result[templateId];
        wx.showModal({
          title: '未获得订阅授权',
          content: status === 'reject'
            ? '你尚未允许这条订阅。请在小程序右上角菜单的设置中检查通知订阅设置，再点击允许提醒。'
            : '微信返回订阅状态：' + String(status || '未返回模板状态') + '。请检查小程序后台的订阅模板是否可用。',
          showCancel: false,
        });
        return;
      }
      stage = '保存提醒授权';
      const value = await api.authorizeMissNotify({ requestId: api.newRequestId() });
      this.applyMissNotify(value);
      wx.showToast({ title: '下一次想念会提醒你 ♡', icon: 'none' });
    } catch (error) {
      const code = error && (error.errCode !== undefined ? error.errCode : error.code);
      const detail = String((error && (error.errMsg || error.message)) || error || '未知错误');
      console.error('[miss-notify-authorization]', { stage, templateId, code, detail });
      wx.showModal({
        title: stage + '失败',
        content: (code !== undefined ? '错误码：' + code + '\n' : '') + detail +
          (stage === '微信订阅授权'
            ? '\n请核对当前小程序 AppID 下的订阅消息模板 ID：' + templateId
            : '\n微信已允许订阅，但保存结果未确认，请刷新查看提醒次数。'),
        showCancel: false,
      });
      try { this.applyMissNotify(await api.getMissNotifySettings()); } catch (_) {}
    } finally {
      this.setData({ missNotifySaving: false });
    }
  },

  goBack: function () {
    wx.navigateBack({ delta: 1 });
  },

  openWechatSettings: function () {
    wx.openSetting({
      success: () => {
        wx.showToast({ title: '设置已更新', icon: 'none' });
      },
    });
  },

  showPrivacy: function () {
    wx.showModal({
      title: '隐私说明',
      content: '“热念”只在必要范围内保存双人空间所需的数据。恋爱备忘录仅对本人可见，不会展示给另一方。',
      showCancel: false,
    });
  },

  showAbout: function () {
    wx.showModal({
      title: '关于热念',
      content: '两个人的相处记录\n记录日常，也记得彼此。',
      showCancel: false,
    });
  },
});
