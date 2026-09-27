const api = require('../../services/cloud');
const { wxCall, isUncertain } = require('../../services/entry-view');

Page({
  data: { loading: true, busy: false, active: false, error: '', moreError: '', title: '', album: null,
    albumId: '', items: [], nextCursor: null, images: [], pending: false, progress: '', creating: false },
  onLoad(options) { this._albumId = options.albumId || ''; this.setData({ albumId: this._albumId }); },
  onShow() { this._disposed = false; if (!this.data.busy) this.refresh(); },
  onUnload() { this.persist(); this._disposed = true; this._token = (this._token || 0) + 1; },
  onPullDownRefresh() { this.refresh().finally(() => wx.stopPullDownRefresh()); },
  onReachBottom() { this.loadMore(); },
  persist() {
    if (!this._key) return;
    try { wx.setStorageSync(this._key, { images: this.data.images, pending: this._pending || null, title: this.data.title }); }
    catch (_) { /* In-memory operation identity still remains available for this session. */ }
  },
  async refresh() {
    if (this.data.busy) return;
    const token = this._token = (this._token || 0) + 1;
    this.setData({ loading: true, error: '', moreError: '' });
    try {
      const session = await api.getSession();
      if (token !== this._token || this._disposed) return;
      const active = session.bindingStatus === 'active' && !!session.coupleId;
      this.setData({ active });
      if (!active) { this._key = ''; this._pending = null; this.setData({ items: [], images: [], album: null, pending: false, nextCursor: null }); return; }
      const key = 'renian-album:' + session.coupleId + ':' + (session.isCreator ? 'creator' : 'partner') + ':' + (this._albumId || 'list');
      if (key !== this._key) {
        this._key = key;
        let draft;
        try { draft = wx.getStorageSync(key); } catch (_) { /* No cached draft. */ }
        this._pending = draft && draft.pending || null;
        this.setData({ items: [], album: null, nextCursor: null, images: draft && draft.images || [],
          title: draft && draft.title || '', pending: !!this._pending, creating: !!this._pending && this._pending.kind === 'create' });
      }
      await this.fetchItems(false, token);
    } catch (error) { if (token === this._token && !this._disposed) this.showError(error); }
    finally { if (token === this._token && !this._disposed) this.setData({ loading: false }); }
  },
  async fetchItems(more, token = this._token) {
    const query = { limit: this._albumId ? 30 : 20, cursor: more ? this.data.nextCursor : null };
    const result = this._albumId ? await api.listAlbumPhotos(Object.assign(query, { albumId: this._albumId })) : await api.listAlbums(query);
    if (this._disposed || token !== this._token) return false;
    const items = more ? this.data.items.concat(result.items) : result.items;
    const seen = new Set();
    this.setData({ items: items.filter(item => !seen.has(item.id) && seen.add(item.id)), album: result.album || null, nextCursor: result.nextCursor || null });
    return true;
  },
  async loadMore() {
    if (this.data.loading || this.data.busy || !this.data.nextCursor) return;
    this.setData({ busy: true, moreError: '' });
    try { await this.fetchItems(true); }
    catch (error) { this.setData({ moreError: error.message || '加载失败，请重试' }); }
    finally { if (!this._disposed) this.setData({ busy: false }); }
  },
  showError(error) {
    if (api.isBindingError(error)) { this._key = ''; this._pending = null; this.setData({ active: false, items: [], images: [], album: null, pending: false, nextCursor: null }); }
    this.setData({ error: error.code === 'UNKNOWN_ACTION' ? '相册服务尚未更新，请更新云函数后再试' : (error.message || '暂时没有加载出来，请重试') });
  },
  goBind() { wx.navigateTo({ url: '/pages/bind/bind' }); },
  openAlbum(e) { if (!this.data.busy && !this.data.loading && !this.data.pending) wx.navigateTo({ url: '/pages/albums/albums?albumId=' + encodeURIComponent(e.currentTarget.dataset.id) }); },
  toggleCreate() { if (!this.data.pending && !this.data.busy) this.setData({ creating: !this.data.creating }); },
  onTitle(e) { if (!this.data.pending && !this.data.busy) { this.setData({ title: e.detail.value }); this.persist(); } },
  async createAlbum() {
    if (this.data.loading || this.data.busy || !this.data.active) return;
    if (!this._pending) {
      const title = this.data.title.trim();
      if (!title) return wx.showToast({ title: '给相册起个名字吧', icon: 'none' });
      this._pending = { kind: 'create', payload: { title, requestId: api.newRequestId() } };
    }
    return this.runPending();
  },
  async chooseImages() {
    if (this.data.loading || this.data.busy || this.data.pending || !this.data.active || this.data.images.length >= 9) return;
    this.setData({ busy: true });
    try {
      const result = await wxCall('chooseMedia', { count: 9 - this.data.images.length, mediaType: ['image'], sizeType: ['compressed'], sourceType: ['album', 'camera'] });
      const selected = result.tempFiles.map(file => {
        if (!file.size || file.size > 5 * 1024 * 1024) throw new Error('每张照片不能超过 5 MB');
        return { localPath: file.tempFilePath, url: file.tempFilePath, size: file.size, requestId: api.newRequestId() };
      });
      this.setData({ images: this.data.images.concat(selected), error: '' }); this.persist();
    } catch (error) { if (!/cancel/.test(error.errMsg || '')) this.showError(error); }
    finally { if (!this._disposed) this.setData({ busy: false }); }
  },
  removeSelected(e) {
    if (this.data.busy || this.data.pending) return;
    this.setData({ images: this.data.images.filter((_, i) => i !== Number(e.currentTarget.dataset.index)) }); this.persist();
  },
  updateImage(index, item) { const images = this.data.images.slice(); images[index] = item; this.setData({ images }); this.persist(); },
  async uploadPhotos() {
    if (this.data.busy || this.data.loading || !this.data.active || !this.data.images.length) return;
    if (this._pending) return this.runPending();
    this.setData({ busy: true, error: '' });
    try {
      for (let i = 0; i < this.data.images.length; i++) {
        const item = Object.assign({}, this.data.images[i]);
        if (item.id) continue;
        this.setData({ progress: '正在上传 ' + (i + 1) + ' / ' + this.data.images.length });
        try {
          if (!item.prepared) { item.prepared = await api.prepareMedia({ requestId: item.requestId, name: 'album-photo', size: item.size }); this.updateImage(i, item); }
          if (!item.fileID) { item.fileID = (await wx.cloud.uploadFile({ cloudPath: item.prepared.cloudPath, filePath: item.localPath })).fileID; this.updateImage(i, item); }
          const ready = await api.confirmMedia({ id: item.prepared.id, fileID: item.fileID });
          item.id = ready.id; this.updateImage(i, item);
        } catch (error) {
          if (['MEDIA_EXPIRED', 'MEDIA_UNAVAILABLE', 'INVALID_MEDIA_TYPE', 'INVALID_MEDIA_SIZE'].includes(error.code)) {
            delete item.prepared; delete item.fileID; item.requestId = api.newRequestId(); this.updateImage(i, item);
          }
          throw error;
        }
      }
      this._pending = { kind: 'add', payload: { requestId: api.newRequestId(), albumId: this._albumId, images: this.data.images.map(item => item.id) } };
      this.setData({ pending: true }); this.persist();
    } catch (error) { this.showError(error); }
    finally { this.setData({ busy: false, progress: '' }); }
    if (this._pending && !this._disposed) return this.runPending();
  },
  async deletePhoto(e) {
    if (this.data.busy || this.data.loading || this.data.pending) return;
    const photo = this.data.items.find(item => item.id === e.currentTarget.dataset.id);
    if (!photo || !photo.fromMe) return;
    const result = await wxCall('showModal', { title: '删除照片', content: '删除后双方都将看不到这张照片，确定删除吗？' });
    if (!result.confirm || this._disposed || this.data.busy || this.data.pending) return;
    this._pending = { kind: 'delete', payload: { requestId: api.newRequestId(), id: photo.id, expectedVersion: photo.version } };
    return this.runPending();
  },
  async runPending() {
    if (!this._pending || this.data.busy || !this.data.active) return;
    this.setData({ busy: true, pending: true, error: '' }); this.persist();
    const task = this._pending;
    try {
      if (task.kind === 'create') await api.createAlbum(task.payload);
      else if (task.kind === 'add') await api.addAlbumPhotos(task.payload);
      else await api.deleteAlbumPhoto(task.payload);
      task.committed = true; this.persist();
      if (!await this.fetchItems(false)) return;
      this._pending = null;
      this.setData({ pending: false, images: task.kind === 'add' ? [] : this.data.images, title: task.kind === 'create' ? '' : this.data.title, creating: false });
      this.persist(); wx.showToast({ title: '已保存', icon: 'success' });
    } catch (error) {
      if (!task.committed && !isUncertain(error)) {
        this._pending = null; this.setData({ pending: false });
        if (task.kind === 'add' && error.code === 'MEDIA_UNAVAILABLE') {
          this.setData({ images: this.data.images.map(item => ({ localPath: item.localPath, url: item.url, size: item.size, requestId: api.newRequestId() })) });
        }
      }
      this.showError(error);
      if (this._pending) this.setData({ error: '结果尚未确认，操作已保留。点击重试确认，不会重复保存。' });
      this.persist();
    } finally { if (!this._disposed) this.setData({ busy: false }); }
  },
  async previewPhoto(e) {
    if (this.data.loading || this.data.busy || !this.data.active) return;
    const photo = this.data.items.find(item => item.id === e.currentTarget.dataset.id);
    if (!photo) return;
    const token = this._token;
    try {
      const result = await api.getMediaUrls([photo.mediaId]);
      if (this._disposed || token !== this._token) return;
      const url = result.items[0] && result.items[0].url;
      if (!url) throw new Error('照片暂时无法加载，请重试');
      this.setData({ items: this.data.items.map(item => item.id === photo.id ? Object.assign({}, item, { url }) : item) });
      wx.previewImage({ current: url, urls: this.data.items.filter(item => item.url).map(item => item.url) });
    } catch (error) { wx.showToast({ title: error.message || '预览失败', icon: 'none' }); }
  },
  imageFailed(e) { this.setData({ items: this.data.items.map(item => item.id === e.currentTarget.dataset.id ? Object.assign({}, item, { url: '' }) : item) }); },
});
