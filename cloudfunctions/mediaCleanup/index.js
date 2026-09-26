const cloud = require('wx-server-sdk');
const { createMediaCleanup } = require('./worker');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const worker = createMediaCleanup(cloud);

exports.main = async () => {
  if (cloud.getWXContext().OPENID) {
    return { ok: false, error: { code: 'SCHEDULED_ONLY', message: '仅限定时任务调用' } };
  }
  return worker.run();
};
