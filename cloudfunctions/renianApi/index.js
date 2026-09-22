const cloud = require('wx-server-sdk');
const crypto = require('crypto');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();
const COLLECTIONS = {
  couples: 'couples',
  users: 'couple_users',
  ratings: 'ratings',
};
const INVITE_TTL_MS = 24 * 60 * 60 * 1000;
const INVITE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

class ApiError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function ok(data) {
  return { ok: true, data };
}

function fail(code, message) {
  return { ok: false, error: { code, message } };
}

function todayInUTC8() {
  return new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

function makePairId() {
  return 'pair_' + crypto.randomBytes(12).toString('hex');
}

function makeInviteCode() {
  const bytes = crypto.randomBytes(8);
  let code = '';
  for (let i = 0; i < 8; i += 1) {
    code += INVITE_ALPHABET[bytes[i] % INVITE_ALPHABET.length];
  }
  return code;
}

function memberKey(openid) {
  return crypto.createHash('sha256').update(openid).digest('hex').slice(0, 16);
}

function ratingId(coupleId, date, authorOpenid) {
  return coupleId + '_' + date + '_' + memberKey(authorOpenid);
}

async function safeGet(ref) {
  try {
    const res = await ref.get();
    return res && res.data ? res.data : null;
  } catch (e) {
    return null;
  }
}

async function getMembership(openid) {
  const user = await safeGet(db.collection(COLLECTIONS.users).doc(openid));
  if (!user || !user.coupleId) return null;

  const pair = await safeGet(
    db.collection(COLLECTIONS.couples).doc(user.coupleId)
  );
  if (!pair) {
    throw new ApiError('PAIR_NOT_FOUND', '绑定关系不存在，请重新绑定');
  }

  return { user, pair };
}

function publicSession(openid, membership) {
  if (!membership) {
    return {
      bound: false,
      bindingStatus: 'unbound',
      canRate: false,
      isCreator: false,
      inviteCode: '',
      inviteExpiresAt: null,
    };
  }

  const { pair } = membership;
  const active = pair.status === 'active';
  const creator = pair.creatorOpenid === openid;

  return {
    bound: active,
    bindingStatus: pair.status || 'waiting',
    canRate: active,
    isCreator: creator,
    inviteCode: creator && pair.status === 'waiting' ? pair.inviteCode || '' : '',
    inviteExpiresAt:
      creator && pair.status === 'waiting' ? pair.inviteExpiresAt || null : null,
  };
}

async function uniqueInviteCode() {
  for (let i = 0; i < 8; i += 1) {
    const code = makeInviteCode();
    const res = await db
      .collection(COLLECTIONS.couples)
      .where({ inviteCode: code, status: 'waiting' })
      .limit(1)
      .get();
    if (!res.data || !res.data.length) return code;
  }
  throw new ApiError('INVITE_CREATE_FAILED', '暂时无法生成绑定码，请稍后重试');
}

async function getSession(openid) {
  return publicSession(openid, await getMembership(openid));
}

async function createInvite(openid) {
  const existing = await getMembership(openid);

  if (existing) {
    if (existing.pair.status === 'active') return publicSession(openid, existing);

    if (
      existing.pair.status === 'waiting' &&
      existing.pair.creatorOpenid === openid
    ) {
      const expireTime = new Date(existing.pair.inviteExpiresAt || 0).getTime();
      if (expireTime > Date.now() && existing.pair.inviteCode) {
        return publicSession(openid, existing);
      }
      return refreshInvite(openid);
    }

    throw new ApiError('ALREADY_BOUND', '你已经存在绑定关系');
  }

  const pairId = makePairId();
  const inviteCode = await uniqueInviteCode();
  const now = new Date();
  const inviteExpiresAt = new Date(now.getTime() + INVITE_TTL_MS);

  await db.runTransaction(async (transaction) => {
    let alreadyExists = null;
    try {
      const current = await transaction
        .collection(COLLECTIONS.users)
        .doc(openid)
        .get();
      alreadyExists = current && current.data;
    } catch (e) {
      alreadyExists = null;
    }

    if (alreadyExists) {
      throw new ApiError('ALREADY_BOUND', '你已经存在绑定关系');
    }

    await transaction.collection(COLLECTIONS.couples).doc(pairId).set({
      data: {
        status: 'waiting',
        creatorOpenid: openid,
        partnerOpenid: '',
        memberOpenids: [openid],
        inviteCode,
        inviteExpiresAt,
        createdAt: now,
        updatedAt: now,
      },
    });

    await transaction.collection(COLLECTIONS.users).doc(openid).set({
      data: {
        coupleId: pairId,
        status: 'waiting',
        createdAt: now,
        updatedAt: now,
      },
    });
  });

  return getSession(openid);
}

async function refreshInvite(openid) {
  const membership = await getMembership(openid);
  if (!membership) throw new ApiError('NOT_BOUND', '请先发起绑定');

  const { pair } = membership;
  if (pair.status !== 'waiting' || pair.creatorOpenid !== openid) {
    throw new ApiError('INVITE_NOT_AVAILABLE', '当前没有可更新的绑定邀请');
  }

  const inviteCode = await uniqueInviteCode();
  const now = new Date();
  const inviteExpiresAt = new Date(now.getTime() + INVITE_TTL_MS);

  await db.collection(COLLECTIONS.couples).doc(pair._id).update({
    data: {
      inviteCode,
      inviteExpiresAt,
      updatedAt: now,
    },
  });

  return getSession(openid);
}

async function cancelInvite(openid) {
  const membership = await getMembership(openid);
  if (!membership) return getSession(openid);

  const { pair } = membership;
  if (pair.status !== 'waiting' || pair.creatorOpenid !== openid) {
    throw new ApiError('CANNOT_CANCEL', '只有发起人可以取消未完成的邀请');
  }

  await db.runTransaction(async (transaction) => {
    await transaction.collection(COLLECTIONS.couples).doc(pair._id).remove();
    await transaction.collection(COLLECTIONS.users).doc(openid).remove();
  });

  return getSession(openid);
}

async function joinPair(openid, rawCode) {
  const code = String(rawCode || '')
    .toUpperCase()
    .replace(/[^A-Z2-9]/g, '')
    .slice(0, 8);

  if (code.length !== 8) {
    throw new ApiError('INVALID_INVITE', '请输入正确的 8 位绑定码');
  }

  const existing = await getMembership(openid);
  if (existing) throw new ApiError('ALREADY_BOUND', '你已经存在绑定关系');

  const found = await db
    .collection(COLLECTIONS.couples)
    .where({ inviteCode: code, status: 'waiting' })
    .limit(1)
    .get();

  if (!found.data || !found.data.length) {
    throw new ApiError('INVITE_NOT_FOUND', '绑定码不存在或已经使用');
  }

  const pairId = found.data[0]._id;
  const now = new Date();

  await db.runTransaction(async (transaction) => {
    const pairRes = await transaction
      .collection(COLLECTIONS.couples)
      .doc(pairId)
      .get();
    const pair = pairRes.data;

    if (!pair || pair.status !== 'waiting' || pair.inviteCode !== code) {
      throw new ApiError('INVITE_NOT_FOUND', '绑定码不存在或已经使用');
    }

    if (pair.creatorOpenid === openid) {
      throw new ApiError('SELF_JOIN', '不能使用自己生成的绑定码加入');
    }

    if (new Date(pair.inviteExpiresAt || 0).getTime() <= Date.now()) {
      throw new ApiError('INVITE_EXPIRED', '绑定码已过期，请让对方重新生成');
    }

    let currentUser = null;
    try {
      const userRes = await transaction
        .collection(COLLECTIONS.users)
        .doc(openid)
        .get();
      currentUser = userRes && userRes.data;
    } catch (e) {
      currentUser = null;
    }
    if (currentUser) {
      throw new ApiError('ALREADY_BOUND', '你已经存在绑定关系');
    }

    await transaction.collection(COLLECTIONS.couples).doc(pairId).update({
      data: {
        status: 'active',
        partnerOpenid: openid,
        memberOpenids: [pair.creatorOpenid, openid],
        inviteCode: null,
        activatedAt: now,
        updatedAt: now,
      },
    });

    await transaction.collection(COLLECTIONS.users).doc(openid).set({
      data: {
        coupleId: pairId,
        status: 'active',
        createdAt: now,
        updatedAt: now,
      },
    });

    await transaction
      .collection(COLLECTIONS.users)
      .doc(pair.creatorOpenid)
      .update({
        data: {
          status: 'active',
          updatedAt: now,
        },
      });
  });

  return getSession(openid);
}

async function requireActive(openid) {
  const membership = await getMembership(openid);
  if (!membership) throw new ApiError('NOT_BOUND', '请先完成双人绑定');
  if (membership.pair.status !== 'active') {
    throw new ApiError('PAIR_NOT_ACTIVE', '还在等待另一位加入');
  }

  const members = membership.pair.memberOpenids || [];
  if (!members.includes(openid) || members.length !== 2) {
    throw new ApiError('PAIR_INVALID', '双人关系数据异常');
  }

  return membership;
}

function partnerOf(pair, openid) {
  const members = pair.memberOpenids || [];
  return members.find((id) => id !== openid) || '';
}

function cleanRating(doc, openid) {
  if (!doc) return null;
  const fromMe = doc.ratedBy === openid;
  return {
    date: doc.date,
    type: doc.type,
    reason: String(doc.reason || '').slice(0, 200),
    fromMe,
    direction: fromMe ? 'sent' : 'received',
    directionLabel: fromMe ? '我给 TA' : 'TA 给我',
  };
}

async function getToday(openid) {
  const membership = await requireActive(openid);
  const date = todayInUTC8();
  const partnerOpenid = partnerOf(membership.pair, openid);

  const myDoc = await safeGet(
    db
      .collection(COLLECTIONS.ratings)
      .doc(ratingId(membership.pair._id, date, openid))
  );

  const partnerDoc = partnerOpenid
    ? await safeGet(
        db
          .collection(COLLECTIONS.ratings)
          .doc(ratingId(membership.pair._id, date, partnerOpenid))
      )
    : null;

  return {
    date,
    rating: cleanRating(myDoc, openid),
    partnerRating: cleanRating(partnerDoc, openid),
    canRate: true,
  };
}

async function listRatings(openid) {
  const membership = await requireActive(openid);
  const all = [];
  let skip = 0;
  const limit = 100;

  for (;;) {
    const res = await db
      .collection(COLLECTIONS.ratings)
      .where({ coupleId: membership.pair._id })
      .skip(skip)
      .limit(limit)
      .get();

    const rows = res.data || [];
    all.push(...rows);
    if (rows.length < limit) break;
    skip += limit;
  }

  all.sort((a, b) => {
    if (a.date !== b.date) return a.date < b.date ? 1 : -1;
    if (a.ratedBy === openid && b.ratedBy !== openid) return -1;
    if (a.ratedBy !== openid && b.ratedBy === openid) return 1;
    return 0;
  });

  return all.map((item) => cleanRating(item, openid));
}

async function saveToday(openid, event) {
  const membership = await requireActive(openid);

  const type = event.type;
  if (type !== 'good' && type !== 'bad') {
    throw new ApiError('INVALID_RATING', '请选择好评或差评');
  }

  const targetOpenid = partnerOf(membership.pair, openid);
  if (!targetOpenid) {
    throw new ApiError('PAIR_INVALID', '找不到绑定对象');
  }

  const reason = String(event.reason || '').trim().slice(0, 200);
  const date = todayInUTC8();
  const now = new Date();

  await db
    .collection(COLLECTIONS.ratings)
    .doc(ratingId(membership.pair._id, date, openid))
    .set({
      data: {
        coupleId: membership.pair._id,
        date,
        type,
        reason,
        ratedBy: openid,
        targetOpenid,
        updatedAt: now,
      },
    });

  return {
    date,
    rating: {
      date,
      type,
      reason,
      fromMe: true,
      direction: 'sent',
      directionLabel: '我给 TA',
    },
  };
}

exports.main = async (event) => {
  try {
    const { OPENID } = cloud.getWXContext();
    if (!OPENID) throw new ApiError('NO_IDENTITY', '无法获取微信身份');

    const action = String((event && event.action) || '');

    switch (action) {
      case 'session.get':
        return ok(await getSession(OPENID));
      case 'pair.create':
        return ok(await createInvite(OPENID));
      case 'pair.refresh':
        return ok(await refreshInvite(OPENID));
      case 'pair.cancel':
        return ok(await cancelInvite(OPENID));
      case 'pair.join':
        return ok(await joinPair(OPENID, event.inviteCode));
      case 'rating.today':
        return ok(await getToday(OPENID));
      case 'rating.list':
        return ok(await listRatings(OPENID));
      case 'rating.save':
        return ok(await saveToday(OPENID, event));
      default:
        throw new ApiError('UNKNOWN_ACTION', '未知操作');
    }
  } catch (e) {
    console.error('[renianApi]', e);
    if (e instanceof ApiError) return fail(e.code, e.message);
    return fail('INTERNAL', '服务暂时不可用，请稍后再试');
  }
};
