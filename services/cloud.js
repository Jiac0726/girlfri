const env = require('../config/env');
const FUNCTION_NAME = 'renianApi';

function toError(result) {
  const info = (result && result.error) || {};
  const err = new Error(info.message || '服务暂时不可用');
  err.code = info.code || 'UNKNOWN';
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
      data: Object.assign({ action }, data || {}),
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
  getToday: () => call('rating.today'),
  listRatings: () => call('rating.list'),
  saveToday: (type, reason) => call('rating.save', { type, reason }),
  listPermissions: () => call('permission.list'),
  createPermission: (name, note) => call('permission.create', { name, note }),
  updatePermission: (permissionId, name, note) =>
    call('permission.update', { permissionId, name, note }),
  togglePermission: (permissionId, enabled) =>
    call('permission.toggle', { permissionId, enabled }),
  deletePermission: (permissionId) =>
    call('permission.delete', { permissionId }),
  listPrivilegeCards: () => call('privilege.list'),
  createPrivilegeCard: (name, note) =>
    call('privilege.create', { name, note }),
  usePrivilegeCard: (cardId) =>
    call('privilege.use', { cardId }),
  revokePrivilegeCard: (cardId) =>
    call('privilege.revoke', { cardId }),
  getProfile: () => call('profile.get'),
  updateMood: (moodEmoji, moodText) =>
    call('profile.mood.update', { moodEmoji, moodText }),
  getReminderSettings: () => call('reminder.get'),
  updateReminderSettings: (enabled, time) =>
    call('reminder.update', { enabled, time }),
  isBindingError,
};
