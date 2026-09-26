const test = require('node:test');
const assert = require('node:assert/strict');
const { transformLegacy } = require('../../cloudfunctions/legacyV2Migration/migration');

function sample() {
  const pairId = 'pair_old';
  const created = new Date('2026-09-01T00:00:00Z');
  return {
    couples: [{
      _id: pairId,
      status: 'active',
      creatorOpenid: 'A',
      partnerOpenid: 'B',
      memberOpenids: ['A', 'B'],
      inviteCode: 'USED_pair_old',
      createdAt: created,
      updatedAt: new Date('2026-09-02T00:00:00Z'),
      permissions: [{
        id: 'perm1', name: '每周散步', note: '一起出去走走', enabled: true,
        grantedBy: 'A', grantedTo: 'B', createdAt: created, updatedAt: created,
      }],
      privilegeCards: [{
        id: 'card1', name: '晚餐券', note: '一起吃饭', status: 'used',
        issuedBy: 'A', issuedTo: 'B', createdAt: created,
        usedAt: new Date('2026-09-20T12:00:00Z'),
      }],
    }],
    users: [
      { _id: 'A', coupleId: pairId, status: 'active', moodEmoji: '🥰', moodText: '开心', reminderEnabled: true, reminderTime: '21:30', createdAt: created },
      { _id: 'B', coupleId: pairId, status: 'active', createdAt: created },
    ],
    ratings: [
      { _id: 'r1', coupleId: pairId, date: '2026-09-25', type: 'good', reason: '一起散步', ratedBy: 'A', targetOpenid: 'B', updatedAt: new Date('2026-09-25T13:30:00Z') },
      { _id: 'r2', coupleId: pairId, date: '2026-09-25', type: 'neutral', reason: '', ratedBy: 'B', targetOpenid: 'A', updatedAt: new Date('2026-09-25T14:00:00Z') },
    ],
  };
}

test('legacy active relationship is inherited without rebinding', () => {
  const result = transformLegacy(sample(), new Date('2026-09-26T00:00:00Z'));
  assert.equal(result.ok, true);
  assert.equal(result.documents.v2_couples[0]._id, 'pair_old');
  assert.deepEqual(result.documents.v2_couples[0].memberOpenids, ['A', 'B']);
  assert.equal(result.documents.v2_users.find(x => x._id === 'A').coupleId, 'pair_old');
  assert.equal(result.documents.v2_users.find(x => x._id === 'B').status, 'active');
});

test('legacy ratings become visible v2 entries and keep rating meaning', () => {
  const result = transformLegacy(sample(), new Date('2026-09-26T00:00:00Z'));
  assert.equal(result.documents.v2_entries.length, 2);
  const good = result.documents.v2_entries.find(x => x.authorOpenid === 'A');
  assert.equal(good.text, '一起散步');
  assert.equal(good.legacyRatingType, 'good');
  assert.equal(good.legacyRatingLabel, '很好');
  assert.equal(good.legacyPrivate, false);
  assert.equal(good.dayKey, '2026-09-25');
  assert.equal(result.documents.v2_users.find(x => x._id === 'A').lastSharedDate, '2026-09-25');
});

test('legacy mood, reminder, agreement and coupon data are preserved', () => {
  const result = transformLegacy(sample(), new Date('2026-09-26T00:00:00Z'));
  const a = result.documents.v2_users.find(x => x._id === 'A');
  assert.equal(a.moodEmoji, '🥰');
  assert.equal(a.reminderEnabled, true);
  assert.equal(a.reminderTime, '21:30');
  assert.equal(result.documents.v2_agreements[0].status, 'active');
  assert.equal(result.documents.v2_coupons[0].status, 'used');
  assert.equal(result.documents.v2_coupon_requests[0].status, 'used');
});

test('waiting relationship and invitation are preserved', () => {
  const input = {
    couples: [{ _id: 'pair_wait', status: 'waiting', creatorOpenid: 'A', partnerOpenid: '', memberOpenids: ['A'], inviteCode: 'ABCDEFGH', inviteExpiresAt: new Date('2099-01-01T00:00:00Z') }],
    users: [{ _id: 'A', coupleId: 'pair_wait', status: 'waiting' }],
    ratings: [],
  };
  const result = transformLegacy(input);
  assert.equal(result.ok, true);
  assert.equal(result.documents.v2_invites[0]._id, 'ABCDEFGH');
  assert.equal(result.documents.v2_couples[0].status, 'waiting');
});

test('migration blocks rather than silently losing orphan ratings', () => {
  const input = sample();
  input.ratings.push({ _id: 'broken', coupleId: 'missing', date: '2026-09-25', type: 'bad', ratedBy: 'A' });
  const result = transformLegacy(input);
  assert.equal(result.ok, false);
  assert.ok(result.blockers.some(x => x.code === 'RATING_INVALID'));
});

test('one-sided legacy rating stays private to its author', () => {
  const input = sample();
  input.ratings = [input.ratings[0]];
  const result = transformLegacy(input, new Date('2026-09-26T00:00:00Z'));
  assert.equal(result.ok, true);
  assert.equal(result.documents.v2_entries.length, 1);
  assert.equal(result.documents.v2_entries[0].legacyPrivate, true);
});
