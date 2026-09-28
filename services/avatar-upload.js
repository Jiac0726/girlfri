'use strict';

const { normalizeLocalImage, makeCompatibleImage } = require('./entry-view');
const { makeSafetyReviewImage, localFileSize } = require('./media-review');

async function uploadAccountAvatar(api, avatarUrl, expectedVersion) {
  let localPath = avatarUrl;
  if (!localPath) throw new Error('没有选择头像');

  const normalized = await normalizeLocalImage(localPath);
  localPath = normalized.path;
  let converted = normalized.converted;
  let review = await makeSafetyReviewImage(localPath);
  let confirmed = null;

  for (let attempt = 0; attempt < 3 && !confirmed; attempt++) {
    try {
      const size = await localFileSize(localPath);
      if (!size || size > 20 * 1024 * 1024) throw new Error('头像不能超过 20 MB');
      const prepared = await api.prepareMedia({
        requestId: api.newRequestId(),
        name: 'account-avatar',
        size,
      });
      if (!prepared || !prepared.cloudPath || !prepared.reviewCloudPath) {
        const error = new Error('图片上传准备结果不完整，请重试');
        error.code = 'MEDIA_PREPARE_INVALID';
        throw error;
      }
      const uploaded = await wx.cloud.uploadFile({
        cloudPath: prepared.cloudPath,
        filePath: localPath,
      });
      const reviewed = await wx.cloud.uploadFile({
        cloudPath: prepared.reviewCloudPath,
        filePath: review.path,
      });
      confirmed = await api.confirmMedia({
        id: prepared.id,
        fileID: uploaded.fileID,
        reviewFileID: reviewed.fileID,
      });
    } catch (error) {
      if (error.code === 'INVALID_MEDIA_TYPE' && !converted) {
        localPath = await makeCompatibleImage(localPath);
        converted = true;
        review = await makeSafetyReviewImage(localPath);
        continue;
      }
      if (['MEDIA_EXPIRED', 'MEDIA_UNAVAILABLE', 'MEDIA_PROCESSING'].includes(error.code) && attempt < 2) continue;
      throw error;
    }
  }

  if (!confirmed || !confirmed.id) throw new Error('头像上传未完成，请重试');
  return api.updateAccountAvatar({
    requestId: api.newRequestId(),
    mediaId: confirmed.id,
    expectedVersion: Number(expectedVersion) || 0,
  });
}

module.exports = { uploadAccountAvatar };
