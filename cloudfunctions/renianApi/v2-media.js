'use strict';

const { assert, fail, hash, randomId, text } = require('./v2-core');
const { entryVisibleTo } = require('./v2-visibility');
const MAX_BYTES = 20 * 1024 * 1024;
const MAX_REVIEW_BYTES = 1024 * 1024;
const TTL = 24 * 3600000;
const LEASE = 5 * 60000;
const PROVISION_LEASE = 30 * 1000;

function imageExtension(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 12) return '';
  if (buffer.length >= 33 && buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) && buffer.toString('ascii', 12, 16) === 'IHDR' && buffer.readUInt32BE(8) === 13 && buffer.readUInt32BE(16) > 0 && buffer.readUInt32BE(20) > 0) return 'png';
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff && buffer[buffer.length - 2] === 0xff && buffer[buffer.length - 1] === 0xd9) return 'jpg';
  if (/^GIF8[79]a$/.test(buffer.toString('ascii', 0, 6)) && buffer.readUInt16LE(6) > 0 && buffer.readUInt16LE(8) > 0 && buffer[buffer.length - 1] === 0x3b) return 'gif';
  if (buffer.length >= 20 && buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP' && buffer.readUInt32LE(4) + 8 === buffer.length && ['VP8 ', 'VP8L', 'VP8X'].includes(buffer.toString('ascii', 12, 16))) return 'webp';
  return '';
}

