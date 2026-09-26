function createMediaCleanup(cloud, clock = () => new Date()) {
  const db = cloud.database();
  const media = () => db.collection('v2_media');
  const atOrBefore = (value, now) => value && new Date(value).getTime() <= now.getTime();

  async function get(ref) {
    try { return (await ref.get()).data || null; }
    catch (error) {
      if (error.code === -1 || /document (not exists|does not exist)/i.test(error.message || error.errMsg || '')) return null;
      throw error;
    }
  }

  async function remove(fileID) {
    if (!fileID) return;
    const result = await cloud.deleteFile({ fileList: [fileID] });
    const item = result.fileList && result.fileList[0];
    if (!item || (item.status !== 0 && item.status !== -503003 && item.code !== 'SUCCESS' && item.code !== 'STORAGE_FILE_NONEXIST')) {
      throw new Error('FILE_DELETE_FAILED');
    }
  }

  async function cleanStaging(id) {
    const record = await get(media().doc(id));
    if (!record || !record.stagingCleanupPending || !record.stagingFileID) return;
    if (!['ready', 'attached', 'deleted'].includes(record.status)) return;
    // Only cleanup a staging path recorded for this asset, never its published file.
    if (record.stagingFileID === record.fileID || !record.stagingFileID.includes('/v2-upload/')) {
      throw new Error('INVALID_STAGING_FILE');
    }
    await remove(record.stagingFileID);
    await db.runTransaction(async (tx) => {
      const ref = tx.collection('v2_media').doc(id);
      const latest = await get(ref);
      if (latest && latest.stagingFileID === record.stagingFileID) {
        await ref.update({ data: { stagingCleanupPending: false } });
      }
    });
  }

  async function cleanup(id) {
    let claimed = null;
    await db.runTransaction(async (tx) => {
      claimed = null;
      const ref = tx.collection('v2_media').doc(id);
      const record = await get(ref);
      if (!record || record.status === 'attached' || record.status === 'deleted') return;
      const now = clock();
      const expired = (['prepared', 'ready'].includes(record.status) && atOrBefore(record.expiresAt, now)) ||
        (record.status === 'confirming' && atOrBefore(record.confirmLeaseUntil, now));
      const pending = record.status === 'cleanup_pending' && (!record.cleanupAfter || atOrBefore(record.cleanupAfter, now));
      if (!expired && !pending && record.status !== 'cleanup_claimed') return;
      await ref.update({ data: { status: 'cleanup_claimed', updatedAt: now } });
      claimed = record;
    });
    if (!claimed) return false;
    // A failure leaves cleanup_claimed in the DB for the next scheduled run.
    for (const fileID of [...new Set([claimed.fileID, claimed.stagingFileID].filter(Boolean))]) {
      if (!/^cloud:\/\/[^/]+\/v2-(upload|published)\//.test(fileID)) throw new Error('INVALID_MEDIA_FILE');
      await remove(fileID);
    }
    await db.runTransaction(async (tx) => {
      const ref = tx.collection('v2_media').doc(id);
      const latest = await get(ref);
      if (latest && latest.status === 'cleanup_claimed') {
        await ref.update({ data: { status: 'deleted', stagingCleanupPending: false, deletedAt: clock(), updatedAt: clock() } });
      }
    });
    return true;
  }

  async function run() {
    const now = clock();
    const conditions = [
      { status: 'prepared', expiresAt: db.command.lte(now) },
      { status: 'ready', expiresAt: db.command.lte(now) },
      { status: 'confirming', confirmLeaseUntil: db.command.lte(now) },
      { status: 'cleanup_pending' },
      { status: 'cleanup_claimed' },
      { stagingCleanupPending: true },
    ];
    let removed = 0, failed = 0;
    // Bounded batches keep the job restartable even when storage is unavailable.
    for (const condition of conditions) {
      const rows = (await media().where(condition).orderBy('_id', 'asc').limit(100).get()).data || [];
      for (const row of rows) {
        try {
          if (condition.stagingCleanupPending) await cleanStaging(row._id);
          else if (await cleanup(row._id)) removed++;
        } catch (error) {
          failed++;
          console.error('[mediaCleanup]', error.code || error.message || 'UNKNOWN');
        }
      }
    }
    return { ok: true, removed, failed };
  }
  return { run };
}

module.exports = { createMediaCleanup };
