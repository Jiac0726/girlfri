function dateLabel(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  const shifted = new Date(date.getTime() + 8 * 60 * 60 * 1000);
  const pad = n => String(n).padStart(2, '0');
  return shifted.getUTCFullYear() + '-' + pad(shifted.getUTCMonth() + 1) + '-' +
    pad(shifted.getUTCDate()) + ' ' + pad(shifted.getUTCHours()) + ':' + pad(shifted.getUTCMinutes());
}
function mergeItems(current, incoming) {
  const list = current.slice();
  incoming.forEach(item => {
    const index = list.findIndex(row => row.id === item.id);
    if (index < 0) list.push(item); else list[index] = item;
  });
  return list;
}
function confirmAction(title, content, confirmText) {
  return new Promise(resolve => wx.showModal({
    title, content, confirmText: confirmText || '确认', confirmColor: '#a94c63',
    success: result => resolve(!!result.confirm), fail: () => resolve(false),
  }));
}
function isUncertain(error) {
  return !error || !error.code || ['CLOUD_INVOKE_FAILED', 'UNKNOWN', 'INTERNAL', 'INTERNAL_ERROR'].includes(error.code);
}
function isConflict(error) {
  return !!error && /CONFLICT|STALE|VERSION|STATE_CHANGED|INVALID_STATE/.test(error.code || '');
}
function requestIdFor(page, key, api) {
  if (!page._requestIds) page._requestIds = {};
  if (!page._requestIds[key]) page._requestIds[key] = api.newRequestId();
  return page._requestIds[key];
}
function clearRequestId(page, key) {
  if (page._requestIds) delete page._requestIds[key];
}
module.exports = { dateLabel, mergeItems, confirmAction, isConflict, isUncertain, requestIdFor, clearRequestId };
