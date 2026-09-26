'use strict';

const { createContext, assert, fail, hash, text, version, utcDay, iso } = require('./v2-core');
const { createPairs } = require('./v2-pairs');
const { createMedia } = require('./v2-media');

const REMINDER_TEMPLATE_ID = 'tb0gjEGNaTQfOvLVKNdWKekwa3fSTdyCQkkTSpuNjtk';
const REMINDER_TIMES = new Set(['20:00', '20:30', '21:00', '21:30', '22:00', '22:30']);
const MOODS = new Set(['', '🥰', '😊', '😌', '🥺', '😤', '😢', '😴', '🤍']);
function cleanMood(user) {
  return { moodEmoji: user.moodEmoji || '', moodText: user.moodText || '', moodUpdatedAt: iso(user.moodUpdatedAt), hasMood: !!(user.moodEmoji || user.moodText) };
}
function cleanReminder(user) {
  return { enabled: !!user.reminderEnabled, time: REMINDER_TIMES.has(user.reminderTime) ? user.reminderTime : '21:30', needsRenewal: !!user.reminderNeedsRenewal, lastSentDate: user.reminderLastSentDate || '', templateId: REMINDER_TEMPLATE_ID, version: user.reminderVersion || 0 };
}
function validateMonth(value) {
  assert(typeof value === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(value), 'INVALID_MONTH', '月份不正确');
  return value;
}
function validateDay(value) {
  assert(typeof value === 'string' && /^\d{4}-(0[1-9]|1[0-2])-\d{2}$/.test(value), 'INVALID_DAY', '日期不正确');
  const date = new Date(value + 'T00:00:00Z');
  assert(Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value, 'INVALID_DAY', '日期不正确');
  return value;
}

