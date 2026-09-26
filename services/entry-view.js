const api = require('./cloud');
const MOODS = [
  { emoji: '🥰', label: '甜甜的' }, { emoji: '😊', label: '开心' },
  { emoji: '😌', label: '平静' }, { emoji: '🥺', label: '想抱抱' },
  { emoji: '😤', label: '有点气' }, { emoji: '😢', label: '难过' },
  { emoji: '😴', label: '累了' }, { emoji: '🤍', label: '想安静' },
];
const pad = (n) => String(n).padStart(2, '0');
function todayUTC8(session) {
  const supplied = session && session.serverDate;
  if (/^\d{4}-\d{2}-\d{2}$/.test(supplied || '')) return supplied;
  return new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10);
}
function timeLabel(value) {
  const time = new Date(value).getTime();
  if (!Number.isFinite(time)) return '';
  const d = new Date(time + 8 * 3600000);
  return pad(d.getUTCHours()) + ':' + pad(d.getUTCMinutes());
}
function dayLabel(day, today) {
  if (day === today) return '今天';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day || '')) return '';
  const parts = day.split('-');
  return (today && parts[0] === today.slice(0, 4) ? '' : parts[0] + '年') +
    Number(parts[1]) + '月' + Number(parts[2]) + '日';
}
function viewEntry(entry, today) {
  return Object.assign({}, entry, {
    authorLabel: entry.fromMe ? '我' : 'TA', dateLabel: dayLabel(entry.dayKey, today),
    timeLabel: timeLabel(entry.createdAt),
    images: (entry.images || []).map((image) => Object.assign({}, image, { failed: false })),
  });
}
function viewEntries(items, today) {
  return (Array.isArray(items) ? items : []).filter((item) => !item.deleted).map((item) => viewEntry(item, today));
}
function appendEntries(current, incoming) {
  const seen = new Set(current.map((item) => item.id));
  return current.concat(incoming.filter((item) => !seen.has(item.id)));
}
function wxCall(name, options) {
  return new Promise((resolve, reject) => wx[name](Object.assign({}, options, { success: resolve, fail: reject })));
}
function isUncertain(error) {
  return !error || !error.code || ['CLOUD_INVOKE_FAILED', 'UNKNOWN', 'INTERNAL_ERROR', 'INTERNAL'].includes(error.code);
}
function updateUrls(entries, urls, ids) {
  const byId = {};
  (urls || []).forEach((item) => { byId[item.id] = item.url; });
  return entries.map((entry) => Object.assign({}, entry, {
    images: (entry.images || []).map((image) => ids.includes(image.id)
      ? Object.assign({}, image, { url: byId[image.id] || '', failed: !byId[image.id] }) : image),
  }));
}
// Timeline and calendar share ownership checks, confirmation and temporary media URLs.
const entryActions = {
  editEntry(e) {
    if (this.data.loading || this.data.authLoading || this.data.busyEntryId) return;
    const item = this.data.entries.find((row) => row.id === e.currentTarget.dataset.id);
    if (item && item.fromMe) wx.navigateTo({ url: '/pages/entry/entry?id=' + encodeURIComponent(item.id) });
  },
  async deleteEntry(e) {
    if (this.data.loading || this.data.authLoading || this.data.busyEntryId) return;
    const item = this.data.entries.find((row) => row.id === e.currentTarget.dataset.id);
    if (!item || !item.fromMe) return;
    const scope = this._scope;
    const result = await wxCall('showModal', {
      title: '删除这条日常？', content: '删除后，你和 TA 都将看不到这条记录。',
      confirmText: '删除', confirmColor: '#be3850',
    }).catch(() => null);
    if (!result || !result.confirm || this._scope !== scope || this.data.busyEntryId || this._disposed) return;
    this._deleteRequests = this._deleteRequests || {};
    const requestId = this._deleteRequests[item.id] || api.newRequestId();
    this._deleteRequests[item.id] = requestId;
    this.setData({ busyEntryId: item.id });
    try {
      await api.deleteEntry({ requestId, id: item.id, expectedVersion: item.version });
      if (this._scope !== scope || this._disposed) return;
      delete this._deleteRequests[item.id];
      this.setData({ entries: this.data.entries.filter((row) => row.id !== item.id) });
      wx.showToast({ title: '已删除', icon: 'none' });
      await this.afterEntryDeleted();
    } catch (error) {
      if (!isUncertain(error)) delete this._deleteRequests[item.id];
      if (this._scope === scope && !this._disposed) {
        wx.showToast({ title: error.message || '删除未完成，请重试', icon: 'none' });
        if (error.code === 'VERSION_CONFLICT') await this.afterEntryDeleted();
      }
    } finally { if (!this._disposed) this.setData({ busyEntryId: '' }); }
  },
  async previewImages(e) {
    const item = this.data.entries.find((row) => row.id === e.currentTarget.dataset.id);
    if (!item || !(item.images || []).length) return;
    const scope = this._scope;
    const ids = item.images.map((image) => image.id);
    try {
      const result = await api.getMediaUrls(ids);
      if (this._scope !== scope || this._disposed) return;
      this.setData({ entries: updateUrls(this.data.entries, result.items, ids) });
      const currentEntry = this.data.entries.find((row) => row.id === item.id);
      if (!currentEntry) return;
      const available = currentEntry.images.filter((image) => image.url);
      const chosen = available.find((image) => image.id === e.currentTarget.dataset.photoid);
      if (!available.length) throw new Error('图片暂时无法查看，请稍后重试');
      wx.previewImage({ current: chosen ? chosen.url : available[0].url, urls: available.map((image) => image.url) });
    } catch (error) {
      if (!this._disposed && this._scope === scope) wx.showToast({ title: error.message || '图片加载失败，请重试', icon: 'none' });
    }
  },
  async onEntryImageError(e) {
    const id = e.currentTarget.dataset.photoid;
    if (!id) return;
    const scope = this._scope;
    this._imageRetries = this._imageRetries || {};
    if (this._imageRetries[id]) { this.setData({ entries: updateUrls(this.data.entries, [], [id]) }); return; }
    this._imageRetries[id] = true;
    try {
      const result = await api.getMediaUrls([id]);
      if (this._scope === scope && !this._disposed) this.setData({ entries: updateUrls(this.data.entries, result.items, [id]) });
    } catch (_) {
      if (this._scope === scope && !this._disposed) this.setData({ entries: updateUrls(this.data.entries, [], [id]) });
    }
  },
};
module.exports = { MOODS, todayUTC8, dayLabel, viewEntry, viewEntries, appendEntries, wxCall, isUncertain, entryActions };
