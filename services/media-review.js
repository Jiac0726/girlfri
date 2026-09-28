'use strict';

const { wxCall } = require('./entry-view');

const MAX_REVIEW_BYTES = 190 * 1024;

function localFileSize(path) {
  return new Promise((resolve, reject) => {
    try {
      const fs = wx.getFileSystemManager();
      fs.stat({
        path,
        success: result => resolve(Number(result && result.stats && result.stats.size) || 0),
        fail: reject,
      });
    } catch (error) {
      reject(error);
    }
  });
}

function scaledDimensions(info, maxWidth, maxHeight) {
  const width = Number(info && info.width) || 0;
  const height = Number(info && info.height) || 0;
  if (!width || !height) return { compressedWidth: maxWidth };
  const scale = Math.min(1, maxWidth / width, maxHeight / height);
  return {
    compressedWidth: Math.max(1, Math.floor(width * scale)),
    compressedHeight: Math.max(1, Math.floor(height * scale)),
  };
}

async function makeSafetyReviewImage(src) {
  const info = await wxCall('getImageInfo', { src }).catch(() => null);
  const attempts = [
    { quality: 55, maxWidth: 640, maxHeight: 960 },
    { quality: 38, maxWidth: 520, maxHeight: 780 },
    { quality: 28, maxWidth: 420, maxHeight: 640 },
    { quality: 18, maxWidth: 320, maxHeight: 480 },
  ];

  let lastError = null;
  for (const attempt of attempts) {
    try {
      const dimensions = scaledDimensions(info, attempt.maxWidth, attempt.maxHeight);
      const result = await wxCall('compressImage', Object.assign({
        src,
        quality: attempt.quality,
      }, dimensions));
      if (!result || !result.tempFilePath) throw new Error('未生成审核图片');
      const size = await localFileSize(result.tempFilePath);
      if (size > 0 && size <= MAX_REVIEW_BYTES) {
        return { path: result.tempFilePath, size };
      }
      lastError = new Error('审核图片仍然过大');
    } catch (error) {
      lastError = error;
    }
  }

  const error = new Error('无法将安全审核图压到 200 KB 以内，请换一张图片后重试');
  error.code = 'CONTENT_IMAGE_REVIEW_INVALID';
  error.cause = lastError;
  throw error;
}

module.exports = { makeSafetyReviewImage, localFileSize };
