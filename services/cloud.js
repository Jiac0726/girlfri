const FUNCTION_NAME = 'renianApi';

function toError(result) {
  const info = (result && result.error) || {};
  const err = new Error(info.message || '服务暂时不可用');
  err.code = info.code || 'UNKNOWN';
  return err;
}

async function call(action, data) {
  const res = await wx.cloud.callFunction({
    name: FUNCTION_NAME,
    data: Object.assign({ action }, data || {}),
  });
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
  createInvite: (role) => call('pair.create', { role }),
  refreshInvite: () => call('pair.refresh'),
  cancelInvite: () => call('pair.cancel'),
  joinPair: (inviteCode) => call('pair.join', { inviteCode }),
  getToday: () => call('rating.today'),
  listRatings: () => call('rating.list'),
  saveToday: (type, reason) => call('rating.save', { type, reason }),
  isBindingError,
};
