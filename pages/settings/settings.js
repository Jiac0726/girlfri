const api = require('../../services/cloud');
const { wxCall } = require('../../services/entry-view');
const MISS_TEMPLATE = 'RWnfT0dJaUjWh6e1XsFpLzgeI6naPdDE6Yq1VSbHusw';

Page({
  data: {
    version: 'V2',
    loading: false,
    bindingStatus: 'loading',
    missNotifySaving: false,
    missNotifyReady: false,
    missNotifyQuota: 0,
    missNotifyStatusText: '正在读取提醒状态',
    error: '',
  },

  onShow: function () {
    this.loadSettings();
  },

  loadSettings: async function () {
    if (this.data.loading || this.data.missNotifySaving) return;
    this.setData({ loading: true, error: '' });
    try {
      const session = await api.getSession();
      const bindingStatus = session.bindingStatus;
      this.setData({ bindingStatus });
      if (bindingStatus !== 'active') {
        this.setData({
          missNotifyReady: false,
          missNotifyQuota: 0,
          missNotifyStatusText: '完成双人绑定后可开启想念提醒',
        });
        return;
      }
      this.applyMissNotify(await api.getMissNotifySettings());
    } catch (error) {
      this.setData({
        error: error.message || '设置加载失败，请重试',
        missNotifyReady: false,
      });
      if (api.isBindingError && api.isBindingError(error)) {
        this.setData({
          bindingStatus: 'unbound',
          missNotifyQuota: 0,
          missNotifyStatusText: '完成双人绑定后可开启想念提醒',
        });
      }
    } finally {
      this.setData({ loading: false });
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
