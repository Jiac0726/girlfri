const test = require('node:test');
const assert = require('node:assert/strict');
const cloud = require('./mock-wx-server-sdk');
const { createV2Api } = require('../../cloudfunctions/renianApi/v2');

const handle = createV2Api(cloud, {
  getUploadMetadata: async ({ cloudPath }) => ({ data: { fileId: 'cloud://mock-env.bucket/' + cloudPath } }),
});

let serial = 0;
const call = (action, who = 'A', data = {}) =>
  handle(Object.assign({ action, requestId: 'legacy_visibility_' + (++serial) }, data), who);

async function pair() {
  const invite = await call('pair.create', 'A');
  return call('pair.join', 'B', { inviteCode: invite.inviteCode });
}

test('partner cannot read a one-sided inherited rating but author still can', async () => {
  cloud.__reset();
  const session = await pair();
  const doc = {
    coupleId: session.coupleId,
    authorOpenid: 'A',
    text: '旧版只由 A 写下的感受',
    mood: '',
    images: [],
    version: 1,
    edited: false,
    deleted: false,
    createdAt: new Date('2026-09-20T12:00:00Z'),
    updatedAt: new Date('2026-09-20T12:00:00Z'),
    dayKey: '2026-09-20',
    monthKey: '2026-09',
    legacyRatingType: 'bad',
    legacyRatingLabel: '有点糟',
    legacyPrivate: true,
  };
  cloud.__colStore('v2_entries').set('legacy_private', doc);

  const mine = await call('entry.list', 'A', { month: '2026-09' });
  assert.equal(mine.items.length, 1);
  assert.equal(mine.items[0].legacyPrivate, true);
  assert.equal(mine.items[0].legacyRatingLabel, '有点糟');
  assert.equal(mine.items[0].ratingType, 'bad');
  assert.equal(mine.items[0].ratingLabel, '有点糟');

  const partner = await call('entry.list', 'B', { month: '2026-09' });
  assert.equal(partner.items.length, 0);

  await assert.rejects(
    call('entry.get', 'B', { id: 'legacy_private' }),
    error => error.code === 'NOT_FOUND'
  );

  const statsA = await call('entry.month', 'A', { month: '2026-09' });
  const statsB = await call('entry.month', 'B', { month: '2026-09' });
  assert.equal(statsA.totalEntries, 1);
  assert.equal(statsB.totalEntries, 0);
});
