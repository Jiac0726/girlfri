const env = require('../config/env');
const FUNCTION_NAME = 'renianApi';

function toError(result) {
  const info = (result && result.error) || {};
  const err = new Error(info.message || '服务暂时不可用');
  err.code = info.code || 'UNKNOWN';
  err.current = info.current || null;
  return err;
}

function toCloudInvokeError(error) {
  const raw = String(
    (error && (error.errMsg || error.message)) ||
    error ||
    '未知云函数调用错误'
  );
  const cloudEnv = String((env && env.cloudEnv) || '').trim() || '(未配置)';
  const err = new Error(
    '云函数 renianApi 调用失败；当前环境：' + cloudEnv + '；' + raw
  );
  err.code = 'CLOUD_INVOKE_FAILED';
  err.raw = error;
  err.cloudEnv = cloudEnv;
  return err;
}

async function call(action, data) {
  let res;
  try {
    res = await wx.cloud.callFunction({
      name: FUNCTION_NAME,
      data: Object.assign({}, data || {}, { action, apiVersion: 2 }),
    });
  } catch (error) {
    console.error('[renian cloud invoke failed]', {
      functionName: FUNCTION_NAME,
      action,
      cloudEnv: env.cloudEnv,
      error,
    });
    throw toCloudInvokeError(error);
  }

  const result = res && res.result;
  if (!result || result.ok !== true) throw toError(result);
  return result.data;
}

let requestSequence = 0;
function newRequestId() {
  requestSequence += 1;
  return Date.now().toString(36) + '-' + requestSequence.toString(36) + '-' +
    Math.random().toString(36).slice(2, 14);
}

function isBindingError(err) {
  return !!err && (
    err.code === 'NOT_BOUND' ||
    err.code === 'PAIR_NOT_ACTIVE' ||
    err.code === 'PAIR_NOT_FOUND'
  );
}

module.exports = {
  getSession: () => call('session.get'),
  createInvite: () => call('pair.create'),
  refreshInvite: () => call('pair.refresh'),
  cancelInvite: () => call('pair.cancel'),
  joinPair: (inviteCode) => call('pair.join', { inviteCode }),
  listEntries: (query) => call('entry.list', query),
  getEntry: (id) => call('entry.get', { id }),
  createEntry: (data) => call('entry.create', data),
  updateEntry: (data) => call('entry.update', data),
  deleteEntry: (data) => call('entry.delete', data),
  getEntryMonth: (month) => call('entry.month', { month }),
  prepareMedia: (data) => call('media.prepare', data),
  confirmMedia: (data) => call('media.confirm', data),
  getMediaUrls: (ids) => call('media.urls', { ids }),
  listAgreements: (query) => call('agreement.list', query),
  proposeAgreement: (data) => call('agreement.propose', data),
  respondAgreement: (data) => call('agreement.respond', data),
  withdrawAgreement: (data) => call('agreement.withdraw', data),
  endAgreement: (data) => call('agreement.end', data),
  listCoupons: (query) => call('coupon.list', query),
  giftCoupon: (data) => call('coupon.gift', data),
  requestCoupon: (data) => call('coupon.request', data),
  respondCoupon: (data) => call('coupon.respond', data),
  cancelCouponRequest: (data) => call('coupon.cancelRequest', data),
  revokeCoupon: (data) => call('coupon.revoke', data),
  getCouponHistory: (query) => call('coupon.history', query),
  getProfile: () => call('profile.get'),
  updatePrivateMemo: (text, expectedVersion) =>
    call('profile.memo.update', { text, expectedVersion }),
  updateMood: (moodEmoji, moodText) =>
    call('profile.mood.update', { moodEmoji, moodText }),
  getReminderSettings: () => call('reminder.get'),
  updateReminderSettings: (enabled, time, expectedVersion) =>
    call('reminder.update', { enabled, time, expectedVersion }),
  newRequestId,
  isBindingError,
};
