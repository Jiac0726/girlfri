'use strict';

const { assert, fail, hash, randomId, text } = require('./v2-core');
const MAX_BYTES = 5 * 1024 * 1024;
const TTL = 24 * 3600000;
const LEASE = 5 * 60000;

function imageExtension(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 12) return '';
  if (buffer.length >= 33 && buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) && buffer.toString('ascii', 12, 16) === 'IHDR' && buffer.readUInt32BE(8) === 13 && buffer.readUInt32BE(16) > 0 && buffer.readUInt32BE(20) > 0) return 'png';
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff && buffer[buffer.length - 2] === 0xff && buffer[buffer.length - 1] === 0xd9) return 'jpg';
  if (/^GIF8[79]a$/.test(buffer.toString('ascii', 0, 6)) && buffer.readUInt16LE(6) > 0 && buffer.readUInt16LE(8) > 0 && buffer[buffer.length - 1] === 0x3b) return 'gif';
  if (buffer.length >= 20 && buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP' && buffer.readUInt32LE(4) + 8 === buffer.length && ['VP8 ', 'VP8L', 'VP8X'].includes(buffer.toString('ascii', 12, 16))) return 'webp';
  return '';
}

function createMedia(ctx) {
  const { cloud, db, get, put, membership, mutate, ownedDocument } = ctx;
  function parsedFile(fileID, path) {
    const environment = String((cloud.getWXContext() || {}).ENV || process.env.TCB_ENV || process.env.SCF_NAMESPACE || '');
    assert(environment, 'MEDIA_ENV_UNAVAILABLE', '图片服务暂时不可用');
    assert(typeof fileID === 'string' && fileID.length < 2000, 'INVALID_MEDIA_FILE', '图片文件标识不正确');
    const match = /^cloud:\/\/([^/]+)\/(.+)$/.exec(fileID);
    assert(match && (match[1] === environment || match[1].startsWith(environment + '.')) && match[2] === path && !/[?#%\\]/.test(match[2]), 'INVALID_MEDIA_FILE', '图片不属于本次上传');
    return { authority: match[1] };
  }
  async function signed(documents) {
    const ids = [...new Set(documents.map(m => m.fileID).filter(Boolean))];
    const urls = new Map();
    for (let start = 0; start < ids.length; start += 50) {
      const response = await cloud.getTempFileURL({ fileList: ids.slice(start, start + 50) });
      for (const item of response.fileList || []) {
        if ((item.status === undefined || item.status === 0) && item.tempFileURL) urls.set(item.fileID, item.tempFileURL);
      }
    }
    assert(ids.every(id => urls.has(id)), 'MEDIA_URL_FAILED', '图片暂时无法加载，请重试');
    return documents.map(doc => ({ id: doc._id, fileID: doc.fileID, url: urls.get(doc.fileID) || '' }));
  }
  async function prepare(event, openid) {
    const name = text(event.name, 200, '图片名称', true);
    assert(Number.isInteger(event.size) && event.size > 0 && event.size <= MAX_BYTES, 'INVALID_MEDIA_SIZE', '每张图片不能超过 5 MB');
    const doc = await mutate('media.prepare', event, openid, async (tx, member, op) => {
      const id = 'media_' + hash(op).slice(0, 40);
      const now = new Date();
      const value = { _id: id, ownerOpenid: openid, coupleId: member.pair._id, name, declaredSize: event.size,
        cloudPath: 'v2-upload/' + openid + '/' + randomId('upload'), status: 'prepared', entryId: '', refCount: 0,
        stagingFileID: '', fileID: '', stagingCleanupPending: false, createdAt: now, updatedAt: now,
        expiresAt: new Date(now.getTime() + TTL), cleanupAfter: null };
      await put(tx, 'media', id, value);
      return value;
    });
    const current = await get(db, 'media', doc._id);
    assert(current && ['prepared', 'confirming', 'ready', 'attached'].includes(current.status), 'MEDIA_EXPIRED', '上传已过期，请重新选择图片');
    // The client uploads only to the exact random path issued above. The returned
    // fileID is verified against this path and current environment during confirm,
    // so prepare does not need a second server SDK just to pre-compute fileID.
    return { id: doc._id, cloudPath: doc.cloudPath };
  }
  async function deleteStaging(doc) {
    if (!doc.stagingFileID) return;
    try {
      const response = await cloud.deleteFile({ fileList: [doc.stagingFileID] });
      const success = response.fileList && response.fileList.some(item => item.fileID === doc.stagingFileID && (item.status === 0 || item.status === -503003));
      if (success) await db.runTransaction(async tx => {
        const current = await get(tx, 'media', doc._id);
        if (current && current.stagingFileID === doc.stagingFileID) await put(tx, 'media', doc._id, Object.assign({}, current, { stagingCleanupPending: false, updatedAt: new Date() }));
      });
    } catch (_) { /* Preserve stagingCleanupPending for the privileged cleanup task. */ }
  }
  async function confirm(event, openid) {
    const token = randomId('confirm');
    const reserved = await db.runTransaction(async tx => {
      const member = await membership(tx, openid);
      const doc = await ownedDocument(tx, 'media', event.id, member.pair._id);
      assert(doc.ownerOpenid === openid, 'FORBIDDEN', '只能确认自己上传的图片');
      parsedFile(event.fileID, doc.cloudPath);
      if (doc.stagingFileID) {
        assert(doc.stagingFileID === event.fileID, 'INVALID_MEDIA_FILE', '图片不属于本次上传');
      }
      if (doc.status === 'ready' || doc.status === 'attached') {
        assert(doc.status === 'attached' || new Date(doc.expiresAt).getTime() > Date.now(), 'MEDIA_EXPIRED', '上传已过期，请重新选择图片');
        assert(doc.stagingFileID === event.fileID, 'INVALID_MEDIA_FILE', '图片不属于本次上传');
        return doc;
      }
      assert(doc.status === 'prepared', doc.status === 'confirming' ? 'MEDIA_PROCESSING' : 'MEDIA_UNAVAILABLE', '图片正在处理或已经失效，请稍后重试');
      assert(new Date(doc.expiresAt).getTime() > Date.now(), 'MEDIA_EXPIRED', '上传已过期，请重新选择图片');
      const changed = Object.assign({}, doc, { status: 'confirming', confirmToken: token, confirmLeaseUntil: new Date(Date.now() + LEASE), stagingFileID: event.fileID, stagingCleanupPending: true, updatedAt: new Date() });
      await put(tx, 'media', doc._id, changed);
      return changed;
    });
    if (reserved.status === 'ready' || reserved.status === 'attached') return (await signed([reserved]))[0];
    let uploadedFileID = '';
    try {
      const download = await cloud.downloadFile({ fileID: event.fileID });
      const buffer = Buffer.isBuffer(download.fileContent) ? download.fileContent : Buffer.from(download.fileContent || []);
      assert(buffer.length > 0 && buffer.length <= MAX_BYTES, 'INVALID_MEDIA_SIZE', '每张图片不能超过 5 MB');
      const extension = imageExtension(buffer);
      assert(extension, 'INVALID_MEDIA_TYPE', '请选择有效的 JPG、PNG、GIF 或 WebP 图片');
      const publishedCloudPath = 'v2-published/' + reserved._id + '.' + extension;
      const expectedFileID = 'cloud://' + parsedFile(event.fileID, reserved.cloudPath).authority + '/' + publishedCloudPath;
      await db.runTransaction(async tx => {
        const current = await get(tx, 'media', reserved._id);
        assert(current && current.status === 'confirming' && current.confirmToken === token && new Date(current.confirmLeaseUntil).getTime() > Date.now(), 'MEDIA_UNAVAILABLE', '上传处理已过期，请重新上传');
        await put(tx, 'media', current._id, Object.assign({}, current, { fileID: expectedFileID, publishedCloudPath, actualSize: buffer.length, extension, updatedAt: new Date() }));
      });
      const upload = await cloud.uploadFile({ cloudPath: publishedCloudPath, fileContent: buffer });
      uploadedFileID = upload.fileID;
      assert(uploadedFileID === expectedFileID, 'MEDIA_UPLOAD_FAILED', '图片保存失败，请重新上传');
      const ready = await db.runTransaction(async tx => {
        const member = await membership(tx, openid);
        const current = await ownedDocument(tx, 'media', reserved._id, member.pair._id);
        assert(current.status === 'confirming' && current.confirmToken === token && new Date(current.confirmLeaseUntil).getTime() > Date.now(), 'MEDIA_UNAVAILABLE', '上传处理已过期，请重新上传');
        const changed = Object.assign({}, current, { status: 'ready', fileID: uploadedFileID, confirmToken: '', confirmLeaseUntil: null, updatedAt: new Date() });
        await put(tx, 'media', changed._id, changed);
        return changed;
      });
      await deleteStaging(ready);
      return (await signed([ready]))[0];
    } catch (error) {
      // Invalid images are never made ready. Transient failures may retry the same upload;
      // a published object, when present, is always registered for privileged cleanup.
      await db.runTransaction(async tx => {
        const current = await get(tx, 'media', reserved._id);
        if (!current) return;
        if (current.status !== 'confirming' || current.confirmToken !== token) {
          if (uploadedFileID && !['ready', 'attached'].includes(current.status)) {
            await put(tx, 'media', current._id, Object.assign({}, current, { status: 'cleanup_pending', fileID: uploadedFileID, cleanupAfter: new Date(), updatedAt: new Date() }));
          }
          return;
        }
        const discard = error.isBusiness || !!current.fileID || !!uploadedFileID;
        await put(tx, 'media', current._id, Object.assign({}, current, { status: discard ? 'cleanup_pending' : 'prepared', fileID: uploadedFileID || current.fileID || '', cleanupAfter: discard ? new Date() : null, confirmToken: '', confirmLeaseUntil: null, updatedAt: new Date() }));
      });
      if (uploadedFileID) {
        const current = await get(db, 'media', reserved._id);
        if (!current || !['ready', 'attached'].includes(current.status)) {
          try { await cloud.deleteFile({ fileList: [uploadedFileID] }); } catch (_) { /* Registered cleanup retries. */ }
        }
      }
      throw error;
    }
  }
  async function urls(event, openid) {
    assert(Array.isArray(event.ids) && event.ids.length <= 100, 'INVALID_MEDIA', '图片参数不正确');
    const member = await membership(db, openid);
    const docs = [];
    for (const id of [...new Set(event.ids)]) {
      const doc = await ownedDocument(db, 'media', id, member.pair._id);
      if (doc.status === 'attached') {
        if (doc.attachmentType === 'private_memo') {
          assert(doc.ownerOpenid === openid, 'FORBIDDEN', '这张图片只属于你的私密备忘录');
          const memo = (member.user.privateMemoItems || []).find(item => item.id === doc.entryId);
          const legacyMemoId = 'memo_legacy_' + hash(openid).slice(0, 24);
          const legacyMatch = !member.user.privateMemoMigrated && member.user.privateMemo && doc.entryId === legacyMemoId;
          assert((memo && (memo.images || []).includes(id)) || legacyMatch, 'MEDIA_UNAVAILABLE', '图片已不可用');
        } else {
          const entry = await ownedDocument(db, 'entries', doc.entryId, member.pair._id);
          assert(!entry.deleted && entry.images.includes(id), 'MEDIA_UNAVAILABLE', '图片已不可用');
        }
      } else {
        assert(doc.status === 'ready' && doc.ownerOpenid === openid && new Date(doc.expiresAt).getTime() > Date.now(), 'FORBIDDEN', '图片尚未分享或已失效');
      }
      docs.push(doc);
    }
    return { items: (await signed(docs)).map(({ id, url }) => ({ id, url })) };
  }

  async function sync(tx, member, openid, entryId, before, after) {
    for (const id of after) {
      const doc = await ownedDocument(tx, 'media', id, member.pair._id);
      assert(doc.ownerOpenid === openid, 'FORBIDDEN', '只能分享自己上传的图片');
      if (before.includes(id)) {
        assert(doc.status === 'attached' && doc.entryId === entryId && (!doc.attachmentType || doc.attachmentType === 'entry'), 'MEDIA_UNAVAILABLE', '图片状态已改变');
      } else {
        assert(doc.status === 'ready' && !doc.entryId && new Date(doc.expiresAt).getTime() > Date.now(), 'MEDIA_UNAVAILABLE', '图片已使用或已过期，请重新上传');
        await put(tx, 'media', id, Object.assign({}, doc, { status: 'attached', entryId, attachmentType: 'entry', refCount: 1, expiresAt: null, updatedAt: new Date() }));
      }
    }
    for (const id of before.filter(id => !after.includes(id))) {
      const doc = await ownedDocument(tx, 'media', id, member.pair._id);
      assert(doc.entryId === entryId && doc.status === 'attached' && (!doc.attachmentType || doc.attachmentType === 'entry'), 'MEDIA_UNAVAILABLE', '图片状态已改变');
      await put(tx, 'media', id, Object.assign({}, doc, { status: 'cleanup_pending', refCount: 0, cleanupAfter: new Date(), updatedAt: new Date() }));
    }
  }

  async function syncPrivateMemo(tx, member, openid, memoId, before, after) {
    for (const id of after) {
      const doc = await ownedDocument(tx, 'media', id, member.pair._id);
      assert(doc.ownerOpenid === openid, 'FORBIDDEN', '只能使用自己上传的图片');
      if (before.includes(id)) {
        assert(doc.status === 'attached' && doc.entryId === memoId && doc.attachmentType === 'private_memo', 'MEDIA_UNAVAILABLE', '备忘录图片状态已改变');
      } else {
        assert(doc.status === 'ready' && !doc.entryId && new Date(doc.expiresAt).getTime() > Date.now(), 'MEDIA_UNAVAILABLE', '图片已使用或已过期，请重新上传');
        await put(tx, 'media', id, Object.assign({}, doc, {
          status: 'attached',
          entryId: memoId,
          attachmentType: 'private_memo',
          refCount: 1,
          expiresAt: null,
          updatedAt: new Date(),
        }));
      }
    }
    for (const id of before.filter(id => !after.includes(id))) {
      const doc = await ownedDocument(tx, 'media', id, member.pair._id);
      assert(doc.ownerOpenid === openid && doc.entryId === memoId && doc.attachmentType === 'private_memo' && doc.status === 'attached', 'MEDIA_UNAVAILABLE', '备忘录图片状态已改变');
      await put(tx, 'media', id, Object.assign({}, doc, {
        status: 'cleanup_pending',
        refCount: 0,
        cleanupAfter: new Date(),
        updatedAt: new Date(),
      }));
    }
  }

  async function privateMemoImages(item, openid, coupleId) {
    if (!(item.images || []).length) return [];
    const docs = [];
    for (const id of item.images) {
      const doc = await get(db, 'media', id);
      assert(doc && doc.coupleId === coupleId && doc.ownerOpenid === openid && doc.entryId === item.id &&
        doc.attachmentType === 'private_memo' && doc.status === 'attached', 'MEDIA_UNAVAILABLE', '备忘录图片状态已改变，请刷新');
      docs.push(doc);
    }
    return signed(docs);
  }

  async function entryImages(entry) {
    if (entry.deleted || !entry.images.length) return [];
    const docs = [];
    for (const id of entry.images) {
      const doc = await get(db, 'media', id);
      assert(doc && doc.coupleId === entry.coupleId && doc.entryId === entry._id &&
        (!doc.attachmentType || doc.attachmentType === 'entry') && doc.status === 'attached', 'MEDIA_UNAVAILABLE', '图片状态已改变，请刷新');
      docs.push(doc);
    }
    return signed(docs);
  }

  return { prepare, confirm, urls, sync, syncPrivateMemo, privateMemoImages, entryImages };
}

module.exports = { createMedia, imageExtension, MAX_BYTES };