function createV2Api(cloud, options = {}) {
  const ctx = createContext(cloud);
  const pairs = createPairs(ctx);
  const media = createMedia(ctx, options);
  const { db, get, put, membership, partner, session, ownedDocument, mutate, page, count } = ctx;

  function entryInput(event) {
    const value = { text: text(event.text, 1000, '分享文字'), mood: text(event.mood, 16, '心情'), images: event.images === undefined ? [] : event.images };
    assert(MOODS.has(value.mood), 'INVALID_MOOD', '请选择列表中的心情');
    assert(Array.isArray(value.images) && value.images.length <= 9 && value.images.every(id => typeof id === 'string') && new Set(value.images).size === value.images.length, 'INVALID_MEDIA', '最多选择 9 张不同的图片');
    assert(value.text || value.mood || value.images.length, 'EMPTY_ENTRY', '写一点文字、选择图片或心情后再分享');
    return value;
  }
  async function entryView(doc, openid, committed = false) {
    let images;
    try { images = await media.entryImages(doc); }
    catch (error) {
      if (!committed) throw error;
      // The write already committed. A temporary preview failure must not make
      // clients treat a successful save as a rejected mutation.
      images = doc.deleted ? [] : doc.images.map(id => ({ id, url: '' }));
    }
    return { id: doc._id, text: doc.deleted ? '' : doc.text, mood: doc.deleted ? '' : doc.mood,
      images, fromMe: doc.authorOpenid === openid, createdAt: iso(doc.createdAt), updatedAt: iso(doc.updatedAt),
      dayKey: doc.dayKey, version: doc.version, edited: !!doc.edited, deleted: !!doc.deleted,
      legacyRatingType: doc.legacyRatingType || '', legacyRatingLabel: doc.legacyRatingLabel || '' };
  }
  async function entryCreate(event, openid) {
    const input = entryInput(event);
    const result = await mutate('entry.create', event, openid, async (tx, member, op) => {
      const now = new Date();
      const id = 'entry_' + hash(op).slice(0, 40);
      await media.sync(tx, member, openid, id, [], input.images);
      const doc = Object.assign({ _id: id, coupleId: member.pair._id, authorOpenid: openid, createdAt: now, updatedAt: now,
        dayKey: utcDay(now), monthKey: utcDay(now).slice(0, 7), version: 1, edited: false, deleted: false }, input);
      await put(tx, 'entries', id, doc);
      await put(tx, 'users', openid, Object.assign({}, member.user, { lastSharedDate: doc.dayKey, lastSharedAt: now, updatedAt: now }));
      return doc;
    });
    return entryView(await get(db, 'entries', result._id) || result, openid, true);
  }
  async function entryChange(action, event, openid) {
    const input = action === 'entry.update' ? entryInput(event) : null;
    const result = await mutate(action, event, openid, async (tx, member) => {
      const doc = await ownedDocument(tx, 'entries', event.id, member.pair._id);
      assert(doc.authorOpenid === openid, 'FORBIDDEN', '只能修改或删除自己的分享');
      version(doc, event.expectedVersion);
      assert(!doc.deleted, 'ENTRY_DELETED', '这条分享已删除');
      await media.sync(tx, member, openid, doc._id, doc.images, input ? input.images : []);
      const changed = Object.assign({}, doc, input || { text: '', mood: '', images: [], deleted: true, deletedAt: new Date() }, { version: doc.version + 1, updatedAt: new Date(), edited: input ? true : doc.edited });
      await put(tx, 'entries', doc._id, changed);
      return changed;
    });
    return entryView(await get(db, 'entries', result._id) || result, openid, true);
  }
  async function entryList(event, openid) {
    const member = await membership(db, openid);
    const filter = { coupleId: member.pair._id, deleted: false };
    if (event.month) filter.monthKey = validateMonth(event.month);
    if (event.day) filter.dayKey = validateDay(event.day);
    if (event.day && event.month) assert(event.day.startsWith(event.month + '-'), 'INVALID_DAY', '日期与月份不一致');
    const result = await page('entries', filter, event);
    return { items: await Promise.all(result.items.map(doc => entryView(doc, openid))), nextCursor: result.nextCursor };
  }
  async function entryMonth(event, openid) {
    const month = validateMonth(event.month);
    const member = await membership(db, openid);
    const filter = { coupleId: member.pair._id, deleted: false, monthKey: month };
    const days = new Map();
    let cursor = null, totalEntries = 0;
    do {
      const result = await page('entries', filter, { cursor, limit: 50 });
      for (const item of result.items) {
        const day = days.get(item.dayKey) || { date: item.dayKey, count: 0, fromMeCount: 0, partnerCount: 0 };
        day.count++; totalEntries++;
        if (item.authorOpenid === openid) day.fromMeCount++; else day.partnerCount++;
        days.set(item.dayKey, day);
      }
      cursor = result.nextCursor;
    } while (cursor);
    const values = [...days.values()].sort((a, b) => a.date.localeCompare(b.date));
    return { month, totalEntries, recordDays: values.length, sharedDays: values.filter(day => day.fromMeCount && day.partnerCount).length, days: values };
  }

  function agreementView(doc, openid) {
    return { id: doc._id, title: doc.title, content: doc.content, status: doc.status, fromMe: doc.proposedBy === openid,
      version: doc.version, replacesId: doc.replacesId || '', createdAt: iso(doc.createdAt), updatedAt: iso(doc.updatedAt) };
  }
  async function agreementPropose(event, openid) {
    const title = text(event.title, 40, '约定名称', true);
    const content = text(event.content, 500, '约定内容', true);
    const result = await mutate('agreement.propose', event, openid, async (tx, member, op) => {
      let previous = null;
      if (event.replacesId) {
        previous = await ownedDocument(tx, 'agreements', event.replacesId, member.pair._id);
        version(previous, event.expectedVersion);
        assert(previous.status === 'active', 'AGREEMENT_NOT_ACTIVE', '只能修改仍生效的约定');
      }
      const now = new Date();
      const doc = { _id: 'agreement_' + hash(op).slice(0, 40), coupleId: member.pair._id, proposedBy: openid, recipientOpenid: partner(member.pair, openid),
        title, content, status: 'pending', replacesId: previous ? previous._id : '', replacesVersion: previous ? previous.version : null,
        version: 1, createdAt: now, updatedAt: now };
      await put(tx, 'agreements', doc._id, doc);
      return doc;
    });
    return agreementView(result, openid);
  }
  async function agreementChange(action, event, openid) {
    if (action === 'agreement.respond') assert(event.decision === 'accept' || event.decision === 'reject', 'INVALID_DECISION', '请选择同意或拒绝');
    const result = await mutate(action, event, openid, async (tx, member) => {
      const doc = await ownedDocument(tx, 'agreements', event.id, member.pair._id);
      version(doc, event.expectedVersion);
      let status;
      if (action === 'agreement.respond') {
        assert(doc.recipientOpenid === openid, 'FORBIDDEN', '只能回应对方提出的约定');
        assert(doc.status === 'pending', 'INVALID_AGREEMENT_STATE', '这项提议已处理');
        status = event.decision === 'accept' ? 'active' : 'rejected';
        if (status === 'active' && doc.replacesId) {
          const previous = await ownedDocument(tx, 'agreements', doc.replacesId, member.pair._id);
          assert(previous.status === 'active' && previous.version === doc.replacesVersion, 'STALE_REPLACEMENT', '原约定已改变，请重新提出修改');
          await put(tx, 'agreements', previous._id, Object.assign({}, previous, { status: 'superseded', supersededBy: doc._id, version: previous.version + 1, updatedAt: new Date() }));
        }
      } else if (action === 'agreement.withdraw') {
        assert(doc.proposedBy === openid, 'FORBIDDEN', '只能撤回自己提出的约定');
        assert(doc.status === 'pending', 'INVALID_AGREEMENT_STATE', '只能撤回尚未确认的提议');
        status = 'withdrawn';
      } else {
        assert(doc.status === 'active', 'INVALID_AGREEMENT_STATE', '只能结束生效中的约定');
        status = 'ended';
      }
      const changed = Object.assign({}, doc, { status, version: doc.version + 1, updatedAt: new Date(), lastActorOpenid: openid });
      await put(tx, 'agreements', doc._id, changed);
      return changed;
    });
    return agreementView(result, openid);
  }

  function couponView(doc, openid) {
    return { id: doc._id, title: doc.title, note: doc.note, status: doc.status, fromMe: doc.issuedBy === openid,
      receivedByMe: doc.receivedBy === openid, version: doc.version, createdAt: iso(doc.createdAt), updatedAt: iso(doc.updatedAt), requestId: doc.currentRequestId || '' };
  }
  async function couponGift(event, openid) {
    const title = text(event.title, 40, '券名称', true);
    const note = text(event.note, 200, '券说明');
    const result = await mutate('coupon.gift', event, openid, async (tx, member, op) => {
      const now = new Date();
      const doc = { _id: 'coupon_' + hash(op).slice(0, 40), coupleId: member.pair._id, issuedBy: openid, receivedBy: partner(member.pair, openid),
        title, note, status: 'available', currentRequestId: '', version: 1, createdAt: now, updatedAt: now };
      await put(tx, 'coupons', doc._id, doc);
      return doc;
    });
    return couponView(result, openid);
  }
  async function couponChange(action, event, openid) {
    if (action === 'coupon.respond') assert(event.decision === 'accept' || event.decision === 'reject', 'INVALID_DECISION', '请选择同意或拒绝');
    const result = await mutate(action, event, openid, async (tx, member, op) => {
      const doc = await ownedDocument(tx, 'coupons', event.id, member.pair._id);
      version(doc, event.expectedVersion);
      const now = new Date();
      let status, currentRequestId = doc.currentRequestId || '';
      if (action === 'coupon.request') {
        assert(doc.receivedBy === openid, 'FORBIDDEN', '只能申请兑现收到的券');
        assert(doc.status === 'available', 'INVALID_COUPON_STATE', '这张券当前不能申请兑现');
        currentRequestId = 'request_' + hash(op).slice(0, 40);
        await put(tx, 'requests', currentRequestId, { _id: currentRequestId, couponId: doc._id, coupleId: member.pair._id,
          requestedBy: openid, respondedBy: doc.issuedBy, status: 'requested', version: 1, createdAt: now, updatedAt: now, resolvedAt: null });
        status = 'requested';
      } else if (action === 'coupon.revoke') {
        assert(doc.issuedBy === openid, 'FORBIDDEN', '只能撤回自己赠送的券');
        assert(doc.status === 'available', 'INVALID_COUPON_STATE', '只能撤回尚未申请兑现的券');
        status = 'revoked';
      } else {
        assert(doc.status === 'requested' && currentRequestId, 'INVALID_COUPON_STATE', '当前没有待处理的兑现申请');
        if (action === 'coupon.respond') assert(doc.issuedBy === openid, 'FORBIDDEN', '请由赠送方确认兑现');
        else assert(doc.receivedBy === openid, 'FORBIDDEN', '只能撤销自己的兑现申请');
        const request = await ownedDocument(tx, 'requests', currentRequestId, member.pair._id);
        assert(request.couponId === doc._id && request.status === 'requested', 'INVALID_COUPON_STATE', '申请状态已改变，请刷新');
        const requestStatus = action === 'coupon.cancelRequest' ? 'cancelled' : event.decision === 'accept' ? 'used' : 'rejected';
        await put(tx, 'requests', request._id, Object.assign({}, request, { status: requestStatus, version: request.version + 1, updatedAt: now, resolvedAt: now, lastActorOpenid: openid }));
        status = requestStatus === 'used' ? 'used' : 'available';
        currentRequestId = '';
      }
      const changed = Object.assign({}, doc, { status, currentRequestId, version: doc.version + 1, updatedAt: now });
      await put(tx, 'coupons', doc._id, changed);
      return changed;
    });
    return couponView(result, openid);
  }
  async function listView(collection, event, openid, view) {
    const member = await membership(db, openid);
    const result = await page(collection, { coupleId: member.pair._id }, event);
    return { items: result.items.map(item => view(item, openid)), nextCursor: result.nextCursor };
  }
  async function couponHistory(event, openid) {
    const member = await membership(db, openid);
    const coupon = await ownedDocument(db, 'coupons', event.id, member.pair._id);
    const result = await page('requests', { coupleId: member.pair._id, couponId: coupon._id }, event);
    return { items: result.items.map(item => ({ id: item._id, couponId: item.couponId, status: item.status, fromMe: item.requestedBy === openid,
      version: item.version, createdAt: iso(item.createdAt), updatedAt: iso(item.updatedAt), resolvedAt: iso(item.resolvedAt) })), nextCursor: result.nextCursor };
  }
  async function profileGet(openid) {
    const member = await membership(db, openid);
    const other = await get(db, 'users', partner(member.pair, openid));
    assert(other && other.coupleId === member.pair._id && other.status === 'active', 'PAIR_INVALID', '对方资料状态异常');
    const [pendingAgreementCount, pendingCouponCount] = await Promise.all([
      count('agreements', { coupleId: member.pair._id, status: 'pending', recipientOpenid: openid }),
      count('coupons', { coupleId: member.pair._id, status: 'requested', issuedBy: openid }),
    ]);
    return { me: cleanMood(member.user), partner: cleanMood(other), pendingAgreementCount, pendingCouponCount };
  }
  async function profileUpdate(event, openid) {
    const moodEmoji = text(event.moodEmoji, 8, '心情');
    const moodText = text(event.moodText, 60, '心情文字');
    assert(moodEmoji || moodText, 'INVALID_MOOD', '选一个心情，或者写一句现在的感受');
    return db.runTransaction(async tx => {
      const member = await membership(tx, openid);
      const now = new Date();
      const user = Object.assign({}, member.user, { moodEmoji, moodText, moodUpdatedAt: now, updatedAt: now });
      await put(tx, 'users', openid, user);
      return cleanMood(user);
    });
  }
  async function reminderUpdate(event, openid) {
    assert(typeof event.enabled === 'boolean', 'INVALID_REMINDER', '提醒设置不正确');
    const time = event.time === undefined ? '21:30' : event.time;
    assert(REMINDER_TIMES.has(time), 'INVALID_REMINDER_TIME', '请选择列表中的提醒时间');
    return db.runTransaction(async tx => {
      const member = await membership(tx, openid);
      if (event.expectedVersion !== undefined) assert(event.expectedVersion === (member.user.reminderVersion || 0), 'VERSION_CONFLICT', '提醒设置已更新，请刷新');
      const now = new Date();
      const user = Object.assign({}, member.user, { reminderEnabled: event.enabled, reminderTime: time,
        reminderNeedsRenewal: false, reminderUpdatedAt: now, reminderVersion: (member.user.reminderVersion || 0) + 1, updatedAt: now });
      if (event.enabled) { user.reminderAuthorizedAt = now; user.reminderLastError = ''; }
      await put(tx, 'users', openid, user);
      return cleanReminder(user);
    });
  }

  return async function handle(event, openid) {
    assert(typeof openid === 'string' && openid.length > 0 && /^[A-Za-z0-9_-]+$/.test(openid), 'NO_IDENTITY', '无法获取微信身份');
    assert(event && typeof event === 'object', 'INVALID_INPUT', '请求不正确');
    switch (event.action) {
      case 'session.get': return session(openid, await membership(db, openid, false));
      case 'pair.create': return pairs.issue(openid, false);
      case 'pair.refresh': return pairs.issue(openid, true);
      case 'pair.cancel': return pairs.cancel(openid);
      case 'pair.join': return pairs.join(openid, event.inviteCode);
      case 'entry.list': return entryList(event, openid);
      case 'entry.get': {
        const member = await membership(db, openid);
        const doc = await ownedDocument(db, 'entries', event.id, member.pair._id);
        assert(!doc.deleted, 'ENTRY_DELETED', '这条分享已删除');
        return entryView(doc, openid);
      }
      case 'entry.create': return entryCreate(event, openid);
      case 'entry.update': case 'entry.delete': return entryChange(event.action, event, openid);
      case 'entry.month': return entryMonth(event, openid);
      case 'agreement.list': return listView('agreements', event, openid, agreementView);
      case 'agreement.propose': return agreementPropose(event, openid);
      case 'agreement.respond': case 'agreement.withdraw': case 'agreement.end': return agreementChange(event.action, event, openid);
      case 'coupon.list': return listView('coupons', event, openid, couponView);
      case 'coupon.gift': return couponGift(event, openid);
      case 'coupon.request': case 'coupon.respond': case 'coupon.cancelRequest': case 'coupon.revoke': return couponChange(event.action, event, openid);
      case 'coupon.history': return couponHistory(event, openid);
      case 'profile.get': return profileGet(openid);
      case 'profile.mood.update': return profileUpdate(event, openid);
      case 'reminder.get': return cleanReminder((await membership(db, openid)).user);
      case 'reminder.update': return reminderUpdate(event, openid);
      case 'media.prepare': return media.prepare(event, openid);
      case 'media.confirm': return media.confirm(event, openid);
      case 'media.urls': return media.urls(event, openid);
      default: fail('UNKNOWN_ACTION', '未知操作');
    }
  };
}

module.exports = { createV2Api };
