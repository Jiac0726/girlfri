const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const cloud = require('./mock-wx-server-sdk');
const { createReminderWorker } = require('../../cloudfunctions/dailyReminder/worker');
const { createMediaCleanup } = require('../../cloudfunctions/mediaCleanup/worker');
const now = new Date('2026-09-26T13:30:00Z'), clock = () => now;
const originals = { send: cloud.openapi.subscribeMessage.send, deleteFile: cloud.deleteFile };
beforeEach(() => cloud.__reset());
afterEach(() => { cloud.openapi.subscribeMessage.send = originals.send; cloud.deleteFile = originals.deleteFile; });
function user(id, extra = {}) {
  cloud.__colStore('v2_couples').set('pair', { status:'active',memberOpenids:['A','B'] });
  cloud.__colStore('v2_users').set(id,Object.assign({ status:'active',coupleId:'pair',reminderEnabled:true,reminderVersion:1,reminderTime:'21:30' },extra));
}
test('reminder sends once to opted-in unshared user, skips shared and disabled',async()=>{
  user('A'); user('B',{lastSharedDate:'2026-09-26'}); user('C',{reminderEnabled:false});
  const sent=[]; cloud.openapi.subscribeMessage.send=async x=>sent.push(x);
  const worker=createReminderWorker(cloud,clock);
  const first=await worker.run(); await worker.run();
  assert.equal(first.sent,1); assert.deepEqual(sent.map(x=>x.touser),['A']);
  assert.equal(cloud.__colStore('v2_users').get('A').reminderNeedsRenewal,true);
  assert.equal(cloud.__colStore('v2_users').get('B').reminderEnabled,true);
});
test('reminder rechecks shared state after claiming',async()=>{
  user('A'); let sends=0;
  cloud.openapi.subscribeMessage.send=async()=>sends++;
  cloud.__hooks.beforeUpdate=async(col,id,data)=>{
    if(col==='v2_users' && data.reminderClaimToken) cloud.__colStore(col).get(id).lastSharedDate='2026-09-26';
  };
  await createReminderWorker(cloud,clock).run();
  assert.equal(sends,0); assert.equal(cloud.__colStore('v2_users').get('A').reminderEnabled,true);
});
test('overlapping reminder runs do not send twice',async()=>{
  user('A'); let sends=0;
  cloud.openapi.subscribeMessage.send=async()=>{ sends++; await new Promise(r=>setImmediate(r)); };
  const worker=createReminderWorker(cloud,clock);
  await Promise.all([worker.run(),worker.run()]); assert.equal(sends,1);
});
test('new subscription survives completion of an older send',async()=>{
  user('A');
  cloud.openapi.subscribeMessage.send=async()=>{
    const u=cloud.__colStore('v2_users').get('A'); u.reminderVersion=2; u.reminderEnabled=true;
  };
  await createReminderWorker(cloud,clock).run();
  const u=cloud.__colStore('v2_users').get('A'); assert.equal(u.reminderEnabled,true); assert.equal(u.reminderLastSentDate,'2026-09-26');
});
test('failed send needs new consent; no automatic retry',async()=>{
  user('A'); let sends=0;
  cloud.openapi.subscribeMessage.send=async()=>{ sends++; throw new Error('ambiguous network error'); };
  const worker=createReminderWorker(cloud,clock); await worker.run(); await worker.run();
  assert.equal(sends,1); assert.equal(cloud.__colStore('v2_users').get('A').reminderEnabled,false);
});
test('reminder respects scheduled window',async()=>{
  user('A'); let sends=0; cloud.openapi.subscribeMessage.send=async()=>sends++;
  await createReminderWorker(cloud,()=>new Date('2026-09-26T13:29:00Z')).run();
  await createReminderWorker(cloud,()=>new Date('2026-09-26T13:46:00Z')).run();
  assert.equal(sends,0);
});
function media(id,status,extra={}) {
  const stagingFileID='cloud://mock-env.bucket/v2-upload/A/'+id;
  const fileID='cloud://mock-env.bucket/v2-published/'+id+'.png';
  cloud.__files.set(stagingFileID,Buffer.from('stage')); cloud.__files.set(fileID,Buffer.from('published'));
  cloud.__colStore('v2_media').set(id,Object.assign({status,stagingFileID,fileID,expiresAt:new Date(0),cleanupAfter:new Date(0),stagingCleanupPending:true},extra));
  return {stagingFileID,fileID};
}
test('cleanup deletes abandoned and detached files but protects attached published media',async()=>{
  const abandoned=media('abandoned','prepared'), attached=media('attached','attached'), removed=media('removed','cleanup_pending');
  const result=await createMediaCleanup(cloud,clock).run();
  assert.equal(result.removed,2); assert.equal(cloud.__files.has(attached.fileID),true);
  assert.equal(cloud.__files.has(attached.stagingFileID),false);
  assert.equal(cloud.__files.has(abandoned.stagingFileID),false); assert.equal(cloud.__files.has(removed.fileID),false);
});
test('active confirm lease keeps staging file intact; expired lease is cleaned',async()=>{
  const active=media('active','confirming',{confirmLeaseUntil:new Date(now.getTime()+60000)});
  const expired=media('expired','confirming',{confirmLeaseUntil:new Date(0)});
  await createMediaCleanup(cloud,clock).run();
  assert.equal(cloud.__files.has(active.stagingFileID),true);
  assert.equal(cloud.__files.has(expired.fileID),false);
});
test('storage cleanup failure remains retryable',async()=>{
  const record=media('retry','cleanup_pending');
  cloud.deleteFile=async()=>({fileList:[{status:-1}]});
  await createMediaCleanup(cloud,clock).run();
  assert.equal(cloud.__colStore('v2_media').get('retry').status,'cleanup_claimed');
  cloud.deleteFile=originals.deleteFile; await createMediaCleanup(cloud,clock).run();
  assert.equal(cloud.__colStore('v2_media').get('retry').status,'deleted');
  assert.equal(cloud.__files.has(record.fileID),false);
});