function createMedia(ctx, options = {}, security) {
  const { cloud, db, transaction, get, put, membership, mutate, ownedDocument } = ctx;
  function parsedFile(fileID, path) {
    const environment = String((cloud.getWXContext() || {}).ENV || process.env.TCB_ENV || process.env.SCF_NAMESPACE || '');
    assert(environment, 'MEDIA_ENV_UNAVAILABLE', '图片服务暂时不可用');
    assert(typeof fileID === 'string' && fileID.length < 2000, 'INVALID_MEDIA_FILE', '图片文件标识不正确');
    const match = /^cloud:\/\/([^/]+)\/(.+)$/.exec(fileID);
    assert(match && (match[1] === environment || match[1].startsWith(environment + '.')) && match[2] === path && !/[?#%\\]/.test(match[2]), 'INVALID_MEDIA_FILE', '图片不属于本次上传');
    return { authority: match[1] };
  }
  async function signed(documents, tolerant = false) {
    const ids = [...new Set(documents.map(m => m.fileID).filter(Boolean))];
    const urls = new Map();
    for (let start = 0; start < ids.length; start += 50) {
      let response;
      try { response = await cloud.getTempFileURL({ fileList: ids.slice(start, start + 50) }); }
      catch (error) { if (!tolerant) throw error; continue; }
      for (const item of response.fileList || []) {
        if ((item.status === undefined || item.status === 0) && item.tempFileURL) urls.set(item.fileID, item.tempFileURL);
      }
    }
    if (!tolerant) assert(ids.every(id => urls.has(id)), 'MEDIA_URL_FAILED', '图片暂时无法加载，请重试');
    return documents.map(doc => ({ id: doc._id, fileID: doc.fileID, url: urls.get(doc.fileID) || '' }));
  }
  async function prepare(event, openid) {
    const name = text(event.name, 200, '图片名称', true);
    assert(Number.isInteger(event.size) && event.size > 0 && event.size <= MAX_BYTES, 'INVALID_MEDIA_SIZE', '每张图片不能超过 20 MB');
    const doc = await mutate('media.prepare', event, openid, async (tx, member, op) => {
      const id = 'media_' + hash(op).slice(0, 40);
      const now = new Date();
      const value = { _id: id, ownerOpenid: openid, coupleId: member.pair._id, name, declaredSize: event.size,
        cloudPath: 'v2-upload/' + openid + '/' + randomId('upload'),
        reviewCloudPath: 'v2-review/' + openid + '/' + randomId('review'),
        status: 'prepared', entryId: '', refCount: 0,
        stagingFileID: '', reviewStagingFileID: '', fileID: '',
        stagingCleanupPending: false, reviewCleanupPending: false, createdAt: now, updatedAt: now,
        expiresAt: new Date(now.getTime() + TTL), cleanupAfter: null };
      await put(tx, 'media', id, value);
      return value;
    });
    let current = await get(db, 'media', doc._id);
    assert(current && ['prepared', 'confirming', 'ready', 'attached'].includes(current.status), 'MEDIA_EXPIRED', '上传已过期，请重新选择图片');
    if (current.status !== 'attached') assert(new Date(current.expiresAt).getTime() > Date.now(), 'MEDIA_EXPIRED', '上传已过期，请重新选择图片');

    if (!current.cloudPath) {
      let recoveredCloudPath = '';
      if (current.stagingFileID) {
        const match = /^cloud:\/\/[^/]+\/(.+)$/.exec(String(current.stagingFileID));
        if (match && match[1].startsWith('v2-upload/' + openid + '/')) recoveredCloudPath = match[1];
      }
      if (!recoveredCloudPath) recoveredCloudPath = 'v2-upload/' + openid + '/' + randomId('upload');
      current = await transaction(async tx => {
        const row = await get(tx, 'media', doc._id);
        assert(row && ['prepared', 'confirming', 'ready', 'attached'].includes(row.status), 'MEDIA_EXPIRED', '上传已过期，请重新选择图片');
        if (row.cloudPath) return row;
        const changed = Object.assign({}, row, { cloudPath: recoveredCloudPath, updatedAt: new Date() });
        await put(tx, 'media', doc._id, changed);
        return changed;
      });
    }

    if (!current.stagingFileID) {
      assert(typeof options.getUploadMetadata === 'function', 'MEDIA_ENV_UNAVAILABLE', '图片服务暂时不可用');
      let latest = current;
      for (let attempt = 0; attempt < 3 && !latest.stagingFileID; attempt++) {
        const provisionToken = randomId('provision');
        const claimed = await transaction(async tx => {
          const row = await get(tx, 'media', doc._id);
          assert(row && ['prepared', 'confirming', 'ready', 'attached'].includes(row.status), 'MEDIA_EXPIRED', '上传已过期，请重新选择图片');
          if (row.stagingFileID) return row;
          assert(new Date(row.expiresAt).getTime() > Date.now(), 'MEDIA_EXPIRED', '上传已过期，请重新选择图片');
          const leaseUntil = row.stagingProvisionLeaseUntil && new Date(row.stagingProvisionLeaseUntil).getTime() > Date.now();
          if (leaseUntil) return row;
          const claimed = Object.assign({}, row, { stagingProvisionToken: provisionToken, stagingProvisionLeaseUntil: new Date(Date.now() + PROVISION_LEASE), updatedAt: new Date() });
          await put(tx, 'media', doc._id, claimed);
          return claimed;
        });
        if (claimed.stagingFileID) {
          latest = claimed;
          break;
        }
        if (claimed.stagingProvisionToken !== provisionToken) {
          for (let poll = 0; poll < 15; poll++) {
            await new Promise(resolve => setTimeout(resolve, 200));
            latest = await get(db, 'media', doc._id);
            if (!latest) fail('MEDIA_EXPIRED', '上传已过期，请重新选择图片');
            if (latest.stagingFileID || !(latest.stagingProvisionLeaseUntil && new Date(latest.stagingProvisionLeaseUntil).getTime() > Date.now())) break;
          }
          continue;
        }
        try {
          // Reuse the database's initialized Node SDK. Register identity before the
          // client can upload so an interrupted upload remains discoverable by cleanup.
          const metadata = await options.getUploadMetadata({ cloudPath: claimed.cloudPath });
          const fileID = metadata && metadata.data && metadata.data.fileId;
          parsedFile(fileID, claimed.cloudPath);
          latest = await transaction(async tx => {
            const row = await get(tx, 'media', doc._id);
            assert(row && row.stagingProvisionToken === provisionToken && row.status === 'prepared' &&
              new Date(row.expiresAt).getTime() > Date.now(), 'MEDIA_EXPIRED', '上传已过期，请重新选择图片');
            const completed = Object.assign({}, row, { stagingFileID: fileID, stagingProvisionToken: '', stagingProvisionLeaseUntil: null, updatedAt: new Date() });
            await put(tx, 'media', doc._id, completed);
            return completed;
          });
        } catch (error) {
          await transaction(async tx => {
            const row = await get(tx, 'media', doc._id);
            if (row && row.stagingProvisionToken === provisionToken) {
              await put(tx, 'media', doc._id, Object.assign({}, row, { stagingProvisionToken: '', stagingProvisionLeaseUntil: null, updatedAt: new Date() }));
            }
          }).catch(() => null);
          throw error;
        }
      }
      assert(latest.stagingFileID, 'MEDIA_PROVISION_BUSY', '图片上传准备仍在进行，请稍后重试');
    }
    let prepared = await get(db, 'media', doc._id);
    if (!prepared.reviewCloudPath) {
      const reviewCloudPath = 'v2-review/' + openid + '/' + randomId('review');
      prepared = await transaction(async tx => {
        const row = await get(tx, 'media', doc._id);
        assert(row && ['prepared', 'confirming', 'ready', 'attached'].includes(row.status), 'MEDIA_EXPIRED', '上传已过期，请重新选择图片');
        if (row.reviewCloudPath) return row;
        const changed = Object.assign({}, row, { reviewCloudPath, updatedAt: new Date() });
        await put(tx, 'media', row._id, changed);
        return changed;
      });
    }
    if (!prepared.reviewStagingFileID) {
      assert(typeof options.getUploadMetadata === 'function', 'MEDIA_ENV_UNAVAILABLE', '图片服务暂时不可用');
      const metadata = await options.getUploadMetadata({ cloudPath: prepared.reviewCloudPath });
      const reviewFileID = metadata && metadata.data && metadata.data.fileId;
      parsedFile(reviewFileID, prepared.reviewCloudPath);
      prepared = await transaction(async tx => {
        const row = await get(tx, 'media', doc._id);
        assert(row && ['prepared', 'confirming', 'ready', 'attached'].includes(row.status), 'MEDIA_EXPIRED', '上传已过期，请重新选择图片');
        if (row.reviewStagingFileID) return row;
        const changed = Object.assign({}, row, {
          reviewStagingFileID: reviewFileID,
          updatedAt: new Date(),
        });
        await put(tx, 'media', row._id, changed);
        return changed;
      });
    }
    assert(prepared && prepared.cloudPath && prepared.reviewCloudPath,
      'MEDIA_PREPARE_INVALID', '图片上传准备结果不完整，请重试');
    return { id: prepared._id, cloudPath: prepared.cloudPath, reviewCloudPath: prepared.reviewCloudPath };
  }
  async function deleteStaging(doc) {
    if (!doc.stagingFileID) return;
    try {
      const response = await cloud.deleteFile({ fileList: [doc.stagingFileID] });
      const success = response.fileList && response.fileList.some(item => item.fileID === doc.stagingFileID && (item.status === 0 || item.status === -503003));
      if (success) await transaction(async tx => {
        const current = await get(tx, 'media', doc._id);
        if (current && current.stagingFileID === doc.stagingFileID) await put(tx, 'media', doc._id, Object.assign({}, current, { stagingCleanupPending: false, updatedAt: new Date() }));
      });
    } catch (_) { /* Preserve stagingCleanupPending for the privileged cleanup task. */ }
  }
  async function deleteReviewStaging(doc) {
    if (!doc.reviewStagingFileID) return;
    try {
      const response = await cloud.deleteFile({ fileList: [doc.reviewStagingFileID] });
      const success = response.fileList && response.fileList.some(item =>
        item.fileID === doc.reviewStagingFileID && (item.status === 0 || item.status === -503003));
      if (success) await transaction(async tx => {
        const current = await get(tx, 'media', doc._id);
        if (current && current.reviewStagingFileID === doc.reviewStagingFileID) {
          await put(tx, 'media', doc._id, Object.assign({}, current, {
            reviewCleanupPending: false,
            updatedAt: new Date(),
          }));
        }
      });
    } catch (_) { /* Preserve reviewCleanupPending for the privileged cleanup task. */ }
  }

  async function confirm(event, openid) {
    const token = randomId('confirm');
    const reserved = await transaction(async tx => {
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
      assert(doc.reviewCloudPath && doc.reviewStagingFileID, 'CONTENT_IMAGE_REVIEW_REQUIRED', '请重新选择图片以完成安全检查');
      assert(typeof event.reviewFileID === 'string' && event.reviewFileID, 'CONTENT_IMAGE_REVIEW_REQUIRED', '请重新选择图片以完成安全检查');
      parsedFile(event.reviewFileID, doc.reviewCloudPath);
      assert(doc.reviewStagingFileID === event.reviewFileID, 'INVALID_MEDIA_FILE', '图片审核副本不属于本次上传');
      assert(doc.status === 'prepared', doc.status === 'confirming' ? 'MEDIA_PROCESSING' : 'MEDIA_UNAVAILABLE', '图片正在处理或已经失效，请稍后重试');
      assert(new Date(doc.expiresAt).getTime() > Date.now(), 'MEDIA_EXPIRED', '上传已过期，请重新选择图片');
      const changed = Object.assign({}, doc, {
        status: 'confirming',
        confirmToken: token,
        confirmLeaseUntil: new Date(Date.now() + LEASE),
        stagingFileID: event.fileID,
        reviewStagingFileID: event.reviewFileID,
        stagingCleanupPending: true,
        reviewCleanupPending: true,
        updatedAt: new Date(),
      });
      await put(tx, 'media', doc._id, changed);
      return changed;
    });
    if (reserved.status === 'ready' || reserved.status === 'attached') return (await signed([reserved]))[0];
    let uploadedFileID = '';
    try {
      const reviewDownload = await cloud.downloadFile({ fileID: event.reviewFileID });
      const reviewBuffer = Buffer.isBuffer(reviewDownload.fileContent)
        ? reviewDownload.fileContent
        : Buffer.from(reviewDownload.fileContent || []);
      assert(reviewBuffer.length > 0 && reviewBuffer.length <= MAX_REVIEW_BYTES,
        'CONTENT_IMAGE_REVIEW_INVALID', '图片审核副本不能超过 1 MB');
      const reviewExtension = imageExtension(reviewBuffer);
      assert(reviewExtension, 'CONTENT_IMAGE_REVIEW_INVALID', '图片审核副本格式不正确');
      assert(security && typeof security.checkImage === 'function',
        'CONTENT_CHECK_FAILED', '图片安全检查暂时不可用，请稍后重试');
      await security.checkImage(reviewBuffer, reviewExtension);

      const download = await cloud.downloadFile({ fileID: event.fileID });
      const buffer = Buffer.isBuffer(download.fileContent) ? download.fileContent : Buffer.from(download.fileContent || []);
      assert(buffer.length > 0 && buffer.length <= MAX_BYTES, 'INVALID_MEDIA_SIZE', '每张图片不能超过 20 MB');
      const extension = imageExtension(buffer);
      assert(extension, 'INVALID_MEDIA_TYPE', '请选择有效的 JPG、PNG、GIF 或 WebP 图片');
      const publishedCloudPath = 'v2-published/' + reserved._id + '.' + extension;
      const expectedFileID = 'cloud://' + parsedFile(event.fileID, reserved.cloudPath).authority + '/' + publishedCloudPath;
      await transaction(async tx => {
        const current = await get(tx, 'media', reserved._id);
        assert(current && current.status === 'confirming' && current.confirmToken === token && new Date(current.confirmLeaseUntil).getTime() > Date.now(), 'MEDIA_UNAVAILABLE', '上传处理已过期，请重新上传');
        await put(tx, 'media', current._id, Object.assign({}, current, { fileID: expectedFileID, publishedCloudPath, actualSize: buffer.length, extension, updatedAt: new Date() }));
      });
      const upload = await cloud.uploadFile({ cloudPath: publishedCloudPath, fileContent: buffer });
      uploadedFileID = upload.fileID;
      assert(uploadedFileID === expectedFileID, 'MEDIA_UPLOAD_FAILED', '图片保存失败，请重新上传');
      const ready = await transaction(async tx => {
        const member = await membership(tx, openid);
        const current = await ownedDocument(tx, 'media', reserved._id, member.pair._id);
        assert(current.status === 'confirming' && current.confirmToken === token && new Date(current.confirmLeaseUntil).getTime() > Date.now(), 'MEDIA_UNAVAILABLE', '上传处理已过期，请重新上传');
        const changed = Object.assign({}, current, { status: 'ready', fileID: uploadedFileID, confirmToken: '', confirmLeaseUntil: null, updatedAt: new Date() });
        await put(tx, 'media', changed._id, changed);
        return changed;
      });
      await deleteStaging(ready);
      await deleteReviewStaging(ready);
      return (await signed([ready]))[0];
    } catch (error) {
      // Invalid images are never made ready. Transient failures may retry the same upload;
      // a published object, when present, is always registered for privileged cleanup.
      await transaction(async tx => {
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
        if (doc.attachmentType === 'profile_avatar') {
          assert(doc.ownerOpenid === openid && doc.entryId === openid, 'FORBIDDEN', '这张头像只属于当前账号');
        } else if (doc.attachmentType === 'private_memo') {
          assert(doc.ownerOpenid === openid, 'FORBIDDEN', '这张图片只属于你的私密备忘录');
          const memo = (member.user.privateMemoItems || []).find(item => item.id === doc.entryId);
          const legacyMemoId = 'memo_legacy_' + hash(openid).slice(0, 24);
          const legacyMatch = !member.user.privateMemoMigrated && member.user.privateMemo && doc.entryId === legacyMemoId;
          assert((memo && (memo.images || []).includes(id)) || legacyMatch, 'MEDIA_UNAVAILABLE', '图片已不可用');
        } else if (doc.attachmentType === 'album_photo') {
          const photo = await ownedDocument(db, 'photos', doc.entryId, member.pair._id);
          await ownedDocument(db, 'albums', photo.albumId, member.pair._id);
          assert(!photo.deleted && photo.mediaId === id && photo.authorOpenid === doc.ownerOpenid, 'MEDIA_UNAVAILABLE', '照片已不可用');
        } else {
          const entry = await ownedDocument(db, 'entries', doc.entryId, member.pair._id);
          assert(entryVisibleTo(entry, openid), 'NOT_FOUND', '图片不存在或无权访问');
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
      const refs = Math.max(1, Number(doc.refCount) || 1);
      if (refs > 1) {
        await put(tx, 'media', id, Object.assign({}, doc, { refCount: refs - 1, updatedAt: new Date() }));
      } else {
        await put(tx, 'media', id, Object.assign({}, doc, { status: 'cleanup_pending', refCount: 0, cleanupAfter: new Date(), updatedAt: new Date() }));
      }
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

  async function syncAvatar(tx, member, openid, beforeId, afterId) {
    const before = String(beforeId || '');
    const after = String(afterId || '');
    if (after) {
      const doc = await ownedDocument(tx, 'media', after, member.pair._id);
      assert(doc.ownerOpenid === openid, 'FORBIDDEN', '只能使用自己上传的头像');
      if (after === before) {
        assert(doc.status === 'attached' && doc.attachmentType === 'profile_avatar' && doc.entryId === openid,
          'MEDIA_UNAVAILABLE', '头像状态已改变，请重新选择');
      } else {
        assert(doc.status === 'ready' && !doc.entryId && new Date(doc.expiresAt).getTime() > Date.now(),
          'MEDIA_UNAVAILABLE', '头像已使用或已过期，请重新选择');
        await put(tx, 'media', after, Object.assign({}, doc, {
          status: 'attached',
          entryId: openid,
          attachmentType: 'profile_avatar',
          refCount: 1,
          expiresAt: null,
          updatedAt: new Date(),
        }));
      }
    }
    if (before && before !== after) {
      const old = await ownedDocument(tx, 'media', before, member.pair._id);
      assert(old.ownerOpenid === openid && old.status === 'attached' &&
        old.attachmentType === 'profile_avatar' && old.entryId === openid,
      'MEDIA_UNAVAILABLE', '原头像状态已改变，请刷新');
      await put(tx, 'media', before, Object.assign({}, old, {
        status: 'cleanup_pending',
        refCount: 0,
        cleanupAfter: new Date(),
        updatedAt: new Date(),
      }));
    }
  }

  async function avatarImage(mediaId, openid, coupleId, tolerant = false) {
    if (!mediaId) return { id: '', url: '' };
    const doc = await get(db, 'media', mediaId);
    const valid = doc && doc.coupleId === coupleId && doc.ownerOpenid === openid &&
      doc.entryId === openid && doc.attachmentType === 'profile_avatar' && doc.status === 'attached';
    if (!valid) {
      if (!tolerant) fail('MEDIA_UNAVAILABLE', '头像暂时不可用');
      return { id: mediaId, url: '' };
    }
    const result = await signed([doc], tolerant);
    return { id: mediaId, url: result[0] && result[0].url || '' };
  }

  async function privateMemoImages(item, openid, coupleId, tolerant = false) {
    if (!(item.images || []).length) return [];
    const docs = [];
    for (const id of item.images) {
      const doc = await get(db, 'media', id);
      const valid = doc && doc.coupleId === coupleId && doc.ownerOpenid === openid && doc.entryId === item.id &&
        doc.attachmentType === 'private_memo' && doc.status === 'attached';
      if (!valid) {
        if (!tolerant) fail('MEDIA_UNAVAILABLE', '备忘录图片状态已改变，请刷新');
        docs.push({ _id: id, fileID: '' });
        continue;
      }
      docs.push(doc);
    }
    return signed(docs, tolerant);
  }

  async function entryImages(entry, tolerant = false) {
    if (entry.deleted || !entry.images.length) return [];
    const docs = [];
    for (const id of entry.images) {
      let doc;
      try { doc = await get(db, 'media', id); }
      catch (error) { if (!tolerant) throw error; }
      const valid = doc && doc.coupleId === entry.coupleId && doc.entryId === entry._id &&
        (!doc.attachmentType || doc.attachmentType === 'entry') && doc.status === 'attached';
      if (!tolerant) assert(valid, 'MEDIA_UNAVAILABLE', '图片状态已改变，请刷新');
      // Never sign an invalid or foreign asset, even when degrading the UI.
      docs.push(valid ? doc : { _id: id, fileID: '' });
    }
    return signed(docs, tolerant);
  }

  async function albumImages(photos) {
    const docs = [];
    for (const photo of photos) {
      const doc = await get(db, 'media', photo.mediaId);
      const common = doc && !photo.deleted && doc.coupleId === photo.coupleId && doc.ownerOpenid === photo.authorOpenid &&
        doc.status === 'attached';
      const directAlbum = common && doc.attachmentType === 'album_photo' && doc.entryId === photo._id;
      const entryBacked = common && !!photo.sourceEntryId && (!doc.attachmentType || doc.attachmentType === 'entry') &&
        doc.entryId === photo.sourceEntryId && (Number(doc.refCount) || 0) >= 2;
      docs.push(directAlbum || entryBacked ? doc : { _id: photo.mediaId, fileID: '' });
    }
    return signed(docs, true);
  }
  return { prepare, confirm, urls, sync, syncAvatar, avatarImage, syncPrivateMemo, privateMemoImages, entryImages, albumImages };
}

module.exports = { createMedia, imageExtension, MAX_BYTES };
