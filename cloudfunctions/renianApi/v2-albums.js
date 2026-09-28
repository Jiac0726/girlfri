'use strict';

const { assert, hash, text, iso, version } = require('./v2-core');

const DAILY_ALBUM_TITLE = '日常照片';
const dailyAlbumId = coupleId => 'album_daily_' + hash(coupleId).slice(0, 40);
const dailyPhotoId = (entryId, mediaId) => 'photo_daily_' + hash(entryId + ':' + mediaId).slice(0, 40);

function createAlbums(ctx, media, security) {
  const { db, transaction, get, membership, ownedDocument, mutate, put, page } = ctx;
  const albumView = doc => ({ id: doc._id, title: doc.title, photoCount: doc.photoCount || 0, createdAt: iso(doc.createdAt) });
  const commentView = (doc, openid) => ({ id: doc._id, text: doc.text, fromMe: doc.authorOpenid === openid, createdAt: iso(doc.createdAt) });
  async function ensureDailyAlbumRecord(source, member) {
    const albumId = dailyAlbumId(member.pair._id);
    let album = await get(source, 'albums', albumId);
    if (album) return album;
    const now = new Date();
    album = { _id: albumId, coupleId: member.pair._id, title: DAILY_ALBUM_TITLE, creatorOpenid: '',
      photoCount: 0, system: true, kind: 'daily', createdAt: now, updatedAt: now };
    await put(source, 'albums', albumId, album);
    return album;
  }
  async function ensureDailyAlbum(openid) {
    const member = await membership(db, openid, false);
    if (!member.pair || member.pair.status !== 'active' || !member.user || member.user.status !== 'active') return null;
    const albumId = dailyAlbumId(member.pair._id);
    const existing = await get(db, 'albums', albumId);
    if (existing) return albumView(existing);
    const album = await transaction(async tx => {
      const activeMember = await membership(tx, openid);
      return ensureDailyAlbumRecord(tx, activeMember);
    });
    return albumView(album);
  }
  async function list(event, openid) {
    const member = await membership(db, openid);
    await ensureDailyAlbum(openid);
    const result = await page('albums', { coupleId: member.pair._id }, event);
    return { items: result.items.map(albumView), nextCursor: result.nextCursor };
  }
  async function captureEntryImages(tx, member, openid, entryId, mediaIds) {
    const album = await ensureDailyAlbumRecord(tx, member);
    const albumId = album._id;
    const now = new Date();
    if (!Array.isArray(mediaIds) || !mediaIds.length) return;
    let added = 0;
    for (const mediaId of mediaIds) {
      const photoId = dailyPhotoId(entryId, mediaId);
      const previous = await get(tx, 'photos', photoId);
      if (previous && !previous.deleted) continue;
      const doc = await ownedDocument(tx, 'media', mediaId, member.pair._id);
      assert(doc.ownerOpenid === openid && doc.status === 'attached' &&
        (!doc.attachmentType || doc.attachmentType === 'entry') && doc.entryId === entryId,
      'MEDIA_UNAVAILABLE', '日常照片状态已改变，请刷新');
      const photo = previous
        ? Object.assign({}, previous, { deleted: false, version: (previous.version || 1) + 1, updatedAt: now })
        : { _id: photoId, coupleId: member.pair._id, albumId, authorOpenid: openid, mediaId,
          sourceType: 'entry', sourceEntryId: entryId, commentCount: 0, createdAt: now, deleted: false, version: 1 };
      await put(tx, 'photos', photoId, photo);
      await put(tx, 'media', mediaId, Object.assign({}, doc, {
        refCount: Math.max(1, Number(doc.refCount) || 1) + 1,
        updatedAt: now,
      }));
      added++;
    }
    if (added) {
      await put(tx, 'albums', albumId, Object.assign({}, album, {
        photoCount: (album.photoCount || 0) + added,
        updatedAt: now,
      }));
    }
  }

  async function releaseEntryImages(tx, member, entryId, mediaIds) {
    if (!Array.isArray(mediaIds) || !mediaIds.length) return;
    for (const mediaId of mediaIds) {
      const photo = await get(tx, 'photos', dailyPhotoId(entryId, mediaId));
      if (!photo || photo.deleted) continue;
      const doc = await ownedDocument(tx, 'media', mediaId, member.pair._id);
      if (doc.status === 'attached' && (!doc.attachmentType || doc.attachmentType === 'entry') &&
          doc.entryId === entryId && (Number(doc.refCount) || 0) >= 1) {
        await put(tx, 'media', mediaId, Object.assign({}, doc, {
          attachmentType: 'album_photo',
          entryId: photo._id,
          refCount: Math.max(1, Number(doc.refCount) || 1),
          updatedAt: new Date(),
        }));
      }
    }
  }

  async function create(event, openid) {
    const title = text(event.title, 40, '相册名称', true);
    await security.checkText(title, openid, 4);
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
      version: doc.version, commentCount: Math.max(0, Number(doc.commentCount) || 0), createdAt: iso(doc.createdAt),
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
          authorOpenid: openid, mediaId, commentCount: 0, createdAt: now, deleted: false, version: 1 });
        await put(tx, 'media', mediaId, Object.assign({}, doc, { status: 'attached', attachmentType: 'album_photo', entryId: id, refCount: 1, expiresAt: null, updatedAt: now }));
        ids.push(id);
      }
      await put(tx, 'albums', album._id, Object.assign({}, album, { photoCount: (album.photoCount || 0) + ids.length }));
      // Return only the committed result: signing or list refresh cannot undo this mutation.
      return { ids, albumId: album._id };
    });
  }
  async function comments(event, openid) {
    const member = await membership(db, openid);
    const photo = await ownedDocument(db, 'photos', event.photoId, member.pair._id);
    assert(!photo.deleted, 'PHOTO_DELETED', '照片已删除');
    await ownedDocument(db, 'albums', photo.albumId, member.pair._id);
    const result = await page('comments', { coupleId: member.pair._id, photoId: photo._id }, event, 100);
    return { items: result.items.map(item => commentView(item, openid)), nextCursor: result.nextCursor };
  }

  async function addComment(event, openid) {
    const content = text(event.text, 200, '评论', true);
    await security.checkText(content, openid, 2);
    return mutate('album.commentAdd', event, openid, async (tx, member, op) => {
      const photo = await ownedDocument(tx, 'photos', event.photoId, member.pair._id);
      assert(!photo.deleted, 'PHOTO_DELETED', '照片已删除');
      const album = await ownedDocument(tx, 'albums', photo.albumId, member.pair._id);
      const now = new Date();
      const id = 'comment_' + hash(op).slice(0, 40);
      const comment = { _id: id, coupleId: member.pair._id, albumId: album._id, photoId: photo._id,
        authorOpenid: openid, text: content, createdAt: now };
      await put(tx, 'comments', id, comment);
      await put(tx, 'photos', photo._id, Object.assign({}, photo, {
        commentCount: Math.max(0, Number(photo.commentCount) || 0) + 1,
        updatedAt: now,
      }));
      return commentView(comment, openid);
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
      const entryBacked = !!photo.sourceEntryId && doc.ownerOpenid === openid && doc.status === 'attached' &&
        (!doc.attachmentType || doc.attachmentType === 'entry') && doc.entryId === photo.sourceEntryId &&
        (Number(doc.refCount) || 0) >= 2;
      const albumBacked = doc.ownerOpenid === openid && doc.status === 'attached' &&
        doc.attachmentType === 'album_photo' && doc.entryId === photo._id;
      assert(entryBacked || albumBacked, 'MEDIA_UNAVAILABLE', '照片状态已改变，请刷新');
      const now = new Date();
      await put(tx, 'photos', photo._id, Object.assign({}, photo, { deleted: true, version: photo.version + 1, updatedAt: now }));
      if (entryBacked) {
        await put(tx, 'media', doc._id, Object.assign({}, doc, {
          refCount: Math.max(1, (Number(doc.refCount) || 2) - 1),
          updatedAt: now,
        }));
      } else {
        await put(tx, 'media', doc._id, Object.assign({}, doc, { status: 'cleanup_pending', refCount: 0, cleanupAfter: now, updatedAt: now }));
      }
      await put(tx, 'albums', album._id, Object.assign({}, album, { photoCount: Math.max(0, (album.photoCount || 0) - 1) }));
      return { id: photo._id, deleted: true };
    });
  }
  return { list, create, photos, add, remove, comments, addComment, ensureDailyAlbum, ensureDailyAlbumForMember: ensureDailyAlbumRecord, captureEntryImages, releaseEntryImages };
}
module.exports = { createAlbums };
