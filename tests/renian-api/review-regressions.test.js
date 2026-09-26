const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), vm = require('node:vm');
const cloud = require('./mock-wx-server-sdk');
const { createV2Api } = require('../../cloudfunctions/renianApi/v2');
const { createMediaCleanup } = require('../../cloudfunctions/mediaCleanup/worker');
const { transformLegacy } = require('../../cloudfunctions/legacyV2Migration/migration');
const handle = createV2Api(cloud, { database: cloud.__nodeDatabase(), getUploadMetadata: async ({cloudPath}) => ({data:{fileId:'cloud://mock-env.bucket/'+cloudPath}}) });
let serial=0;
const call=(action,who='A',data={})=>handle({action,requestId:'regression_'+(++serial),...data},who);
const originalSign=cloud.getTempFileURL;
beforeEach(()=>cloud.__reset());
afterEach(()=>{cloud.getTempFileURL=originalSign;cloud.__setOpenid('A');});
async function pair() { const invite=await call('pair.create'); return call('pair.join','B',{inviteCode:invite.inviteCode}); }
function entry(coupleId,id,images=[],legacyPrivate=false) {
  const now=new Date();
  cloud.__colStore('v2_entries').set(id,{coupleId,authorOpenid:'A',text:id,mood:'',images,version:1,createdAt:now,updatedAt:now,dayKey:'2026-09-27',deleted:false,legacyPrivate});
}
function photo(coupleId,id,entryId) {
  cloud.__colStore('v2_media').set(id,{coupleId,ownerOpenid:'A',entryId,attachmentType:'entry',status:'attached',fileID:'cloud://mock-env.bucket/v2-published/'+id+'.png'});
}
test('private inherited entry and its newly attached photos share the same access rule',async()=>{
  const p=await pair();entry(p.coupleId,'private',['secret'],true);photo(p.coupleId,'secret','private');
  await assert.rejects(call('entry.get','B',{id:'private'}),e=>e.code==='NOT_FOUND');
  await assert.rejects(call('media.urls','B',{ids:['secret']}),e=>e.code==='NOT_FOUND');
  assert.ok((await call('media.urls','A',{ids:['secret']})).items[0].url);
  entry(p.coupleId,'shared',['public']);photo(p.coupleId,'public','shared');
  assert.ok((await call('media.urls','B',{ids:['public']})).items[0].url);
});
test('upload interrupted before confirm remains discoverable and is physically cleaned',async()=>{
  await pair();const prepared=await call('media.prepare','A',{name:'photo',size:35});
  const uploaded=await cloud.uploadFile({cloudPath:prepared.cloudPath,fileContent:Buffer.alloc(35)});
  assert.equal(cloud.__colStore('v2_media').get(prepared.id).stagingFileID,uploaded.fileID);
  await createMediaCleanup(cloud,()=>new Date(Date.now()+25*3600000)).run();
  assert.equal(cloud.__colStore('v2_media').get(prepared.id).status,'deleted');
  assert.equal(cloud.__files.has(uploaded.fileID),false);
});
test('individual missing image and signing failure preserve text and other photos',async()=>{
  const p=await pair();entry(p.coupleId,'mixed',['missing','bad','good']);photo(p.coupleId,'bad','mixed');photo(p.coupleId,'good','mixed');
  entry(p.coupleId,'text');
  cloud.getTempFileURL=async({fileList})=>({fileList:fileList.map(fileID=>fileID.includes('/bad.')?{fileID,status:-1}:{fileID,status:0,tempFileURL:'https://signed.invalid/good'})});
  const list=await call('entry.list','B');assert.equal(list.items.length,2);
  const mixed=list.items.find(x=>x.id==='mixed');
  assert.deepEqual(mixed.images.map(x=>!!x.url),[false,false,true]);
  const detail=await call('entry.get','B',{id:'mixed'});assert.equal(detail.text,'mixed');
  await assert.rejects(call('media.urls','B',{ids:['bad']}),e=>e.code==='MEDIA_URL_FAILED');
  cloud.getTempFileURL=async()=>{throw new Error('temporary storage outage');};
  assert.equal((await call('entry.list','B')).items.length,2);
});
test('degraded feed never signs a foreign media reference',async()=>{
  const p=await pair();entry(p.coupleId,'mixed',['foreign']);
  photo('another_pair','foreign','mixed');let signed=0;
  cloud.getTempFileURL=async()=>{signed++;throw new Error('must not sign');};
  const result=await call('entry.get','A',{id:'mixed'});assert.equal(result.images[0].url,'');assert.equal(signed,0);
});
function migrationMain() {
  const exports={};
  vm.runInNewContext(fs.readFileSync(require.resolve('../../cloudfunctions/legacyV2Migration/index.js'),'utf8'),{
    exports,console:{error(){}},
    require:name=>name==='wx-server-sdk'?cloud:name==='crypto'?require('node:crypto'):{transformLegacy},
  });
  cloud.__setOpenid('');return exports.main;
}
function seedLegacy() {
  const now=new Date('2026-09-27T00:00:00Z');
  cloud.__colStore('couples').set('pair',{status:'active',creatorOpenid:'A',partnerOpenid:'B',memberOpenids:['A','B'],createdAt:now,updatedAt:now});
  for(const id of ['A','B'])cloud.__colStore('couple_users').set(id,{coupleId:'pair',status:'active',createdAt:now,updatedAt:now});
  cloud.__colStore('ratings').set('r_b',{coupleId:'pair',ratedBy:'A',date:'2026-09-26',type:'good',reason:'old',updatedAt:now});
}
const apply={mode:'apply',confirm:'MIGRATE_V2_FROM_LEGACY'};
async function interruptAfterEntries(main) {
  let failed=false;
  cloud.__hooks.beforeSet=async(col,id,data)=>{
    if(col==='v2_operations' && data.status==='completed' && !failed){failed=true;throw new Error('interrupted before completion');}
  };
  const result=await main(apply);assert.equal(result.ok,false);
  delete cloud.__hooks.beforeSet;
  assert.equal(cloud.__colStore('v2_operations').get('legacy_v1_to_v2').status,'running');
}
test('migration resumes unchanged source and verifies target documents before completion',async()=>{
  seedLegacy();const main=migrationMain();await interruptAfterEntries(main);
  const result=await main(apply);assert.equal(result.ok,true);assert.equal(cloud.__colStore('v2_entries').size,1);
  assert.equal((await main(apply)).alreadyCompleted,true);
});
test('migration rejects changed source instead of skipping inserted earlier record',async()=>{
  seedLegacy();const main=migrationMain();await interruptAfterEntries(main);
  cloud.__colStore('ratings').set('r_a',{...cloud.__colStore('ratings').get('r_b'),ratedBy:'B'});
  const result=await main(apply);assert.equal(result.ok,false);assert.match(result.error.message,/SOURCE_CHANGED/);
  assert.equal(cloud.__colStore('v2_operations').get('legacy_v1_to_v2').status,'running');
});
test('migration cannot mark complete if a previously written target is missing',async()=>{
  seedLegacy();const main=migrationMain();await interruptAfterEntries(main);
  cloud.__colStore('v2_entries').clear();
  const result=await main(apply);assert.equal(result.ok,false);assert.match(result.error.message,/TARGET_MISMATCH/);
});
test('legacy running marker without source fingerprint requires explicit reconciliation',async()=>{
  seedLegacy();const main=migrationMain();
  cloud.__colStore('v2_operations').set('legacy_v1_to_v2',{status:'running',progress:{v2_entries:1}});
  const result=await main(apply);assert.equal(result.ok,false);assert.match(result.error.message,/SOURCE_CHANGED/);
});


