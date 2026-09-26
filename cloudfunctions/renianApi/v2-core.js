'use strict';

const crypto = require('crypto');
const COLLECTIONS = Object.freeze({
  users: 'v2_users', couples: 'v2_couples', invites: 'v2_invites', entries: 'v2_entries',
  agreements: 'v2_agreements', coupons: 'v2_coupons', requests: 'v2_coupon_requests',
  media: 'v2_media', operations: 'v2_operations',
});

class BusinessError extends Error {
  constructor(code, message) { super(message); this.code = code; this.isBusiness = true; }
}
function fail(code, message) { throw new BusinessError(code, message); }
function assert(condition, code, message) { if (!condition) fail(code, message); }
function hash(value) { return crypto.createHash('sha256').update(value).digest('hex'); }
function randomId(prefix) { return prefix + '_' + crypto.randomBytes(16).toString('hex'); }
function utcDay(date = new Date()) { return new Date(date.getTime() + 8 * 3600000).toISOString().slice(0, 10); }
function iso(value) { return value ? new Date(value).toISOString() : ''; }
function withoutId(value) { const copy = Object.assign({}, value); delete copy._id; return copy; }
function validId(value) {
  assert(typeof value === 'string' && /^[A-Za-z0-9_-]{1,160}$/.test(value), 'INVALID_ID', '记录标识不正确');
  return value;
}
function text(value, maximum, field, required = false) {
  assert(value === undefined || value === null || typeof value === 'string', 'INVALID_INPUT', field + '格式不正确');
  const out = (value || '').trim();
  assert(out.length <= maximum && (!required || out.length > 0), 'INVALID_INPUT', field + (required ? '不能为空且' : '') + '最多 ' + maximum + ' 字');
  return out;
}
function version(doc, expected) {
  assert(Number.isInteger(expected) && expected > 0, 'VERSION_REQUIRED', '请刷新后再操作');
  assert(doc.version === expected, 'VERSION_CONFLICT', '内容已更新，请刷新后再操作');
}
function stable(value) {
  if (Array.isArray(value)) return '[' + value.map(stable).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map(k => JSON.stringify(k) + ':' + stable(value[k])).join(',') + '}';
  return JSON.stringify(value);
}
function operationKey(action, openid, event) {
  assert(typeof event.requestId === 'string' && /^[A-Za-z0-9_-]{8,128}$/.test(event.requestId), 'REQUEST_ID_REQUIRED', '操作标识不正确，请重试');
  return 'op_' + hash(action + '\n' + openid + '\n' + event.requestId);
}
function isMissing(error) {
  const code = String(error && (error.errCode !== undefined ? error.errCode : error.code));
  const message = String(error && (error.errMsg || error.message) || '');
  return code === 'DATABASE_DOCUMENT_NOT_EXIST' || code === '-502005' || /document (?:not exists|does not exist|not found)/i.test(message);
}

