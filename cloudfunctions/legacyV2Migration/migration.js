'use strict';

const crypto = require('crypto');

const INVITE_RE = /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{8}$/;
const RATING_LABELS = { good: '很好', neutral: '还好', bad: '有点糟' };
const REMINDER_TIMES = new Set(['20:00', '20:30', '21:00', '21:30', '22:00', '22:30']);

function hash(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex').slice(0, 40);
}

function asDate(value, fallback) {
  if (value instanceof Date && Number.isFinite(value.getTime())) return new Date(value.getTime());
  if (value) {
    const d = new Date(value);
    if (Number.isFinite(d.getTime())) return d;
  }
  return fallback ? new Date(fallback.getTime()) : new Date(0);
}

function utc8Day(value) {
  const d = asDate(value);
  return new Date(d.getTime() + 8 * 3600000).toISOString().slice(0, 10);
}

function ratingTime(row) {
  const day = String(row.date || '');
  const updated = asDate(row.updatedAt);
  if (/^\d{4}-\d{2}-\d{2}$/.test(day) && utc8Day(updated) === day) return updated;
  const noon = new Date(day + 'T12:00:00+08:00');
  return Number.isFinite(noon.getTime()) ? noon : updated;
}

function membersOf(pair) {
  const members = Array.isArray(pair.memberOpenids) ? pair.memberOpenids.filter(Boolean) : [];
  if (members.length) return [...new Set(members)];
  return [...new Set([pair.creatorOpenid, pair.partnerOpenid].filter(Boolean))];
}

function migrationMeta(kind, legacyId, migratedAt) {
  return { source: 'legacy-v1', kind, legacyId: String(legacyId || ''), migratedAt };
}

function cleanReminderTime(value) {
  return REMINDER_TIMES.has(value) ? value : '21:30';
}