test('cleanup recovers previously unregistered files, including incorrectly deleted old rows',async()=>{
  const p=await pair();
  for(const status of ['prepared','deleted']) {
    const cloudPath='v2-upload/A/old_'+status;
    const uploaded=await cloud.uploadFile({cloudPath,fileContent:Buffer.alloc(10)});
    cloud.__colStore('v2_media').set('old_'+status,{coupleId:p.coupleId,ownerOpenid:'A',cloudPath,status,stagingFileID:'',fileID:'',expiresAt:new Date(0)});
    assert.ok(cloud.__files.has(uploaded.fileID));
  }
  await createMediaCleanup(cloud,undefined,{getUploadMetadata:async({cloudPath})=>({data:{fileId:'cloud://mock-env.bucket/'+cloudPath}})}).run();
  for(const status of ['prepared','deleted']) {
    const row=cloud.__colStore('v2_media').get('old_'+status);
    assert.equal(row.status,'deleted');assert.ok(row.stagingFileID);assert.equal(cloud.__files.has(row.stagingFileID),false);
  }
});
test('cleanup keeps unknown file identity retryable when storage metadata is unavailable',async()=>{
  cloud.__colStore('v2_media').set('old',{ownerOpenid:'A',cloudPath:'v2-upload/A/old',status:'prepared',stagingFileID:'',fileID:'',expiresAt:new Date(0)});
  await createMediaCleanup(cloud,undefined,{getUploadMetadata:async()=>{throw new Error('temporary outage');}}).run();
  assert.equal(cloud.__colStore('v2_media').get('old').status,'cleanup_claimed');
});
