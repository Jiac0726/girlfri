const cloud = require('wx-server-sdk');
const { createV2Api } = require('./v2');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const handle = createV2Api(cloud);

function fail(code, message) {
  return { ok: false, error: { code, message } };
}

exports.main = async (event) => {
  try {
    const { OPENID } = cloud.getWXContext();
    if (!OPENID) return fail('NO_IDENTITY', '无法获取微信身份');
    if (!event || event.apiVersion !== 2) {
      return fail('CLIENT_UPGRADE_REQUIRED', '热念已更新，请重新打开最新版小程序');
    }
    return { ok: true, data: await handle(event, OPENID) };
  } catch (error) {
    if (error && error.isBusiness === true) {
      console.warn('[renianApi]', error.code, error.message);
      return fail(error.code, error.message);
    }
    console.error('[renianApi] unexpected failure', error);
    return fail('INTERNAL', '服务暂时不可用，请稍后重试');
  }
};
