'use strict';

const { assert, hash, text, iso, version } = require('./v2-core');

function createAlbums(ctx, media) {
  const { db, membership, ownedDocument, mutate, put, page } = ctx;
  const albumView = doc => ({ id: doc._id, title: doc.title, photoCount: doc.photoCount || 0, createdAt: iso(doc.createdAt) });
  async function list(event, openid) {
    const member = await membership(db, openid);
    const result = await page('albums', { coupleId: member.pair._id }, event);
    return { items: result.items.map(albumView), nextCursor: result.nextCursor };
  }
  async function create(event, openid) {
    const title = text(event.title, 40, '相册名称', true);
    return mutate('album.create', event, openid, async (tx, member, op) => {
      const doc = { _id: 'album_' + hash(op).slice(0, 40), coupleId: member.pair._id,
        title, creatorOpenid: openid, photoCount: 0, createdAt: new Date() };
      await put(tx, 'albums', doc._id, doc);
      return albumView(doc);
    });
  }
  async function photos(event, openid) {
    const member = await membership(db, openid);
    const album = await ownedDocument(db, 'albums', event.albumId, member.pair._id);
    const result = await page('photos', { coupleId: member.pair._id, albumId: album._id, deleted: false }, event);
    const images = await media.albumImages(result.items);
    return { album: albumView(album), nextCursor: result.nextCursor, items: result.items.map((doc, i) => ({
      id: doc._id, mediaId: doc.mediaId, url: images[i].url, fromMe: doc.authorOpenid === openid,
      version: doc.version, createdAt: iso(doc.createdAt),
    })) };
  }
  async function add(event, openid) {
    assert(Array.isArray(event.images) && event.images.length > 0 && event.images.length <= 9 &&
      event.images.every(id => typeof id === 'string') && new Set(event.images).size === event.images.length,
    'INVALID_MEDIA', '每次请选择 1～9 张不同的照片');
    return mutate('album.addPhotos', event, openid, async (tx, member, op) => {
      const album = await ownedDocument(tx, 'albums', event.albumId, member.pair._id);
      const now = new Date(), ids = [];
      for (let i = 0; i < event.images.length; i++) {
        const mediaId = event.images[i];
        const doc = await ownedDocument(tx, 'media', mediaId, member.pair._id);
        assert(doc.ownerOpenid === openid, 'FORBIDDEN', '只能上传自己的照片');
        assert(doc.status === 'ready' && !doc.entryId && new Date(doc.expiresAt).getTime() > Date.now(), 'MEDIA_UNAVAILABLE', '照片已使用或已过期，请重新选择');
        const id = 'photo_' + hash(op + ':' + i).slice(0, 40);
        await put(tx, 'photos', id, { _id: id, coupleId: member.pair._id, albumId: album._id,
          authorOpenid: openid, mediaId, createdAt: now, deleted: false, version: 1 });
        await put(tx, 'media', mediaId, Object.assign({}, doc, { status: 'attached', attachmentType: 'album_photo', entryId: id, refCount: 1, expiresAt: null, updatedAt: now }));
        ids.push(id);
      }
      await put(tx, 'albums', album._id, Object.assign({}, album, { photoCount: (album.photoCount || 0) + ids.length }));
      // Return only the committed result: signing or list refresh cannot undo this mutation.
      return { ids, albumId: album._id };
    });
  }
  async function remove(event, openid) {
    return mutate('album.deletePhoto', event, openid, async (tx, member) => {
      const photo = await ownedDocument(tx, 'photos', event.id, member.pair._id);
      assert(photo.authorOpenid === openid, 'FORBIDDEN', '只能删除自己上传的照片');
      assert(!photo.deleted, 'PHOTO_DELETED', '照片已删除');
      version(photo, event.expectedVersion);
      const album = await ownedDocument(tx, 'albums', photo.albumId, member.pair._id);
      const doc = await ownedDocument(tx, 'media', photo.mediaId, member.pair._id);
      assert(doc.ownerOpenid === openid && doc.status === 'attached' && doc.attachmentType === 'album_photo' && doc.entryId === photo._id,
        'MEDIA_UNAVAILABLE', '照片状态已改变，请刷新');
      const now = new Date();
      await put(tx, 'photos', photo._id, Object.assign({}, photo, { deleted: true, version: photo.version + 1, updatedAt: now }));
      await put(tx, 'media', doc._id, Object.assign({}, doc, { status: 'cleanup_pending', refCount: 0, cleanupAfter: now, updatedAt: now }));
      await put(tx, 'albums', album._id, Object.assign({}, album, { photoCount: Math.max(0, (album.photoCount || 0) - 1) }));
      return { id: photo._id, deleted: true };
    });
  }
  return { list, create, photos, add, remove };
}
module.exports = { createAlbums };
