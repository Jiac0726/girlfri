const crypto = require('crypto');

const TEMPLATE_ID = 'tb0gjEGNaTQfOvLVKNdWKekwa3fSTdyCQkkTSpuNjtk';
const ALLOWED_TIMES = ['20:00', '20:30', '21:00', '21:30', '22:00', '22:30'];

function parts(now) {
  const iso = new Date(now.getTime() + 8 * 3600000).toISOString();
  return { date: iso.slice(0, 10), time: iso.slice(11, 16) };
}

function due(time, now) {
  if (!ALLOWED_TIMES.includes(time)) return false;
  const minutes = (value) => Number(value.slice(0, 2)) * 60 + Number(value.slice(3));
  const delay = minutes(now) - minutes(time);
  return delay >= 0 && delay < 15;
}

function createReminderWorker(cloud, clock = () => new Date()) {
  const db = cloud.database();
  const users = () => db.collection('v2_users');
  const pairs = () => db.collection('v2_couples');

  async function get(ref) {
    try { return (await ref.get()).data || null; }
    catch (error) {
      if (error.code === -1 || /document (not exists|does not exist)/i.test(error.message || error.errMsg || '')) return null;
      throw error;
    }
  }

  async function release(openid, token, update, expectedVersion) {
    await db.runTransaction(async (tx) => {
      const ref = tx.collection('v2_users').doc(openid);
      const user = await get(ref);
      if (!user || user.reminderClaimToken !== token) return;
      const data = { reminderProcessingDate: '', reminderProcessingAt: null, reminderClaimToken: '', updatedAt: clock() };
      // A fresh explicit subscription must not be disabled by an older send completion.
      if ((user.reminderVersion || 0) === expectedVersion) Object.assign(data, update);
      else if (update.reminderLastSentDate) {
        data.reminderLastSentDate = update.reminderLastSentDate;
        data.reminderLastSentAt = update.reminderLastSentAt;
      }
      await ref.update({ data });
    });
  }

  async function processUser(snapshot, at) {
    const token = crypto.randomBytes(16).toString('hex');
    const openid = snapshot._id;
    let claimed = null;
    await db.runTransaction(async (tx) => {
      claimed = null;
      const ref = tx.collection('v2_users').doc(openid);
      const user = await get(ref);
      if (!user || user.status !== 'active' || !user.reminderEnabled ||
          !due(user.reminderTime || '21:30', at.time) || user.lastSharedDate === at.date ||
          user.reminderLastSentDate === at.date || user.reminderProcessingDate === at.date) return;
      const pair = await get(tx.collection('v2_couples').doc(user.coupleId));
      if (!pair || pair.status !== 'active' || !(pair.memberOpenids || []).includes(openid)) return;
      await ref.update({ data: {
        reminderProcessingDate: at.date, reminderProcessingAt: clock(), reminderClaimToken: token,
      } });
      claimed = user;
    });
    if (!claimed) return { skipped: true };

    const version = claimed.reminderVersion || 0;
    // Recheck immediately before the external call. Sending cannot be part of a DB transaction.
    const latest = await get(users().doc(openid));
    const pair = await get(pairs().doc(claimed.coupleId));
    if (!latest || !latest.reminderEnabled || latest.reminderClaimToken !== token ||
        (latest.reminderVersion || 0) !== version || latest.lastSharedDate === at.date ||
        latest.coupleId !== claimed.coupleId || !pair || pair.status !== 'active' ||
        !(pair.memberOpenids || []).includes(openid)) {
      await release(openid, token, {}, version);
      return { skipped: true };
    }

    try {
      await cloud.openapi.subscribeMessage.send({
        touser: openid, page: 'pages/index/index', templateId: TEMPLATE_ID,
        data: {
          thing1: { value: '今天还没分享，留下一点小日常吧' },
          time2: { value: claimed.reminderTime || '21:30' },
        },
      });
    } catch (error) {
      // Do not blindly retry a possibly delivered external message or a consumed subscription.
      await release(openid, token, {
        reminderEnabled: false, reminderNeedsRenewal: true,
        reminderLastError: 'SEND_FAILED', reminderLastFailedAt: clock(),
      }, version);
      console.error('[dailyReminder] subscription send failed', error.code || error.errCode || 'UNKNOWN');
      return { sent: false };
    }
    await release(openid, token, {
      reminderEnabled: false, reminderNeedsRenewal: true,
      reminderLastSentDate: at.date, reminderLastSentAt: clock(), reminderLastError: '',
    }, version);
    return { sent: true };
  }

  async function run() {
    const at = parts(clock());
    let cursor = '', scanned = 0, sent = 0, failed = 0;
    for (;;) {
      const criteria = { reminderEnabled: true };
      if (cursor) criteria._id = db.command.gt(cursor);
      const rows = (await users().where(criteria).orderBy('_id', 'asc').limit(100).get()).data || [];
      for (const user of rows) {
        scanned++;
        try {
          const result = await processUser(user, at);
          if (result.sent) sent++;
          else if (result.sent === false) failed++;
        } catch (error) {
          failed++;
          console.error('[dailyReminder] processing failed', error.code || 'UNKNOWN');
        }
      }
      if (rows.length < 100) break;
      cursor = rows[rows.length - 1]._id;
    }
    return { ok: true, date: at.date, scanned, sent, failed };
  }
  return { run };
}

module.exports = { createReminderWorker };
