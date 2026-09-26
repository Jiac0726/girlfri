const api = require('../../services/cloud');
const { MOODS, wxCall, isUncertain } = require('../../services/entry-view');
const { dateLabel } = require('../../helpers/interactions');
const TEMPLATE = 'tb0gjEGNaTQfOvLVKNdWKekwa3fSTdyCQkkTSpuNjtk';
const MISS_TEMPLATE = 'RWnfT0dJaUjWh6e1XsFpLzgeI6naPdDE6Yq1VSbHusw';
const TIMES = ['20:00','20:30','21:00','21:30','22:00','22:30'];
function profile(x) { return Object.assign({ moodEmoji: '', moodText: '', hasMood: false }, x || {}, { moodUpdatedLabel: dateLabel(x && x.moodUpdatedAt) }); }
function memoMediaError(stage, error) {
  const raw = String((error && (error.errMsg || error.message)) || error || '未知错误');
  console.error('[memo-media-upload]', {
    stage,
    code: error && error.code,
    errMsg: error && error.errMsg,
    message: error && error.message,
    raw: error,
  });
  const wrapped = new Error('备忘录图片上传失败（' + stage + '）：' + raw);
  wrapped.code = (error && error.code) || 'MEDIA_UPLOAD_FAILED';
  wrapped.raw = error;
  return wrapped;
}
Page({
  data: { moods: MOODS, authLoading: true, saving: false, bindingStatus: 'loading', moodEmoji: '', moodText: '', savedMoodEmoji: '', savedMoodText: '', myUpdatedLabel: '', partner: profile(), pendingAgreementCount: 0, pendingCouponCount: 0,
    memoSaving: false, memoItems: [], memoTitle: '', memoText: '', memoImages: [], memoEditingId: '', memoUncertain: false, memoDeletingId: '',
    reminderSaving: false, reminderEnabled: false, reminderReady: false, reminderTime: '21:30', reminderTimeOptions: TIMES, reminderTimeIndex: 3, reminderStatusText: '未开启提醒',
    missNotifySaving: false, missNotifyReady: false, missNotifyQuota: 0, missNotifyStatusText: '未允许想念提醒', error: '' },
  onShow() { this._disposed = false; this.loadProfile(); },
  onUnload() { this._disposed = true; this._loadToken = (this._loadToken || 0) + 1; },
  async onPullDownRefresh() { try { await this.loadProfile(); } finally { wx.stopPullDownRefresh(); } },
  async loadProfile() {
    if (this.data.saving || this.data.memoSaving || this.data.reminderSaving || this.data.missNotifySaving) return;
    const token = this._loadToken = (this._loadToken || 0) + 1, revision = this._draftRevision || 0;
    this.setData({ authLoading: true, error: '' });
    try {
      const session = await api.getSession();
      if (token !== this._loadToken) return;
      const changed = this._scope !== session.coupleId; this._scope = session.coupleId;
      if (changed) {
        this._dirty = false;
        this._memoPending = null;
        this._memoEditVersion = 0;
        this.setData({
          moodEmoji: '', moodText: '', savedMoodEmoji: '', savedMoodText: '',
          memoItems: [], memoTitle: '', memoText: '', memoImages: [], memoEditingId: '', memoUncertain: false, memoDeletingId: '',
          partner: profile(), pendingAgreementCount: 0, pendingCouponCount: 0, reminderReady: false,
          missNotifyReady: false, missNotifyQuota: 0, missNotifyStatusText: '未允许想念提醒',
        });
      }
      this.setData({ bindingStatus: session.bindingStatus });
      if (session.bindingStatus !== 'active') {
        this.setData({ reminderEnabled: false, reminderReady: false, missNotifyReady: false, missNotifyQuota: 0 });
        return;
      }
      const [data, reminder, memos, missNotify] = await Promise.all([
        api.getProfile(),
        api.getReminderSettings(),
        api.listPrivateMemos(),
        api.getMissNotifySettings(),
      ]);
      if (token !== this._loadToken) return;
      const me = profile(data.me);
      const memoItems = (memos.items || []).map(item => Object.assign({}, item, {
        updatedLabel: dateLabel(item.updatedAt || item.createdAt),
        images: (item.images || []).map(image => Object.assign({}, image, { failed: false })),
      }));
      const update = {
        savedMoodEmoji: me.moodEmoji,
        savedMoodText: me.moodText,
        myUpdatedLabel: me.moodUpdatedLabel,
        memoItems,
        partner: profile(data.partner),
        pendingAgreementCount: data.pendingAgreementCount,
        pendingCouponCount: data.pendingCouponCount,
      };
      if (!this._dirty && revision === (this._draftRevision || 0)) Object.assign(update, { moodEmoji: me.moodEmoji, moodText: me.moodText });
      this.setData(update);
      this.applyReminder(reminder);
      this.applyMissNotify(missNotify);
    } catch (error) {
      if (token !== this._loadToken) return;
      this.setData({ error: error.message || '加载失败，请重试', reminderReady: false, missNotifyReady: false });
      if (api.isBindingError(error)) this.setData({ bindingStatus: 'unbound', partner: profile() });
    } finally { if (token === this._loadToken) this.setData({ authLoading: false }); }
  },
  applyReminder(value) {
    this._reminderVersion = value.version;
    this.setData({ reminderReady: true, reminderEnabled: !!value.enabled, reminderTime: value.time, reminderTimeIndex: TIMES.indexOf(value.time),
      reminderStatusText: value.enabled ? '已授权：当天未分享，将在 ' + value.time + ' 提醒' : value.needsRenewal ? '本次授权已使用或失效，可再次开启' : '未开启提醒' });
  },
  applyMissNotify(value) {
    this._missTemplateId = (value && value.templateId) || MISS_TEMPLATE;
    const quota = Math.max(0, Number(value && value.quota) || 0);
    this.setData({
      missNotifyReady: true,
      missNotifyQuota: quota,
      missNotifyStatusText: quota ? '已允许 ' + quota + ' 次想念提醒' : '没有可用提醒次数',
    });
  },
  async authorizeMissNotify() {
    if (this.data.missNotifySaving || this.data.authLoading || !this.data.missNotifyReady || this.data.bindingStatus !== 'active') return;
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
      if (!this._disposed) this.setData({ missNotifySaving: false });
    }
  },
  goBind() { wx.navigateTo({ url: '/pages/bind/bind' }); },
  goAgreements() { wx.navigateTo({ url: '/pages/permissions/permissions' }); },
  goCoupons() { wx.navigateTo({ url: '/pages/privileges/privileges' }); },
  onMemoTitleInput(e) {
    if (this.data.memoSaving || this.data.memoUncertain) return;
    this.setData({ memoTitle: e.detail.value });
  },
  onMemoTextInput(e) {
    if (this.data.memoSaving || this.data.memoUncertain) return;
    this.setData({ memoText: e.detail.value });
  },
  async chooseMemoImages() {
    if (this.data.memoSaving || this.data.memoUncertain || this.data.memoImages.length >= 6) return;
    this.setData({ memoSaving: true });
    try {
      const result = await wxCall('chooseMedia', {
        count: 6 - this.data.memoImages.length,
        mediaType: ['image'],
        sizeType: ['compressed'],
        sourceType: ['album', 'camera'],
      });
      const selected = [];
      for (const file of result.tempFiles || []) {
        if (file.size > 5 * 1024 * 1024) throw new Error('请选择每张不超过 5 MB 的图片');
        selected.push({
          localPath: file.tempFilePath,
          url: file.tempFilePath,
          size: file.size,
          uploadRequestId: api.newRequestId(),
        });
      }
      this.setData({ memoImages: this.data.memoImages.concat(selected) });
    } catch (error) {
      if (!/cancel/.test(error.errMsg || '')) wx.showToast({ title: error.message || '选择图片失败', icon: 'none' });
    } finally {
      if (!this._disposed) this.setData({ memoSaving: false });
    }
  },
  removeMemoImage(e) {
    if (this.data.memoSaving || this.data.memoUncertain) return;
    const index = Number(e.currentTarget.dataset.index);
    this.setData({ memoImages: this.data.memoImages.filter((_, i) => i !== index) });
  },
  replaceMemoImage(index, item) {
    const images = this.data.memoImages.slice();
    images[index] = item;
    this.setData({ memoImages: images });
  },
  async uploadMemoImages() {
    for (let i = 0; i < this.data.memoImages.length; i++) {
      const item = Object.assign({}, this.data.memoImages[i]);
      if (item.id && !item.localPath) continue;
      if (!item.prepared) {
        try {
          item.prepared = await api.prepareMedia({ requestId: item.uploadRequestId, name: 'private-memo', size: item.size });
        } catch (error) {
          throw memoMediaError('准备上传', error);
        }
      }
      this.replaceMemoImage(i, item);
      if (!item.stagingFileID) {
        try {
          const uploaded = await wx.cloud.uploadFile({ cloudPath: item.prepared.cloudPath, filePath: item.localPath });
          item.stagingFileID = uploaded.fileID;
          this.replaceMemoImage(i, item);
        } catch (error) {
          throw memoMediaError('写入云存储', error);
        }
      }
      try {
        const confirmed = await api.confirmMedia({ id: item.prepared.id, fileID: item.stagingFileID });
        this.replaceMemoImage(i, confirmed);
      } catch (error) {
        if (['MEDIA_EXPIRED', 'MEDIA_UNAVAILABLE', 'INVALID_MEDIA_TYPE', 'INVALID_MEDIA_SIZE'].includes(error.code)) {
          delete item.prepared;
          delete item.stagingFileID;
          item.uploadRequestId = api.newRequestId();
          this.replaceMemoImage(i, item);
        }
        throw memoMediaError('服务端校验', error);
      }
    }
  },
  resetMemoEditor() {
    this._memoPending = null;
    this._memoEditVersion = 0;
    this.setData({ memoTitle: '', memoText: '', memoImages: [], memoEditingId: '', memoUncertain: false });
  },
  editMemo(e) {
    if (this.data.memoSaving || this.data.memoUncertain) return;
    const item = this.data.memoItems.find(row => row.id === e.currentTarget.dataset.id);
    if (!item) return;
    this._memoPending = null;
    this._memoEditVersion = item.version;
    this.setData({
      memoTitle: item.title || '',
      memoText: item.text || '',
      memoImages: (item.images || []).map(image => Object.assign({}, image)),
      memoEditingId: item.id,
      memoUncertain: false,
    });
    wx.pageScrollTo({ scrollTop: 0, duration: 250 });
  },
  cancelMemoEdit() {
    if (this.data.memoSaving || this.data.memoUncertain) return;
    this.resetMemoEditor();
  },
  async saveMemo() {
    if (this.data.memoSaving || this.data.authLoading || this.data.bindingStatus !== 'active') return;
    if (!this._memoPending && !this.data.memoTitle.trim() && !this.data.memoText.trim() && !this.data.memoImages.length) {
      return wx.showToast({ title: '写一点内容，或添加一张图片', icon: 'none' });
    }
    this.setData({ memoSaving: true });
    try {
      if (!this._memoPending) {
        await this.uploadMemoImages();
        const payload = {
          requestId: api.newRequestId(),
          title: this.data.memoTitle.trim(),
          text: this.data.memoText.trim(),
          images: this.data.memoImages.map(image => image.id),
        };
        if (this.data.memoEditingId) {
          payload.id = this.data.memoEditingId;
          payload.expectedVersion = this._memoEditVersion;
        }
        this._memoPending = payload;
      }
      const editing = !!this._memoPending.id;
      await (editing ? api.updatePrivateMemoItem(this._memoPending) : api.createPrivateMemo(this._memoPending));
      this.resetMemoEditor();
      const memos = await api.listPrivateMemos();
      this.setData({
        memoItems: (memos.items || []).map(item => Object.assign({}, item, {
          updatedLabel: dateLabel(item.updatedAt || item.createdAt),
          images: (item.images || []).map(image => Object.assign({}, image, { failed: false })),
        })),
      });
      wx.showToast({ title: '只保存给你自己', icon: 'none' });
    } catch (error) {
      const uncertain = !!this._memoPending && isUncertain(error);
      if (!uncertain) this._memoPending = null;
      this.setData({ memoUncertain: uncertain });
      wx.showToast({ title: uncertain ? '保存结果待确认，请重试' : (error.message || '备忘录保存失败'), icon: 'none' });
    } finally {
      if (!this._disposed) this.setData({ memoSaving: false });
    }
  },
  async deleteMemo(e) {
    if (this.data.memoSaving || this.data.memoDeletingId) return;
    const item = this.data.memoItems.find(row => row.id === e.currentTarget.dataset.id);
    if (!item) return;
    const result = await wxCall('showModal', {
      title: '删除这条备忘录？',
      content: '只会删除你自己的这条私密备忘录。',
      confirmText: '删除',
      confirmColor: '#be3850',
    }).catch(() => null);
    if (!result || !result.confirm) return;
    this.setData({ memoDeletingId: item.id });
    try {
      await api.deletePrivateMemo({ requestId: api.newRequestId(), id: item.id, expectedVersion: item.version });
      this.setData({ memoItems: this.data.memoItems.filter(row => row.id !== item.id) });
      if (this.data.memoEditingId === item.id) this.resetMemoEditor();
      wx.showToast({ title: '已删除', icon: 'none' });
    } catch (error) {
      wx.showToast({ title: error.message || '删除失败，请重试', icon: 'none' });
    } finally {
      if (!this._disposed) this.setData({ memoDeletingId: '' });
    }
  },
  async previewMemoImages(e) {
    const item = this.data.memoItems.find(row => row.id === e.currentTarget.dataset.id);
    if (!item || !(item.images || []).length) return;
    const ids = item.images.map(image => image.id);
    try {
      const result = await api.getMediaUrls(ids);
      const urls = new Map((result.items || []).map(image => [image.id, image.url]));
      const memoItems = this.data.memoItems.map(row => row.id !== item.id ? row : Object.assign({}, row, {
        images: row.images.map(image => Object.assign({}, image, { url: urls.get(image.id) || image.url })),
      }));
      this.setData({ memoItems });
      const current = memoItems.find(row => row.id === item.id);
      const available = current.images.filter(image => image.url);
      const chosen = available.find(image => image.id === e.currentTarget.dataset.photoid);
      if (!available.length) throw new Error('图片暂时无法查看');
      wx.previewImage({ current: chosen ? chosen.url : available[0].url, urls: available.map(image => image.url) });
    } catch (error) {
      wx.showToast({ title: error.message || '图片加载失败', icon: 'none' });
    }
  },
  chooseMood(e) { if (this.data.saving || this.data.authLoading) return; this._dirty = true; this._draftRevision = (this._draftRevision || 0) + 1; this.setData({ moodEmoji: e.currentTarget.dataset.emoji }); },
  onMoodTextInput(e) { if (this.data.saving) return; this._dirty = true; this._draftRevision = (this._draftRevision || 0) + 1; this.setData({ moodText: e.detail.value }); },
  async saveMood() {
    if (this.data.saving || this.data.authLoading || this.data.bindingStatus !== 'active') return;
    if (!this.data.moodEmoji && !this.data.moodText.trim()) return wx.showToast({ title: '选一个心情，或写一句感受', icon: 'none' });
    this._loadToken = (this._loadToken || 0) + 1; this.setData({ saving: true });
    try {
      const me = profile(await api.updateMood(this.data.moodEmoji, this.data.moodText.trim()));
      this._dirty = false;
      this.setData({ moodEmoji: me.moodEmoji, moodText: me.moodText, savedMoodEmoji: me.moodEmoji, savedMoodText: me.moodText, myUpdatedLabel: me.moodUpdatedLabel });
      wx.showToast({ title: 'TA 已经可以看到啦', icon: 'none' });
    } catch (error) { wx.showToast({ title: error.message || '更新失败', icon: 'none' }); }
    finally { if (!this._disposed) this.setData({ saving: false }); }
  },
  async onReminderToggle(e) {
    if (this.data.reminderSaving || this.data.authLoading || !this.data.reminderReady || this.data.bindingStatus !== 'active') return;
    const enabled = !!e.detail.value; this.setData({ reminderSaving: true });
    try {
      if (enabled) {
        const result = await wxCall('requestSubscribeMessage', { tmplIds: [TEMPLATE] });
        if (result[TEMPLATE] !== 'accept') { this.setData({ reminderEnabled: false }); wx.showToast({ title: '允许订阅后才能开启提醒', icon: 'none' }); return; }
      }
      this.applyReminder(await api.updateReminderSettings(enabled, this.data.reminderTime, this._reminderVersion));
    } catch (error) {
      this.setData({ reminderReady: false, error: error.message || '设置未确认，请刷新后重试' });
      try { this.applyReminder(await api.getReminderSettings()); } catch (_) {}
    } finally { if (!this._disposed) this.setData({ reminderSaving: false }); }
  },
  async onReminderTimeChange(e) {
    if (this.data.reminderSaving || this.data.authLoading || !this.data.reminderReady) return;
    const time = TIMES[Number(e.detail.value)]; if (!time) return;
    this.setData({ reminderSaving: true });
    try { this.applyReminder(await api.updateReminderSettings(this.data.reminderEnabled, time, this._reminderVersion)); }
    catch (error) {
      this.setData({ reminderReady: false, error: error.message || '设置未确认，请刷新后重试' });
      try { this.applyReminder(await api.getReminderSettings()); } catch (_) {}
    } finally { if (!this._disposed) this.setData({ reminderSaving: false }); }
  },
});