function createContext(cloud, database) {
  const db = database || cloud.database();
  const command = db.command;
  async function transaction(fn) {
    const response = await db.runTransaction(fn);
    // @cloudbase/node-sdk wraps the callback return value as
    // { result, errMsg }. Tests and some legacy adapters return it directly.
    if (response && typeof response === 'object' &&
        Object.prototype.hasOwnProperty.call(response, 'result') &&
        Object.prototype.hasOwnProperty.call(response, 'errMsg')) {
      return response.result;
    }
    return response;
  }
  const ref = (source, collection, id) => source.collection(COLLECTIONS[collection]).doc(id);
  const get = async (source, collection, id) => {
    try {
      const result = await ref(source, collection, id).get();
      const data = result && result.data;
      // @cloudbase/node-sdk returns document get() as data: [doc].
      // Legacy wx-server-sdk/mocks may return data: doc.
      return Array.isArray(data) ? (data[0] || null) : (data || null);
    } catch (error) {
      if (isMissing(error)) return null;
      throw error;
    }
  };
  const put = (source, collection, id, data) =>
    // @cloudbase/node-sdk set() accepts the document body directly.
    ref(source, collection, id).set(withoutId(data));
  const remove = (source, collection, id) => ref(source, collection, id).remove();
  async function membership(source, openid, active = true) {
    const user = await get(source, 'users', openid);
    if (!user || !user.coupleId) {
      if (!active) return { user, pair: null };
      fail('NOT_BOUND', '请先完成双人绑定');
    }
    const pair = await get(source, 'couples', user.coupleId);
    assert(pair, 'PAIR_NOT_FOUND', '关系不存在，请重新绑定');
    const members = pair.memberOpenids || [];
    assert(members.includes(openid) && (pair.creatorOpenid === openid || pair.partnerOpenid === openid), 'PAIR_INVALID', '关系状态异常');
    if (active) {
      assert(pair.status === 'active', 'PAIR_NOT_ACTIVE', '还在等待另一位加入');
      assert(user.status === 'active' && members.length === 2 && pair.creatorOpenid !== pair.partnerOpenid && members.includes(pair.creatorOpenid) && members.includes(pair.partnerOpenid), 'PAIR_INVALID', '关系状态异常');
    }
    return { user, pair };
  }
  const partner = (pair, openid) => pair.memberOpenids.find(id => id !== openid);
  function session(openid, member) {
    const pair = member.pair;
    const waiting = pair && pair.status === 'waiting';
    return {
      bindingStatus: pair ? pair.status : 'unbound', bound: !!pair && pair.status === 'active',
      coupleId: pair ? pair._id : '', isCreator: !!pair && pair.creatorOpenid === openid,
      inviteCode: waiting && pair.creatorOpenid === openid ? pair.inviteCode : '',
      inviteExpiresAt: waiting ? iso(pair.inviteExpiresAt) : null,
      inviteExpired: !!waiting && new Date(pair.inviteExpiresAt).getTime() <= Date.now(),
      serverDate: utcDay(),
    };
  }
  async function ownedDocument(source, collection, id, pairId) {
    const doc = await get(source, collection, validId(id));
    assert(doc && doc.coupleId === pairId, 'NOT_FOUND', '记录不存在或无权访问');
    return doc;
  }
  async function mutate(action, event, openid, fn) {
    const key = operationKey(action, openid, event);
    const input = Object.assign({}, event); delete input.apiVersion; delete input.action;
    const fingerprint = hash(stable(input));
    return transaction(async tx => {
      const member = await membership(tx, openid);
      const existing = await get(tx, 'operations', key);
      if (existing) {
        assert(existing.coupleId === member.pair._id && existing.fingerprint === fingerprint, 'REQUEST_CONFLICT', '同一次操作的内容已改变，请重新发起');
        return existing.result;
      }
      const result = await fn(tx, member, key);
      await put(tx, 'operations', key, { action, actorOpenid: openid, coupleId: member.pair._id, fingerprint, result, createdAt: new Date() });
      return result;
    });
  }
  function parseCursor(raw, scope) {
    if (!raw) return null;
    try {
      assert(typeof raw === 'string' && raw.length < 1500, 'INVALID_CURSOR', '分页参数不正确');
      const decoded = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
      assert(decoded.scope === hash(stable(scope)).slice(0, 24) && typeof decoded.id === 'string' && /^[A-Za-z0-9_-]{1,160}$/.test(decoded.id), 'INVALID_CURSOR', '分页参数不正确');
      const date = new Date(decoded.at);
      assert(Number.isFinite(date.getTime()), 'INVALID_CURSOR', '分页参数不正确');
      return { id: decoded.id, at: date };
    } catch (error) { if (error.isBusiness) throw error; fail('INVALID_CURSOR', '分页参数不正确'); }
  }
  async function page(collection, base, event = {}, maximum = 50) {
    const requested = event.limit === undefined ? 20 : event.limit;
    assert(Number.isInteger(requested) && requested > 0 && requested <= maximum, 'INVALID_LIMIT', '每页数量不正确');
    const scope = { collection, base };
    const cursor = parseCursor(event.cursor, scope);
    let where = base;
    if (cursor) where = command.and([base, command.or([
      { createdAt: command.lt(cursor.at) },
      { createdAt: cursor.at, _id: command.lt(cursor.id) },
    ])]);
    const result = await db.collection(COLLECTIONS[collection]).where(where).orderBy('createdAt', 'desc').orderBy('_id', 'desc').limit(requested + 1).get();
    const rows = result.data || [];
    const items = rows.slice(0, requested);
    const last = items[items.length - 1];
    const nextCursor = rows.length > requested && last ? Buffer.from(JSON.stringify({ scope: hash(stable(scope)).slice(0, 24), at: iso(last.createdAt), id: last._id })).toString('base64url') : null;
    return { items, nextCursor };
  }
  async function count(collection, where) {
    const result = await db.collection(COLLECTIONS[collection]).where(where).count();
    return result.total || 0;
  }
  return { cloud, db, command, transaction, ref, get, put, remove, membership, partner, session, ownedDocument, mutate, page, count };
}

module.exports = { COLLECTIONS, BusinessError, fail, assert, hash, randomId, utcDay, iso, validId, text, version, createContext };