function transformLegacy(input, nowValue) {
  const now = asDate(nowValue || new Date());
  const couples = Array.isArray(input && input.couples) ? input.couples : [];
  const users = Array.isArray(input && input.users) ? input.users : [];
  const ratings = Array.isArray(input && input.ratings) ? input.ratings : [];
  const blockers = [];
  const warnings = [];
  const pairMap = new Map();
  const userMap = new Map();

  for (const pair of couples) {
    const id = String(pair && pair._id || '');
    if (!id) {
      blockers.push({ code: 'PAIR_MISSING_ID', detail: 'legacy couple has no _id' });
      continue;
    }
    if (pairMap.has(id)) {
      blockers.push({ code: 'PAIR_DUPLICATE_ID', detail: id });
      continue;
    }
    pairMap.set(id, pair);
  }

  for (const user of users) {
    const id = String(user && user._id || '');
    if (!id) {
      blockers.push({ code: 'USER_MISSING_ID', detail: 'legacy couple_user has no _id' });
      continue;
    }
    if (userMap.has(id)) {
      blockers.push({ code: 'USER_DUPLICATE_ID', detail: id });
      continue;
    }
    userMap.set(id, user);
  }

  for (const [id, pair] of pairMap) {
    if (pair.status !== 'active' && pair.status !== 'waiting') {
      blockers.push({ code: 'PAIR_INVALID_STATUS', detail: id + ':' + String(pair.status || '') });
      continue;
    }
    const members = membersOf(pair);
    const expected = pair.status === 'active' ? 2 : 1;
    if (members.length !== expected || !members.includes(pair.creatorOpenid)) {
      blockers.push({ code: 'PAIR_INVALID_MEMBERS', detail: id });
      continue;
    }
    for (const openid of members) {
      const user = userMap.get(openid);
      if (!user || String(user.coupleId || '') !== id) {
        blockers.push({ code: 'PAIR_USER_MISMATCH', detail: id + ':' + openid });
      }
    }
    if (pair.status === 'waiting' && !INVITE_RE.test(String(pair.inviteCode || ''))) {
      blockers.push({ code: 'WAITING_INVITE_INVALID', detail: id });
    }
  }

  for (const [openid, user] of userMap) {
    if (!pairMap.has(String(user.coupleId || ''))) {
      blockers.push({ code: 'USER_ORPHAN_PAIR', detail: openid + ':' + String(user.coupleId || '') });
    }
  }

  const latestByAuthor = new Map();
  const entries = [];
  for (const row of ratings) {
    const legacyId = String(row && row._id || [row && row.coupleId, row && row.date, row && row.ratedBy].join('|'));
    const coupleId = String(row && row.coupleId || '');
    const ratedBy = String(row && row.ratedBy || '');
    const date = String(row && row.date || '');
    const type = String(row && row.type || '');
    const pair = pairMap.get(coupleId);

    if (!pair || !ratedBy || !/^\d{4}-\d{2}-\d{2}$/.test(date) || !RATING_LABELS[type]) {
      blockers.push({ code: 'RATING_INVALID', detail: legacyId });
      continue;
    }
    if (!membersOf(pair).includes(ratedBy)) {
      blockers.push({ code: 'RATING_AUTHOR_NOT_MEMBER', detail: legacyId });
      continue;
    }

    const createdAt = ratingTime(row);
    const updatedAt = asDate(row.updatedAt, createdAt);
    const label = RATING_LABELS[type];
    const entry = {
      _id: 'legacy_entry_' + hash(legacyId),
      coupleId,
      authorOpenid: ratedBy,
      text: String(row.reason || '').slice(0, 1000),
      mood: '',
      images: [],
      version: 1,
      edited: false,
      deleted: false,
      createdAt,
      updatedAt,
      dayKey: date,
      monthKey: date.slice(0, 7),
      legacyRatingType: type,
      legacyRatingLabel: label,
      legacyTargetOpenid: String(row.targetOpenid || ''),
      migration: migrationMeta('rating', legacyId, now),
    };
    entries.push(entry);

    const prev = latestByAuthor.get(ratedBy);
    if (!prev || date > prev.dayKey || (date === prev.dayKey && createdAt > prev.createdAt)) {
      latestByAuthor.set(ratedBy, { dayKey: date, createdAt });
    }
  }

  const outUsers = [];
  for (const [openid, legacy] of userMap) {
    const recent = latestByAuthor.get(openid);
    const createdAt = asDate(legacy.createdAt, now);
    const updatedAt = asDate(legacy.updatedAt, createdAt);
    const user = {
      _id: openid,
      coupleId: String(legacy.coupleId || ''),
      status: legacy.status === 'waiting' ? 'waiting' : 'active',
      createdAt,
      updatedAt,
      moodEmoji: String(legacy.moodEmoji || '').slice(0, 8),
      moodText: String(legacy.moodText || '').slice(0, 60),
      moodUpdatedAt: legacy.moodUpdatedAt ? asDate(legacy.moodUpdatedAt, updatedAt) : null,
      reminderEnabled: !!legacy.reminderEnabled,
      reminderTime: cleanReminderTime(legacy.reminderTime),
      reminderNeedsRenewal: !!legacy.reminderNeedsRenewal,
      reminderLastSentDate: String(legacy.reminderLastSentDate || ''),
      reminderLastSentAt: legacy.reminderLastSentAt ? asDate(legacy.reminderLastSentAt, updatedAt) : null,
      reminderLastError: String(legacy.reminderLastError || '').slice(0, 300),
      reminderAuthorizedAt: legacy.reminderAuthorizedAt ? asDate(legacy.reminderAuthorizedAt, updatedAt) : null,
      reminderUpdatedAt: legacy.reminderUpdatedAt ? asDate(legacy.reminderUpdatedAt, updatedAt) : null,
      reminderVersion: Number.isInteger(legacy.reminderVersion) ? legacy.reminderVersion : 0,
      migration: migrationMeta('user', openid, now),
    };
    if (recent) {
      user.lastSharedDate = recent.dayKey;
      user.lastSharedAt = recent.createdAt;
    }
    outUsers.push(user);
  }

  const outCouples = [];
  const invites = [];
  const agreements = [];
  const coupons = [];
  const requests = [];

  for (const [id, legacy] of pairMap) {
    const members = membersOf(legacy);
    const createdAt = asDate(legacy.createdAt, now);
    const updatedAt = asDate(legacy.updatedAt, createdAt);
    const active = legacy.status === 'active';
    outCouples.push({
      _id: id,
      creatorOpenid: String(legacy.creatorOpenid || ''),
      partnerOpenid: active ? String(legacy.partnerOpenid || members.find(x => x !== legacy.creatorOpenid) || '') : '',
      memberOpenids: active ? members : [String(legacy.creatorOpenid || '')],
      status: active ? 'active' : 'waiting',
      inviteCode: active ? '' : String(legacy.inviteCode || ''),
      inviteExpiresAt: active ? null : asDate(legacy.inviteExpiresAt, updatedAt),
      activatedAt: active ? asDate(legacy.activatedAt || legacy.updatedAt, updatedAt) : null,
      createdAt,
      updatedAt,
      version: Number.isInteger(legacy.version) ? Math.max(1, legacy.version) : 1,
      migration: migrationMeta('couple', id, now),
    });

    if (!active) {
      invites.push({
        _id: String(legacy.inviteCode || ''),
        coupleId: id,
        creatorOpenid: String(legacy.creatorOpenid || ''),
        expiresAt: asDate(legacy.inviteExpiresAt, updatedAt),
        createdAt,
        migration: migrationMeta('invite', legacy.inviteCode, now),
      });
    }

    for (const permission of (Array.isArray(legacy.permissions) ? legacy.permissions : [])) {
      const sourceId = String(permission && permission.id || hash(JSON.stringify(permission || {})));
      const proposedBy = String(permission && permission.grantedBy || '');
      const recipientOpenid = String(permission && permission.grantedTo || '');
      if (!members.includes(proposedBy) || !members.includes(recipientOpenid) || proposedBy === recipientOpenid) {
        blockers.push({ code: 'PERMISSION_INVALID_MEMBERS', detail: id + ':' + sourceId });
        continue;
      }
      const pCreated = asDate(permission.createdAt, createdAt);
      const pUpdated = asDate(permission.updatedAt, pCreated);
      const enabled = permission.enabled !== false;
      agreements.push({
        _id: 'legacy_agreement_' + hash(id + '|' + sourceId),
        coupleId: id,
        proposedBy,
        recipientOpenid,
        title: String(permission.name || '旧版约定').slice(0, 40),
        content: String(permission.note || '').slice(0, 500),
        status: enabled ? 'active' : 'ended',
        replacesId: '',
        replacesVersion: null,
        version: 1,
        createdAt: pCreated,
        updatedAt: pUpdated,
        acceptedAt: enabled ? pCreated : null,
        endedAt: enabled ? null : pUpdated,
        migration: migrationMeta('permission', sourceId, now),
      });
    }

    for (const card of (Array.isArray(legacy.privilegeCards) ? legacy.privilegeCards : [])) {
      const sourceId = String(card && card.id || hash(JSON.stringify(card || {})));
      const issuedBy = String(card && card.issuedBy || '');
      const receivedBy = String(card && card.issuedTo || '');
      if (!members.includes(issuedBy) || !members.includes(receivedBy) || issuedBy === receivedBy) {
        blockers.push({ code: 'CARD_INVALID_MEMBERS', detail: id + ':' + sourceId });
        continue;
      }
      const legacyStatus = String(card.status || 'active');
      const status = legacyStatus === 'used' ? 'used' : legacyStatus === 'revoked' ? 'revoked' : 'available';
      const cCreated = asDate(card.createdAt, createdAt);
      const cUpdated = asDate(card.updatedAt || card.usedAt || card.revokedAt, cCreated);
      const couponId = 'legacy_coupon_' + hash(id + '|' + sourceId);
      coupons.push({
        _id: couponId,
        coupleId: id,
        issuedBy,
        receivedBy,
        title: String(card.name || '旧版心意券').slice(0, 40),
        note: String(card.note || '').slice(0, 200),
        status,
        currentRequestId: '',
        version: 1,
        createdAt: cCreated,
        updatedAt: cUpdated,
        usedAt: status === 'used' ? asDate(card.usedAt, cUpdated) : null,
        revokedAt: status === 'revoked' ? asDate(card.revokedAt, cUpdated) : null,
        migration: migrationMeta('privilegeCard', sourceId, now),
      });
      if (status === 'used') {
        const resolvedAt = asDate(card.usedAt, cUpdated);
        requests.push({
          _id: 'legacy_request_' + hash(couponId + '|used'),
          couponId,
          coupleId: id,
          requestedBy: receivedBy,
          respondedBy: issuedBy,
          status: 'used',
          version: 2,
          createdAt: resolvedAt,
          updatedAt: resolvedAt,
          resolvedAt,
          lastActorOpenid: issuedBy,
          migration: Object.assign(migrationMeta('privilegeCardUse', sourceId, now), { synthesizedHistory: true }),
        });
      }
    }
  }

  const counts = {
    legacyCouples: couples.length,
    legacyUsers: users.length,
    legacyRatings: ratings.length,
    v2Couples: outCouples.length,
    v2Users: outUsers.length,
    v2Invites: invites.length,
    v2Entries: entries.length,
    v2Agreements: agreements.length,
    v2Coupons: coupons.length,
    v2CouponRequests: requests.length,
  };

  if (ratings.length !== entries.length) {
    warnings.push({ code: 'RATING_COUNT_DIFFERS', detail: ratings.length + ' -> ' + entries.length });
  }

  return {
    ok: blockers.length === 0,
    blockers,
    warnings,
    counts,
    documents: {
      v2_users: outUsers,
      v2_couples: outCouples,
      v2_invites: invites,
      v2_entries: entries,
      v2_agreements: agreements,
      v2_coupons: coupons,
      v2_coupon_requests: requests,
    },
  };
}

module.exports = { transformLegacy, ratingTime, utc8Day };
