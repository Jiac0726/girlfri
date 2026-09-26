const api = require('../../services/cloud');
const { MOODS, wxCall } = require('../../services/entry-view');
const { dateLabel } = require('../../helpers/interactions');
const TEMPLATE = 'tb0gjEGNaTQfOvLVKNdWKekwa3fSTdyCQkkTSpuNjtk';
const TIMES = ['20:00','20:30','21:00','21:30','22:00','22:30'];
function profile(x) { return Object.assign({ moodEmoji: '', moodText: '', hasMood: false }, x || {}, { moodUpdatedLabel: dateLabel(x && x.moodUpdatedAt) }); }
Page({
  data: { moods: MOODS, authLoading: true, saving: false, bindingStatus: 'loading', moodEmoji: '', moodText: '', savedMoodEmoji: '', savedMoodText: '', myUpdatedLabel: '', partner: profile(), pendingAgreementCount: 0, pendingCouponCount: 0,
    memoSaving: false, privateMemo: '', savedPrivateMemo: '', memoUpdatedLabel: '',
    reminderSaving: false, reminderEnabled: false, reminderReady: false, reminderTime: '21:30', reminderTimeOptions: TIMES, reminderTimeIndex: 3, reminderStatusText: '未开启提醒', error: '' },
  onShow() { this._disposed = false; this.loadProfile(); },
  onUnload() { this._disposed = true; this._loadToken = (this._loadToken || 0) + 1; },
  async onPullDownRefresh() { try { await this.loadProfile(); } finally { wx.stopPullDownRefresh(); } },
  async loadProfile() {
    if (this.data.saving || this.data.memoSaving || this.data.reminderSaving) return;
    const token = this._loadToken = (this._loadToken || 0) + 1, revision = this._draftRevision || 0;
    this.setData({ authLoading: true, error: '' });
    try {
      const session = await api.getSession();
      if (token !== this._loadToken) return;
      const changed = this._scope !== session.coupleId; this._scope = session.coupleId;
      if (changed) {
        this._dirty = false;
        this._memoDirty = false;
        this._memoVersion = 0;
        this.setData({
          moodEmoji: '', moodText: '', savedMoodEmoji: '', savedMoodText: '',
          privateMemo: '', savedPrivateMemo: '', memoUpdatedLabel: '',
          partner: profile(), pendingAgreementCount: 0, pendingCouponCount: 0, reminderReady: false,
        });
      }
      this.setData({ bindingStatus: session.bindingStatus });
      if (session.bindingStatus !== 'active') { this.setData({ reminderEnabled: false, reminderReady: false }); return; }
      const [data, reminder] = await Promise.all([api.getProfile(), api.getReminderSettings()]);
      if (token !== this._loadToken) return;
      const me = profile(data.me);
      const memo = data.privateMemo || { text: '', updatedAt: '', version: 0 };
      this._memoVersion = memo.version || 0;
      const update = {
        savedMoodEmoji: me.moodEmoji,
        savedMoodText: me.moodText,
        myUpdatedLabel: me.moodUpdatedLabel,
        savedPrivateMemo: memo.text || '',
        memoUpdatedLabel: dateLabel(memo.updatedAt),
        partner: profile(data.partner),
        pendingAgreementCount: data.pendingAgreementCount,
        pendingCouponCount: data.pendingCouponCount,
      };
      if (!this._dirty && revision === (this._draftRevision || 0)) Object.assign(update, { moodEmoji: me.moodEmoji, moodText: me.moodText });
      if (!this._memoDirty) update.privateMemo = memo.text || '';
      this.setData(update);
      this.applyReminder(reminder);
    } catch (error) {
      if (token !== this._loadToken) return;
      this.setData({ error: error.message || '加载失败，请重试', reminderReady: false });
      if (api.isBindingError(error)) this.setData({ bindingStatus: 'unbound', partner: profile() });
    } finally { if (token === this._loadToken) this.setData({ authLoading: false }); }
  },
  applyReminder(value) {
    this._reminderVersion = value.version;
    this.setData({ reminderReady: true, reminderEnabled: !!value.enabled, reminderTime: value.time, reminderTimeIndex: TIMES.indexOf(value.time),
      reminderStatusText: value.enabled ? '已授权：当天未分享，将在 ' + value.time + ' 提醒' : value.needsRenewal ? '本次授权已使用或失效，可再次开启' : '未开启提醒' });
  },
  goBind() { wx.navigateTo({ url: '/pages/bind/bind' }); },
  goAgreements() { wx.navigateTo({ url: '/pages/permissions/permissions' }); },
  goCoupons() { wx.navigateTo({ url: '/pages/privileges/privileges' }); },
  onPrivateMemoInput(e) {
    if (this.data.memoSaving || this.data.authLoading) return;
    this._memoDirty = true;
    this.setData({ privateMemo: e.detail.value });
  },
  async savePrivateMemo() {
    if (this.data.memoSaving || this.data.authLoading || this.data.bindingStatus !== 'active' || !this._memoDirty) return;
    this.setData({ memoSaving: true });
    try {
      const memo = await api.updatePrivateMemo(this.data.privateMemo, this._memoVersion || 0);
      this._memoVersion = memo.version || 0;
      this._memoDirty = false;
      this.setData({
        privateMemo: memo.text || '',
        savedPrivateMemo: memo.text || '',
        memoUpdatedLabel: dateLabel(memo.updatedAt),
      });
      wx.showToast({ title: '只保存给你自己', icon: 'none' });
    } catch (error) {
      if (error.code === 'VERSION_CONFLICT') this._memoDirty = true;
      wx.showToast({ title: error.message || '备忘录保存失败', icon: 'none' });
    } finally {
      if (!this._disposed) this.setData({ memoSaving: false });
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
