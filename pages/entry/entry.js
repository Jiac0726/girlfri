const api = require('../../services/cloud');
const view = require('../../services/entry-view');
const drafts = require('../../services/entry-drafts');

function mediaError(stage, error) {
  const raw = String((error && (error.errMsg || error.message)) || error || '未知错误');
  console.error('[media-upload]', {
    stage,
    code: error && error.code,
    errMsg: error && error.errMsg,
    message: error && error.message,
    raw: error,
  });
  const wrapped = new Error('图片上传失败（' + stage + '）：' + raw);
  wrapped.code = (error && error.code) || 'MEDIA_UPLOAD_FAILED';
  wrapped.raw = error;
  return wrapped;
}

Page({
  data: { loading: true, saving: false, error: '', text: '', mood: '', ratingType: '', images: [], moods: view.MOODS, ratings: view.RATINGS, uncertain: false, editing: false },
  onLoad(options) { this._id = options.id || ''; this.setData({ editing: !!this._id }); this.load(); },
  onUnload() { this.persist(); this._disposed = true; },
  persist() {
    if (this._scope && !this._completed) drafts.write(this._scope, this._id, {
      text: this.data.text, mood: this.data.mood, ratingType: this.data.ratingType, images: this.data.images, version: this._version, pending: this._pending || null,
    });
  },
  async load() {
    this._ready = false;
    this.setData({ loading: true, error: '' });
    try {
      const session = await api.getSession();
      if (session.bindingStatus !== 'active' || !session.coupleId) throw new Error('请先完成双人绑定');
      this._scope = session.coupleId; drafts.activate(this._scope);
      const cached = drafts.read(this._scope, this._id);
      if (cached) {
        this._version = cached.version; this._pending = cached.pending;
        this.setData({ text: cached.text, mood: cached.mood, ratingType: cached.ratingType || '', images: cached.images, uncertain: !!cached.pending });
      } else if (this._id) {
        const entry = await api.getEntry(this._id);
        if (!entry.fromMe) throw new Error('只能编辑自己的日常');
        this._version = entry.version;
        this.setData({ text: entry.text, mood: entry.mood, ratingType: entry.ratingType || '', images: entry.images });
      }
      this._ready = true;
    } catch (error) { this.setData({ error: error.message || '加载失败，请重试' }); }
    finally { if (!this._disposed) this.setData({ loading: false }); }
  },
  onText(e) { if (!this.data.saving && !this.data.uncertain) { this.setData({ text: e.detail.value }); this.persist(); } },
  chooseMood(e) {
    if (this.data.saving || this.data.uncertain) return;
    this.setData({ mood: this.data.mood === e.currentTarget.dataset.emoji ? '' : e.currentTarget.dataset.emoji }); this.persist();
  },
  chooseRating(e) {
    if (this.data.saving || this.data.uncertain) return;
    const type = e.currentTarget.dataset.type || '';
    this.setData({ ratingType: this.data.ratingType === type ? '' : type }); this.persist();
  },
  async chooseImages() {
    if (!this._ready || this.data.saving || this.data.uncertain || this.data.images.length >= 9) return;
    this.setData({ saving: true });
    try {
      const result = await view.wxCall('chooseMedia', { count: 9 - this.data.images.length, mediaType: ['image'], sizeType: ['compressed'], sourceType: ['album', 'camera'] });
      const selected = [];
      for (const file of result.tempFiles) {
        if (file.size > 5 * 1024 * 1024) throw new Error('请选择每张不超过 5 MB 的图片');
        selected.push({ localPath: file.tempFilePath, url: file.tempFilePath, size: file.size, uploadRequestId: api.newRequestId() });
      }
      this.setData({ images: this.data.images.concat(selected) }); this.persist();
    } catch (error) { if (!/cancel/.test(error.errMsg || '')) wx.showToast({ title: error.message || '选择图片失败', icon: 'none' }); }
    finally { if (!this._disposed) this.setData({ saving: false }); }
  },
  removeImage(e) {
    if (this.data.saving || this.data.uncertain) return;
    this.setData({ images: this.data.images.filter((_, i) => i !== Number(e.currentTarget.dataset.index)) }); this.persist();
  },
  async uploadImages() {
    for (let i = 0; i < this.data.images.length; i++) {
      const item = Object.assign({}, this.data.images[i]);
      if (item.id && !item.localPath) continue;
      if (!item.prepared) {
        try {
          item.prepared = await api.prepareMedia({ requestId: item.uploadRequestId, name: 'photo', size: item.size });
        } catch (error) {
          throw mediaError('准备上传', error);
        }
      }
      this.replaceImage(i, item);
      if (!item.stagingFileID) {
        try {
          const uploaded = await wx.cloud.uploadFile({ cloudPath: item.prepared.cloudPath, filePath: item.localPath });
          item.stagingFileID = uploaded.fileID;
          this.replaceImage(i, item);
        } catch (error) {
          throw mediaError('写入云存储', error);
        }
      }
      try {
        const confirmed = await api.confirmMedia({ id: item.prepared.id, fileID: item.stagingFileID });
        this.replaceImage(i, confirmed);
      } catch (error) {
        if (['MEDIA_EXPIRED', 'MEDIA_UNAVAILABLE', 'INVALID_MEDIA_TYPE', 'INVALID_MEDIA_SIZE'].includes(error.code)) {
          delete item.prepared; delete item.stagingFileID; item.uploadRequestId = api.newRequestId(); this.replaceImage(i, item);
        }
        throw mediaError('服务端校验', error);
      }
    }
  },
  replaceImage(index, item) { const images = this.data.images.slice(); images[index] = item; this.setData({ images }); this.persist(); },
  async save() {
    if (!this._ready || this.data.saving || this.data.loading) return;
    if (!this._pending && !this.data.text.trim() && !this.data.mood && !this.data.ratingType && !this.data.images.length) return wx.showToast({ title: '写点文字、选张照片、心情或打个分', icon: 'none' });
    this.setData({ saving: true, error: '' });
    try {
      if (!this._pending) {
        await this.uploadImages();
        this._pending = { requestId: api.newRequestId(), text: this.data.text.trim(), mood: this.data.mood, ratingType: this.data.ratingType, images: this.data.images.map(x => x.id) };
        if (this._id) Object.assign(this._pending, { id: this._id, expectedVersion: this._version });
        this.persist();
      }
      await (this._id ? api.updateEntry(this._pending) : api.createEntry(this._pending));
      this._completed = true; drafts.remove(this._scope, this._id);
      wx.showToast({ title: 'TA 已经可以看到了', icon: 'none' });
      wx.navigateBack({ fail: () => wx.switchTab({ url: '/pages/index/index' }) });
    } catch (error) {
      const uncertain = !!this._pending && view.isUncertain(error);
      if (!uncertain) this._pending = null;
      this.setData({ uncertain, error: uncertain ? '尚未确认保存结果，内容已保留。请点“重试确认”，不会重复发布。' : (error.message || '保存失败，内容已保留') });
      if (error.code === 'VERSION_CONFLICT') {
        const latest = await api.getEntry(this._id).catch(() => null);
        if (latest) { this._version = latest.version; this.setData({ error: '这条日常已在别处更新。你的草稿已保留，再次保存将覆盖当前版本。' }); }
      }
      this.persist();
    } finally { if (!this._disposed) this.setData({ saving: false }); }
  },
});
