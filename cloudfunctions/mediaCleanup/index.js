const cloud = require('wx-server-sdk');
const cloudbase = require('@cloudbase/node-sdk');
const { createMediaCleanup } = require('./worker');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const storage = cloudbase.init({ env: cloudbase.SYMBOL_CURRENT_ENV });
const worker = createMediaCleanup(cloud, undefined, { getUploadMetadata: input => storage.getUploadMetadata(input) });

exports.main = async () => {
  if (cloud.getWXContext().OPENID) {
    return { ok: false, error: { code: 'SCHEDULED_ONLY', message: '仅限定时任务调用' } };
  }
  return worker.run();
};
