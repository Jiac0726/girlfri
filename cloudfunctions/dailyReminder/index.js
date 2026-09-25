const cloud = require('wx-server-sdk');
const crypto = require('crypto');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();
const COLLECTIONS = {
  couples: 'couples',
  users: 'couple_users',
  ratings: 'ratings',
};

const TEMPLATE_ID = 'tb0gjEGNaTQfOvLVKNdWKekwa3fSTdyCQkkTSpuNjtk';
const PAGE = 'pages/index/index';

// 当前模板关键词：提醒内容、截止时间。
// 这类模板通常对应 thing1 + time2；如果公众平台“详情”页显示的是其他字段键，
// 只需要改下面两个常量，不需要改其余逻辑。
const CONTENT_KEY = 'thing1';
const DEADLINE_KEY = 'time2';

function memberKey(openid) {
  return crypto.createHash('sha256').update(openid).digest('hex').slice(0, 16);
}

function ratingId(coupleId, date, authorOpenid) {
  return coupleId + '_' + date + '_' + memberKey(authorOpenid);
}

function utc8Parts(now = new Date()) {
  const shifted = new Date(now.getTime() + 8 * 60 * 60 * 1000);
  const iso = shifted.toISOString();
  return {
    date: iso.slice(0, 10),
    time: iso.slice(11, 16),
  };
}

function isDocMissing(e) {
  const code = e && (e.errCode !== undefined ? e.errCode : e.code);
  const msg = String((e && (e.errMsg || e.message)) || '');
  return (
    code === -1 ||
    /document\s*(not\s*)?(exists|exist)/i.test(msg) ||
    /not\s*found/i.test(msg)
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

async function listEnabledUsers() {
  const all = [];
  let skip = 0;
  const limit = 100;

  for (;;) {
    const res = await db
      .collection(COLLECTIONS.users)
      .where({ reminderEnabled: true })
      .skip(skip)
      .limit(limit)
      .get();

    const rows = res.data || [];
    all.push(...rows);
    if (rows.length < limit) break;
    skip += limit;
  }

  return all;
}

async function claimReminder(user, today, now) {
  const openid = user && user._id;
  if (!openid) return false;

  let claimed = false;
  await db.runTransaction(async (transaction) => {
    const ref = transaction.collection(COLLECTIONS.users).doc(openid);
    const res = await ref.get();
    const latest = res && res.data;
    if (!latest) return;

    if (
      latest.status !== 'active' ||
      latest.reminderEnabled !== true ||
      latest.reminderLastSentDate === today ||
      latest.reminderProcessingDate === today
    ) {
      return;
    }

    await ref.update({
      data: {
        reminderProcessingDate: today,
        reminderProcessingAt: now,
        updatedAt: now,
      },
    });
    claimed = true;
  });

  return claimed;
}

async function releaseClaim(openid, data) {
  const now = new Date();
  await db.collection(COLLECTIONS.users).doc(openid).update({
    data: Object.assign(
      {
        reminderProcessingDate: '',
        reminderProcessingAt: null,
        updatedAt: now,
      },
      data || {}
    ),
  });
}

async function processUser(user, clock) {
  const openid = user && user._id;
  const coupleId = String((user && user.coupleId) || '');
  const reminderTime = String((user && user.reminderTime) || '21:30');

  if (!openid || !coupleId || reminderTime !== clock.time) {
    return { skipped: true, reason: 'not_due' };
  }

  const pair = await safeGet(db.collection(COLLECTIONS.couples).doc(coupleId));
  if (
    !pair ||
    pair.status !== 'active' ||
    !Array.isArray(pair.memberOpenids) ||
    !pair.memberOpenids.includes(openid)
  ) {
    await releaseClaim(openid, {
      reminderEnabled: false,
      reminderNeedsRenewal: false,
      reminderLastError: 'PAIR_NOT_ACTIVE',
    });
    return { skipped: true, reason: 'pair_inactive' };
  }

  const rating = await safeGet(
    db.collection(COLLECTIONS.ratings).doc(ratingId(coupleId, clock.date, openid))
  );

  // 当天已经评价，不发送，也不消耗本次订阅资格。
  if (rating) {
    return { skipped: true, reason: 'already_rated' };
  }

  const now = new Date();
  const claimed = await claimReminder(user, clock.date, now);
  if (!claimed) return { skipped: true, reason: 'already_claimed' };

  try {
    await cloud.openapi.subscribeMessage.send({
      touser: openid,
      page: PAGE,
      templateId: TEMPLATE_ID,
      data: {
        [CONTENT_KEY]: {
          value: '今天还没评价，来记录一下吧',
        },
        [DEADLINE_KEY]: {
          value: reminderTime,
        },
      },
    });

    // 一次性订阅消息发送成功后，本次资格已消耗。
    // 关闭开关，要求用户下次再次主动授权，避免后台无效重试。
    await releaseClaim(openid, {
      reminderEnabled: false,
      reminderNeedsRenewal: true,
      reminderLastSentDate: clock.date,
      reminderLastSentAt: new Date(),
      reminderLastError: '',
    });

    return { sent: true };
  } catch (e) {
    const message = String((e && (e.errMsg || e.message)) || e || 'send failed');

    // 授权失效、模板字段不匹配等错误都停止继续重试；
    // 用户重新开启时会再次走 wx.requestSubscribeMessage。
    await releaseClaim(openid, {
      reminderEnabled: false,
      reminderNeedsRenewal: true,
      reminderLastError: message.slice(0, 300),
      reminderLastFailedAt: new Date(),
    });

    console.error('[dailyReminder] send failed', openid, message);
    return { sent: false, error: message };
  }
}

exports.main = async () => {
  const clock = utc8Parts();
  const users = await listEnabledUsers();
  const due = users.filter(
    (user) =>
      user.status === 'active' &&
      String(user.reminderTime || '21:30') === clock.time
  );

  const results = [];
  for (const user of due) {
    try {
      results.push(await processUser(user, clock));
    } catch (e) {
      console.error('[dailyReminder] unexpected user failure', user && user._id, e);
      results.push({ sent: false, error: String((e && e.message) || e) });
    }
  }

  return {
    ok: true,
    date: clock.date,
    time: clock.time,
    enabledUsers: users.length,
    dueUsers: due.length,
    sent: results.filter((item) => item && item.sent).length,
    results,
  };
};
