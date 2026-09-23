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
const INVITE_WRITE_RETRIES = 8;

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

// 【P5 修复】只吞「文档不存在」，其余异常（瞬时故障、权限、限流）必须上抛。
// 原写法吞掉所有异常返回 null，会把数据库抖动伪装成「记录不存在」，
// 导致 getMembership 把正常用户误判为未绑定。
function isDocMissing(e) {
  const code = e && (e.errCode !== undefined ? e.errCode : e.code);
  const msg = String((e && (e.errMsg || e.message)) || '');
  return (
    code === -1 ||
    /document\s*(not\s*)?(exists|exist)/i.test(msg) ||
    /not\s*found/i.test(msg)
  );
}

function isDuplicateWrite(e) {
  const code = e && (e.errCode !== undefined ? e.errCode : e.code);
  const msg = String((e && (e.errMsg || e.message)) || '');
  return (
    code === 'DATABASE_DUPLICATE_WRITE' ||
    code === 11000 ||
    String(code || '') === '11000' ||
    /DATABASE_DUPLICATE_WRITE/i.test(msg) ||
    /E11000/i.test(msg) ||
    /duplicate\s+key/i.test(msg) ||
    /index\s+key\s+duplicate/i.test(msg)
  );
}

async function safeGet(ref) {
  try {
    const res = await ref.get();
    return res && res.data ? res.data : null;
  } catch (e) {
    if (isDocMissing(e)) return null;
    throw e;
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

  // uniqueInviteCode() 的查询只是提前避开绝大多数碰撞；
  // 最终唯一性由 couples.inviteCode 的唯一索引保证。
  // 如果两个请求在“查询不存在”后同时写入，唯一索引会拒绝其中一个，
  // 此处捕获 duplicate write 后更换 pairId + inviteCode 重试整个事务。
  for (let attempt = 0; attempt < INVITE_WRITE_RETRIES; attempt += 1) {
    const pairId = makePairId();
    const inviteCode = await uniqueInviteCode();
    const now = new Date();
    const inviteExpiresAt = new Date(now.getTime() + INVITE_TTL_MS);

    try {
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
    } catch (e) {
      if (!isDuplicateWrite(e)) throw e;

      // duplicate write 也可能来自同一个用户的并发 pair.create。
      // 先重读 membership；若另一请求已经成功，就直接返回现有会话。
      const afterDuplicate = await getMembership(openid);
      if (afterDuplicate) {
        if (
          afterDuplicate.pair.status === 'active' ||
          (afterDuplicate.pair.status === 'waiting' &&
            afterDuplicate.pair.creatorOpenid === openid)
        ) {
          return publicSession(openid, afterDuplicate);
        }
        throw new ApiError('ALREADY_BOUND', '你已经存在绑定关系');
      }

      console.warn(
        '[renianApi] duplicate write during pair.create, retrying',
        attempt + 1
      );
    }
  }

  throw new ApiError('INVITE_CREATE_FAILED', '暂时无法生成绑定码，请稍后重试');
}

async function refreshInvite(openid) {
  const membership = await getMembership(openid);
  if (!membership) throw new ApiError('NOT_BOUND', '请先发起绑定');

  const pairId = membership.pair._id;

  for (let attempt = 0; attempt < INVITE_WRITE_RETRIES; attempt += 1) {
    const inviteCode = await uniqueInviteCode();
    const now = new Date();
    const inviteExpiresAt = new Date(now.getTime() + INVITE_TTL_MS);

    try {
      await db.runTransaction(async (transaction) => {
        // 【P2 修复】状态校验在事务内重读，避免 active pair 被刷新邀请码。
        let pair = null;
        try {
          const res = await transaction
            .collection(COLLECTIONS.couples)
            .doc(pairId)
            .get();
          pair = res && res.data;
        } catch (e) {
          pair = null;
        }

        if (!pair || pair.status !== 'waiting' || pair.creatorOpenid !== openid) {
          throw new ApiError('INVITE_NOT_AVAILABLE', '当前没有可更新的绑定邀请');
        }

        await transaction.collection(COLLECTIONS.couples).doc(pairId).update({
          data: {
            inviteCode,
            inviteExpiresAt,
            updatedAt: now,
          },
        });
      });

      return getSession(openid);
    } catch (e) {
      if (!isDuplicateWrite(e)) throw e;

      console.warn(
        '[renianApi] duplicate write during pair.refresh, retrying',
        attempt + 1
      );
    }
  }

  throw new ApiError('INVITE_CREATE_FAILED', '暂时无法生成绑定码，请稍后重试');
}

async function cancelInvite(openid) {
  const membership = await getMembership(openid);
  if (!membership) return getSession(openid);

  const pairId = membership.pair._id;

  await db.runTransaction(async (transaction) => {
    // 【P1 修复】状态校验必须在事务内【重读】。原写法在事务外检查
    // status，存在 TOCTOU：若对方恰在此刻 joinPair 成功，本函数会把一个
    // 已生效的 couple 删掉，且只删发起人的 couple_users，给对方留下悬空
    // coupleId（后续全报 PAIR_NOT_FOUND，且无法自行解绑 → 账号永久卡死）。
    let pair = null;
    try {
      const res = await transaction.collection(COLLECTIONS.couples).doc(pairId).get();
      pair = res && res.data;
    } catch (e) {
      pair = null;
    }

    if (!pair) return; // 已经不在了，视作取消成功

    if (pair.status !== 'waiting') {
      throw new ApiError('CANNOT_CANCEL', '对方已加入，这次绑定不能再取消');
    }
    if (pair.creatorOpenid !== openid) {
      throw new ApiError('CANNOT_CANCEL', '只有发起人可以取消未完成的邀请');
    }

    // 只有 status === 'waiting' 的 pair 才只有一个成员（发起人），
    // 因此这里只删发起人的 couple_users 是安全的、不会产生悬空指针。
    await transaction.collection(COLLECTIONS.couples).doc(pairId).remove();
    await transaction.collection(COLLECTIONS.users).doc(openid).remove();
  });

  return getSession(openid);
}

// 【P6 修复】pair.join 限流：纵深防御。
// 主防线是邀请码熵（8 位 × 32 字符表 ≈ 40bit，暴力枚举 ~2^40 不可行），
// 这里是第二道。⚠️ 内存桶按云函数实例隔离，冷启动会重置 —— 若要严格
// 全局限流，需改成数据库计数器或网关层配额。
const JOIN_LIMIT = 10;
const JOIN_WINDOW_MS = 60 * 60 * 1000;
const joinAttempts = new Map();

function throttleJoin(openid) {
  const now = Date.now();
  const bucket = joinAttempts.get(openid) || {
    count: 0,
    resetAt: now + JOIN_WINDOW_MS,
  };
  if (now > bucket.resetAt) {
    bucket.count = 0;
    bucket.resetAt = now + JOIN_WINDOW_MS;
  }
  bucket.count += 1;
  joinAttempts.set(openid, bucket);
  if (joinAttempts.size > 5000) {
    for (const [k, v] of joinAttempts) {
      if (now > v.resetAt) joinAttempts.delete(k);
    }
  }
  if (bucket.count > JOIN_LIMIT) {
    throw new ApiError('TOO_MANY_ATTEMPTS', '尝试次数过多，请稍后再试');
  }
}

async function joinPair(openid, rawCode) {
  throttleJoin(openid);

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
        // 【P3 修复·方案 B】不用 null（多个 null 会撞唯一索引），
        // 改写成天然唯一的 USED_<pairId>，就能直接用普通唯一索引兕底。
        // 长度 > 8 且含下划线，不会与 8 位邀请码混淆。
        inviteCode: 'USED_' + pairId,
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
    // 【P4 修复】必须给稳定排序，否则云数据库 skip/limit 无全序时
    // 可能漏行/重行，长期表现为静默丢记录。(date, ratedBy) 与文档 ID
    // 一一对应，构成全序。展示顺序仍由下方客户端排序决定。
    const res = await db
      .collection(COLLECTIONS.ratings)
      .where({ coupleId: membership.pair._id })
      .orderBy('date', 'desc')
      .orderBy('ratedBy', 'asc')
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


const MAX_PERMISSIONS_PER_PAIR = 50;

function makePermissionId() {
  return 'perm_' + crypto.randomBytes(10).toString('hex');
}

function normalizePermissionText(event) {
  const name = String((event && event.name) || '')
    .trim()
    .replace(/\s+/g, ' ')
    .slice(0, 20);
  const note = String((event && event.note) || '').trim().slice(0, 100);

  if (!name) {
    throw new ApiError('INVALID_PERMISSION', '权限名称不能为空');
  }

  return { name, note };
}

function permissionListOf(pair) {
  return Array.isArray(pair && pair.permissions) ? pair.permissions : [];
}

function cleanPermission(item, openid) {
  if (!item) return null;
  const fromMe = item.grantedBy === openid;
  return {
    id: item.id,
    name: String(item.name || '').slice(0, 20),
    note: String(item.note || '').slice(0, 100),
    enabled: item.enabled !== false,
    fromMe,
    canManage: fromMe,
    direction: fromMe ? 'sent' : 'received',
    directionLabel: fromMe ? '我给 TA' : 'TA 给我',
  };
}

function assertActivePairDocument(pair, openid) {
  if (!pair || pair.status !== 'active') {
    throw new ApiError('PAIR_NOT_ACTIVE', '双人关系当前不可用');
  }

  const members = pair.memberOpenids || [];
  if (members.length !== 2 || !members.includes(openid)) {
    throw new ApiError('PAIR_INVALID', '双人关系数据异常');
  }
}

async function listPermissions(openid) {
  const membership = await requireActive(openid);
  const items = permissionListOf(membership.pair)
    .slice()
    .sort((a, b) => {
      const at = new Date(a.updatedAt || a.createdAt || 0).getTime();
      const bt = new Date(b.updatedAt || b.createdAt || 0).getTime();
      return bt - at;
    });

  return items.map((item) => cleanPermission(item, openid));
}

async function createPermission(openid, event) {
  const input = normalizePermissionText(event);
  const membership = await requireActive(openid);
  const pairId = membership.pair._id;
  const id = makePermissionId();
  const now = new Date();
  let created = null;

  await db.runTransaction(async (transaction) => {
    const pairRes = await transaction
      .collection(COLLECTIONS.couples)
      .doc(pairId)
      .get();
    const pair = pairRes && pairRes.data;
    assertActivePairDocument(pair, openid);

    const targetOpenid = partnerOf(pair, openid);
    if (!targetOpenid) {
      throw new ApiError('PAIR_INVALID', '找不到绑定对象');
    }

    const permissions = permissionListOf(pair).slice();
    if (permissions.length >= MAX_PERMISSIONS_PER_PAIR) {
      throw new ApiError('PERMISSION_LIMIT', '最多保留 50 项权限，请先删除不用的权限');
    }

    const duplicate = permissions.some(
      (item) =>
        item.grantedBy === openid &&
        String(item.name || '').trim().toLowerCase() === input.name.toLowerCase()
    );
    if (duplicate) {
      throw new ApiError('PERMISSION_EXISTS', '你已经给 TA 添加过同名权限');
    }

    created = {
      id,
      name: input.name,
      note: input.note,
      enabled: true,
      grantedBy: openid,
      grantedTo: targetOpenid,
      createdAt: now,
      updatedAt: now,
    };

    permissions.unshift(created);

    await transaction.collection(COLLECTIONS.couples).doc(pairId).update({
      data: {
        permissions,
        updatedAt: now,
      },
    });
  });

  return cleanPermission(created, openid);
}

async function updatePermission(openid, event) {
  const id = String((event && event.permissionId) || '').trim();
  if (!id) throw new ApiError('INVALID_PERMISSION', '缺少权限 ID');

  const input = normalizePermissionText(event);
  const membership = await requireActive(openid);
  const pairId = membership.pair._id;
  const now = new Date();
  let updated = null;

  await db.runTransaction(async (transaction) => {
    const pairRes = await transaction
      .collection(COLLECTIONS.couples)
      .doc(pairId)
      .get();
    const pair = pairRes && pairRes.data;
    assertActivePairDocument(pair, openid);

    const permissions = permissionListOf(pair).slice();
    const index = permissions.findIndex((item) => item && item.id === id);
    if (index < 0) throw new ApiError('PERMISSION_NOT_FOUND', '这项权限不存在');

    const current = permissions[index];
    if (current.grantedBy !== openid) {
      throw new ApiError('PERMISSION_FORBIDDEN', '只能修改自己授予 TA 的权限');
    }

    const duplicate = permissions.some(
      (item, i) =>
        i !== index &&
        item.grantedBy === openid &&
        String(item.name || '').trim().toLowerCase() === input.name.toLowerCase()
    );
    if (duplicate) {
      throw new ApiError('PERMISSION_EXISTS', '你已经给 TA 添加过同名权限');
    }

    updated = Object.assign({}, current, {
      name: input.name,
      note: input.note,
      updatedAt: now,
    });
    permissions[index] = updated;

    await transaction.collection(COLLECTIONS.couples).doc(pairId).update({
      data: {
        permissions,
        updatedAt: now,
      },
    });
  });

  return cleanPermission(updated, openid);
}

async function togglePermission(openid, event) {
  const id = String((event && event.permissionId) || '').trim();
  if (!id || typeof event.enabled !== 'boolean') {
    throw new ApiError('INVALID_PERMISSION', '权限状态参数不正确');
  }

  const membership = await requireActive(openid);
  const pairId = membership.pair._id;
  const now = new Date();
  let updated = null;

  await db.runTransaction(async (transaction) => {
    const pairRes = await transaction
      .collection(COLLECTIONS.couples)
      .doc(pairId)
      .get();
    const pair = pairRes && pairRes.data;
    assertActivePairDocument(pair, openid);

    const permissions = permissionListOf(pair).slice();
    const index = permissions.findIndex((item) => item && item.id === id);
    if (index < 0) throw new ApiError('PERMISSION_NOT_FOUND', '这项权限不存在');

    const current = permissions[index];
    if (current.grantedBy !== openid) {
      throw new ApiError('PERMISSION_FORBIDDEN', '只能管理自己授予 TA 的权限');
    }

    updated = Object.assign({}, current, {
      enabled: event.enabled,
      updatedAt: now,
    });
    permissions[index] = updated;

    await transaction.collection(COLLECTIONS.couples).doc(pairId).update({
      data: {
        permissions,
        updatedAt: now,
      },
    });
  });

  return cleanPermission(updated, openid);
}

async function deletePermission(openid, event) {
  const id = String((event && event.permissionId) || '').trim();
  if (!id) throw new ApiError('INVALID_PERMISSION', '缺少权限 ID');

  const membership = await requireActive(openid);
  const pairId = membership.pair._id;
  const now = new Date();

  await db.runTransaction(async (transaction) => {
    const pairRes = await transaction
      .collection(COLLECTIONS.couples)
      .doc(pairId)
      .get();
    const pair = pairRes && pairRes.data;
    assertActivePairDocument(pair, openid);

    const permissions = permissionListOf(pair).slice();
    const index = permissions.findIndex((item) => item && item.id === id);
    if (index < 0) throw new ApiError('PERMISSION_NOT_FOUND', '这项权限不存在');

    if (permissions[index].grantedBy !== openid) {
      throw new ApiError('PERMISSION_FORBIDDEN', '只能删除自己授予 TA 的权限');
    }

    permissions.splice(index, 1);

    await transaction.collection(COLLECTIONS.couples).doc(pairId).update({
      data: {
        permissions,
        updatedAt: now,
      },
    });
  });

  return { deleted: true, id };
}



const MAX_PRIVILEGE_CARDS_PER_PAIR = 80;

function makePrivilegeCardId() {
  return 'card_' + crypto.randomBytes(10).toString('hex');
}

function privilegeCardsOf(pair) {
  return Array.isArray(pair && pair.privilegeCards) ? pair.privilegeCards : [];
}

function normalizePrivilegeCardInput(event) {
  const name = String((event && event.name) || '')
    .trim()
    .replace(/\s+/g, ' ')
    .slice(0, 20);
  const note = String((event && event.note) || '').trim().slice(0, 100);

  if (!name) {
    throw new ApiError('INVALID_PRIVILEGE_CARD', '特权卡名称不能为空');
  }

  return { name, note };
}

function isoOrEmpty(value) {
  if (!value) return '';
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? '' : d.toISOString();
}

function cleanPrivilegeCard(item, openid) {
  if (!item) return null;

  const fromMe = item.issuedBy === openid;
  const receivedByMe = item.issuedTo === openid;
  const status = item.status || 'active';

  return {
    id: item.id,
    name: String(item.name || '').slice(0, 20),
    note: String(item.note || '').slice(0, 100),
    status,
    fromMe,
    receivedByMe,
    direction: fromMe ? 'sent' : 'received',
    directionLabel: fromMe ? '我给 TA' : 'TA 给我',
    canUse: status === 'active' && receivedByMe,
    canRevoke: status === 'active' && fromMe,
    createdAt: isoOrEmpty(item.createdAt),
    usedAt: isoOrEmpty(item.usedAt),
    revokedAt: isoOrEmpty(item.revokedAt),
  };
}

async function listPrivilegeCards(openid) {
  const membership = await requireActive(openid);
  return privilegeCardsOf(membership.pair)
    .slice()
    .sort((a, b) => {
      const at = new Date(a.createdAt || 0).getTime();
      const bt = new Date(b.createdAt || 0).getTime();
      return bt - at;
    })
    .map((item) => cleanPrivilegeCard(item, openid));
}

async function createPrivilegeCard(openid, event) {
  const input = normalizePrivilegeCardInput(event);
  const membership = await requireActive(openid);
  const pairId = membership.pair._id;
  const id = makePrivilegeCardId();
  const now = new Date();
  let created = null;

  await db.runTransaction(async (transaction) => {
    const pairRes = await transaction
      .collection(COLLECTIONS.couples)
      .doc(pairId)
      .get();
    const pair = pairRes && pairRes.data;
    assertActivePairDocument(pair, openid);

    const targetOpenid = partnerOf(pair, openid);
    if (!targetOpenid) {
      throw new ApiError('PAIR_INVALID', '找不到绑定对象');
    }

    let cards = privilegeCardsOf(pair).slice();
    if (cards.length >= MAX_PRIVILEGE_CARDS_PER_PAIR) {
      const activeCards = cards.filter(
        (item) => (item.status || 'active') === 'active'
      );
      if (activeCards.length >= MAX_PRIVILEGE_CARDS_PER_PAIR) {
        throw new ApiError(
          'PRIVILEGE_CARD_LIMIT',
          '当前未使用的特权卡太多，请先使用或撤回一些'
        );
      }

      // 自动保留全部未使用卡 + 最近的历史卡，避免 couple 文档无限膨胀。
      const historyCards = cards.filter(
        (item) => (item.status || 'active') !== 'active'
      );
      const historyLimit = MAX_PRIVILEGE_CARDS_PER_PAIR - 1 - activeCards.length;
      cards = activeCards
        .concat(historyCards.slice(0, Math.max(0, historyLimit)))
        .sort((a, b) => {
          const at = new Date(a.createdAt || 0).getTime();
          const bt = new Date(b.createdAt || 0).getTime();
          return bt - at;
        });
    }

    created = {
      id,
      name: input.name,
      note: input.note,
      status: 'active',
      issuedBy: openid,
      issuedTo: targetOpenid,
      createdAt: now,
      updatedAt: now,
    };

    cards.unshift(created);

    await transaction.collection(COLLECTIONS.couples).doc(pairId).update({
      data: {
        privilegeCards: cards,
        updatedAt: now,
      },
    });
  });

  return cleanPrivilegeCard(created, openid);
}

async function usePrivilegeCard(openid, event) {
  const id = String((event && event.cardId) || '').trim();
  if (!id) throw new ApiError('INVALID_PRIVILEGE_CARD', '缺少特权卡 ID');

  const membership = await requireActive(openid);
  const pairId = membership.pair._id;
  const now = new Date();
  let used = null;

  await db.runTransaction(async (transaction) => {
    const pairRes = await transaction
      .collection(COLLECTIONS.couples)
      .doc(pairId)
      .get();
    const pair = pairRes && pairRes.data;
    assertActivePairDocument(pair, openid);

    const cards = privilegeCardsOf(pair).slice();
    const index = cards.findIndex((item) => item && item.id === id);
    if (index < 0) {
      throw new ApiError('PRIVILEGE_CARD_NOT_FOUND', '这张特权卡不存在');
    }

    const current = cards[index];
    if (current.issuedTo !== openid) {
      throw new ApiError('PRIVILEGE_CARD_FORBIDDEN', '只有收到这张卡的人可以使用');
    }
    if ((current.status || 'active') !== 'active') {
      throw new ApiError('PRIVILEGE_CARD_ALREADY_USED', '这张特权卡已经不能使用');
    }

    used = Object.assign({}, current, {
      status: 'used',
      usedAt: now,
      updatedAt: now,
    });
    cards[index] = used;

    await transaction.collection(COLLECTIONS.couples).doc(pairId).update({
      data: {
        privilegeCards: cards,
        updatedAt: now,
      },
    });
  });

  return cleanPrivilegeCard(used, openid);
}

async function revokePrivilegeCard(openid, event) {
  const id = String((event && event.cardId) || '').trim();
  if (!id) throw new ApiError('INVALID_PRIVILEGE_CARD', '缺少特权卡 ID');

  const membership = await requireActive(openid);
  const pairId = membership.pair._id;
  const now = new Date();
  let revoked = null;

  await db.runTransaction(async (transaction) => {
    const pairRes = await transaction
      .collection(COLLECTIONS.couples)
      .doc(pairId)
      .get();
    const pair = pairRes && pairRes.data;
    assertActivePairDocument(pair, openid);

    const cards = privilegeCardsOf(pair).slice();
    const index = cards.findIndex((item) => item && item.id === id);
    if (index < 0) {
      throw new ApiError('PRIVILEGE_CARD_NOT_FOUND', '这张特权卡不存在');
    }

    const current = cards[index];
    if (current.issuedBy !== openid) {
      throw new ApiError('PRIVILEGE_CARD_FORBIDDEN', '只能撤回自己发给 TA 的卡');
    }
    if ((current.status || 'active') !== 'active') {
      throw new ApiError('PRIVILEGE_CARD_ALREADY_USED', '已使用或已撤回的卡不能再次撤回');
    }

    revoked = Object.assign({}, current, {
      status: 'revoked',
      revokedAt: now,
      updatedAt: now,
    });
    cards[index] = revoked;

    await transaction.collection(COLLECTIONS.couples).doc(pairId).update({
      data: {
        privilegeCards: cards,
        updatedAt: now,
      },
    });
  });

  return cleanPrivilegeCard(revoked, openid);
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
      case 'permission.list':
        return ok(await listPermissions(OPENID));
      case 'permission.create':
        return ok(await createPermission(OPENID, event));
      case 'permission.update':
        return ok(await updatePermission(OPENID, event));
      case 'permission.toggle':
        return ok(await togglePermission(OPENID, event));
      case 'permission.delete':
        return ok(await deletePermission(OPENID, event));
      case 'privilege.list':
        return ok(await listPrivilegeCards(OPENID));
      case 'privilege.create':
        return ok(await createPrivilegeCard(OPENID, event));
      case 'privilege.use':
        return ok(await usePrivilegeCard(OPENID, event));
      case 'privilege.revoke':
        return ok(await revokePrivilegeCard(OPENID, event));
      default:
        throw new ApiError('UNKNOWN_ACTION', '未知操作');
    }
  } catch (e) {
    // 【日志分级】ApiError 是业务规则的【正常拒绝】（CANNOT_CANCEL /
    // NOT_BOUND / INVITE_NOT_FOUND 等），不是故障 —— 走 warn，不污染
    // error 日志、不触发误告警。只有未预期异常才打 error。
    if (e instanceof ApiError) {
      console.warn('[renianApi]', e.code, e.message);
      return fail(e.code, e.message);
    }
    console.error('[renianApi] UNEXPECTED', e);
    return fail('INTERNAL', '服务暂时不可用，请稍后再试');
  }
};
