const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const cloud = require('./mock-wx-server-sdk');
const { createV2Api } = require('../../cloudfunctions/renianApi/v2');
const { utcDay } = require('../../cloudfunctions/renianApi/v2-core');
const handle = createV2Api(cloud, { getUploadMetadata: async ({cloudPath}) => ({ data: { fileId: 'cloud://mock-env.bucket/' + cloudPath } }) });
let serial = 0;
const call = (action, who = 'A', data = {}) => handle(Object.assign({ action, requestId: 'request_' + (++serial) }, data), who);
const failure = (promise, code) => assert.rejects(promise, e => e.code === code && e.isBusiness === true);
async function pair(a = 'A', b = 'B') { const invite = await call('pair.create', a); return call('pair.join', b, { inviteCode: invite.inviteCode }); }
beforeEach(() => cloud.__reset());
test('unbound users cannot read shared records; pending invitation is reusable', async () => {
  await failure(call('entry.list'), 'NOT_BOUND');
  const a = await call('pair.create');
  assert.equal((await call('pair.create')).inviteCode, a.inviteCode);
  assert.equal((await call('session.get')).bindingStatus, 'waiting');
  await failure(call('entry.list'), 'PAIR_NOT_ACTIVE');
});
test('expired and invalid joins preserve own invitation, successful join replaces it atomically', async () => {
  const a = await call('pair.create','A'), b = await call('pair.create','B');
  await failure(call('pair.join','B',{inviteCode:'ABCDEFGH'}),'INVITE_NOT_FOUND');
  assert.equal((await call('session.get','B')).coupleId,b.coupleId);
  const record = cloud.__colStore('v2_couples').get(a.coupleId);
  record.inviteExpiresAt = new Date(0);
  await failure(call('pair.join','B',{inviteCode:a.inviteCode}),'INVITE_EXPIRED');
  assert.equal((await call('session.get','B')).coupleId,b.coupleId);
  const refreshed = await call('pair.refresh','A');
  assert.notEqual(refreshed.inviteCode,a.inviteCode);
  const joined = await call('pair.join','B',{inviteCode:refreshed.inviteCode});
  assert.equal(joined.coupleId,a.coupleId);
  assert.equal(cloud.__colStore('v2_couples').has(b.coupleId),false);
  assert.equal(cloud.__colStore('v2_invites').size,0);
});
test('only one contender joins an invitation, and active relation cannot cancel', async () => {
  const a = await call('pair.create');
  const results = await Promise.allSettled(['B','C'].map(who=>call('pair.join',who,{inviteCode:a.inviteCode})));
  assert.equal(results.filter(x=>x.status==='fulfilled').length,1);
  await failure(call('pair.cancel'),'CANNOT_CANCEL');
});
test('entries are immediately shared, multiple per day, author-only edits and UTC8 counts', async () => {
  await pair();
  const one = await call('entry.create','A',{text:'早安',ratingType:'good'});
  const ratingOnly = await call('entry.create','A',{ratingType:'neutral'});
  assert.equal(one.ratingType,'good'); assert.equal(one.ratingLabel,'很好');
  assert.equal(ratingOnly.ratingType,'neutral'); assert.equal(ratingOnly.ratingLabel,'还好');
  assert.equal((await call('entry.list','B')).items.length,2);
  assert.equal((await call('entry.get','B',{id:one.id})).fromMe,false);
  await failure(call('entry.update','B',{id:one.id,expectedVersion:1,text:'伪造'}),'FORBIDDEN');
  const edited = await call('entry.update','A',{id:one.id,expectedVersion:1,text:'晚安',ratingType:'bad'});
  assert.equal(edited.edited,true); assert.equal(edited.createdAt,one.createdAt); assert.equal(edited.dayKey,one.dayKey); assert.equal(edited.ratingLabel,'有点糟');
  await failure(call('entry.delete','A',{id:one.id,expectedVersion:1}),'VERSION_CONFLICT');
  await call('entry.create','B',{text:'我也在'});
  const stats = await call('entry.month','A',{month:one.dayKey.slice(0,7)});
  assert.equal(stats.totalEntries,3); assert.equal(stats.recordDays,1); assert.equal(stats.sharedDays,1);
  await call('entry.delete','A',{id:one.id,expectedVersion:2});
  assert.equal((await call('entry.list','B')).items.length,2);
  assert.equal(cloud.__colStore('v2_users').get('A').lastSharedDate,one.dayKey);
  assert.equal(utcDay(new Date('2026-09-25T16:00:00Z')),'2026-09-26');
});
test('parallel create retries are idempotent, changed retry payload is rejected', async () => {
  await pair();
  const input = {requestId:'stable_request',text:'唯一一条'};
  const result = await Promise.all([call('entry.create','A',input),call('entry.create','A',input)]);
  assert.equal(result[0].id,result[1].id);
  assert.equal((await call('entry.list')).items.length,1);
  await failure(call('entry.create','A',{...input,text:'不同'}),'REQUEST_CONFLICT');
});
test('outsiders cannot read records or reuse another couple cursor', async () => {
  await pair(); const one = await call('entry.create','A',{text:'私密'});
  await call('entry.create','A',{text:'私密2'});
  const list = await call('entry.list','A',{limit:1});
  await pair('C','D');
  await failure(call('entry.get','C',{id:one.id}),'NOT_FOUND');
  await failure(call('entry.list','C',{limit:1,cursor:list.nextCursor}),'INVALID_CURSOR');
});
test('keyset pagination visits same-time records once and rejects invalid months', async () => {
  const session = await pair();
  for (let n=0;n<55;n++) cloud.__colStore('v2_entries').set('entry_'+String(n).padStart(3,'0'),{
    coupleId:session.coupleId,authorOpenid:'A',text:'x',mood:'',images:[],version:1,deleted:false,
    createdAt:new Date('2026-09-26T01:00:00Z'),updatedAt:new Date(),monthKey:'2026-09',dayKey:'2026-09-26',
  });
  let cursor, ids=[];
  do { const page=await call('entry.list','A',{limit:20,cursor}); ids.push(...page.items.map(x=>x.id)); cursor=page.nextCursor; } while(cursor);
  assert.equal(ids.length,55); assert.equal(new Set(ids).size,55);
  assert.equal((await call('entry.month','A',{month:'2026-09'})).totalEntries,55);
  await failure(call('entry.month','A',{month:'2026-13'}),'INVALID_MONTH');
  await failure(call('entry.create','A',{}),'EMPTY_ENTRY');
  await failure(call('entry.create','A',{ratingType:'perfect'}),'INVALID_RATING');
});
test('agreement requires the other party; replacements preserve active original until acceptance', async () => {
  await pair();
  const p=await call('agreement.propose','A',{title:'散步',content:'周末'});
  await failure(call('agreement.respond','A',{id:p.id,expectedVersion:1,decision:'accept'}),'FORBIDDEN');
  const a=await call('agreement.respond','B',{id:p.id,expectedVersion:1,decision:'accept'});
  const replacement=await call('agreement.propose','B',{title:'散步2',content:'周日',replacesId:a.id,expectedVersion:2});
  assert.equal(cloud.__colStore('v2_agreements').get(a.id).status,'active');
  await call('agreement.respond','A',{id:replacement.id,expectedVersion:1,decision:'accept'});
  assert.equal(cloud.__colStore('v2_agreements').get(a.id).status,'superseded');
  await call('agreement.end','A',{id:replacement.id,expectedVersion:2});
  assert.equal(cloud.__colStore('v2_agreements').get(replacement.id).status,'ended');
});
test('ended originals invalidate pending replacement acceptance without losing the proposal', async () => {
  await pair();
  const p=await call('agreement.propose','A',{title:'散步',content:'周末'});
  await call('agreement.respond','B',{id:p.id,expectedVersion:1,decision:'accept'});
  const r=await call('agreement.propose','A',{title:'修改',content:'周日',replacesId:p.id,expectedVersion:2});
  await call('agreement.end','B',{id:p.id,expectedVersion:2});
  await failure(call('agreement.respond','B',{id:r.id,expectedVersion:1,decision:'accept'}),'STALE_REPLACEMENT');
  assert.equal(cloud.__colStore('v2_agreements').get(r.id).status,'pending');
});
test('coupons require recipient request and issuer approval; history survives reject and cancel', async () => {
  await pair();
  let coupon=await call('coupon.gift','A',{title:'晚餐',note:''});
  await failure(call('coupon.request','A',{id:coupon.id,expectedVersion:1}),'FORBIDDEN');
  coupon=await call('coupon.request','B',{id:coupon.id,expectedVersion:1});
  assert.equal((await call('profile.get','A')).pendingCouponCount,1);
  await failure(call('coupon.revoke','A',{id:coupon.id,expectedVersion:2}),'INVALID_COUPON_STATE');
  coupon=await call('coupon.respond','A',{id:coupon.id,expectedVersion:2,decision:'reject'});
  coupon=await call('coupon.request','B',{id:coupon.id,expectedVersion:coupon.version});
  coupon=await call('coupon.cancelRequest','B',{id:coupon.id,expectedVersion:coupon.version});
  coupon=await call('coupon.request','B',{id:coupon.id,expectedVersion:coupon.version});
  coupon=await call('coupon.respond','A',{id:coupon.id,expectedVersion:coupon.version,decision:'accept'});
  assert.equal(coupon.status,'used');
  await failure(call('coupon.request','B',{id:coupon.id,expectedVersion:coupon.version}),'INVALID_COUPON_STATE');
  const history=await call('coupon.history','A',{id:coupon.id});
  assert.deepEqual(history.items.map(x=>x.status).sort(),['cancelled','rejected','used']);
});
test('coupon double request and double approval commit once', async () => {
  await pair(); const coupon=await call('coupon.gift','A',{title:'拥抱'});
  const results=await Promise.allSettled([call('coupon.request','B',{id:coupon.id,expectedVersion:1}),call('coupon.request','B',{id:coupon.id,expectedVersion:1})]);
  assert.equal(results.filter(x=>x.status==='fulfilled').length,1);
  const payload={id:coupon.id,expectedVersion:2,decision:'accept',requestId:'repeat_approval'};
  const approvals=await Promise.all([call('coupon.respond','A',payload),call('coupon.respond','A',payload)]);
  assert.equal(approvals[0].status,'used'); assert.equal(approvals[1].status,'used');
  assert.equal(cloud.__colStore('v2_coupon_requests').size,1);
});
test('reminders default off and settings reject stale updates', async () => {
  await pair(); assert.equal((await call('reminder.get')).enabled,false);
  const on=await call('reminder.update','A',{enabled:true,time:'21:30',expectedVersion:0});
  assert.equal(on.version,1);
  await failure(call('reminder.update','A',{enabled:false,time:'21:30',expectedVersion:0}),'VERSION_CONFLICT');
});
test('media prepare registers abandoned file, validates owner and file signature, publishes private immutable copy', async () => {
  await pair();
  const m=await call('media.prepare','A',{name:'x',size:35});
  const fileID='cloud://mock-env.bucket/'+m.cloudPath;
  assert.equal(cloud.__colStore('v2_media').get(m.id).stagingFileID,fileID);
  await failure(call('media.confirm','B',{id:m.id,fileID}),'FORBIDDEN');
  await failure(call('media.confirm','A',{id:m.id,fileID:'cloud://foreign/'+m.cloudPath}),'INVALID_MEDIA_FILE');
  const png=Buffer.alloc(35); Buffer.from([137,80,78,71,13,10,26,10]).copy(png); png.writeUInt32BE(13,8); png.write('IHDR',12); png.writeUInt32BE(1,16); png.writeUInt32BE(1,20);
  cloud.__files.set(fileID,png);
  const ready=await call('media.confirm','A',{id:m.id,fileID});
  assert.match(ready.fileID,/v2-published/); assert.equal(cloud.__files.has(fileID),false);
  await failure(call('media.urls','B',{ids:[m.id]}),'FORBIDDEN');
  const entry=await call('entry.create','A',{images:[m.id]});
  assert.equal((await call('media.urls','B',{ids:[m.id]})).items.length,1);
  await failure(call('entry.create','A',{images:[m.id]}),'MEDIA_UNAVAILABLE');
  await call('entry.delete','A',{id:entry.id,expectedVersion:1});
  assert.equal(cloud.__colStore('v2_media').get(m.id).status,'cleanup_pending');
  await failure(call('media.urls','B',{ids:[m.id]}),'FORBIDDEN');
});
test('invalid image is never exposed',async()=>{
  await pair(); const m=await call('media.prepare','A',{name:'x',size:20});
  const fileID='cloud://mock-env.bucket/'+m.cloudPath; cloud.__files.set(fileID,Buffer.from('<script>not an image</script>'));
  await failure(call('media.confirm','A',{id:m.id,fileID}),'INVALID_MEDIA_TYPE');
  assert.equal(cloud.__colStore('v2_media').get(m.id).status,'cleanup_pending');
});
