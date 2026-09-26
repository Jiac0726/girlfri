const { test } = require('node:test');
const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const root = path.resolve(__dirname,'../..');
function load(file, context, handle) {
  const exports = {};
  vm.runInNewContext(fs.readFileSync(path.join(root,file),'utf8'),{
    exports, console: {warn(){},error(){}},
    require(name) {
      if (name==='wx-server-sdk') return {init(){},getWXContext:()=>context,DYNAMIC_CURRENT_ENV:'test'};
      if (name==='@cloudbase/node-sdk') return {init:()=>({getUploadMetadata(){}})};
      if (name==='./v2') return {createV2Api:()=>handle};
      if (name==='./worker') return {createReminderWorker:()=>({run:handle}),createMediaCleanup:()=>({run:handle})};
      throw new Error(name);
    },
  });
  return exports.main;
}
test('API rejects old clients and uses platform identity rather than payload identity',async()=>{
  let caller; const main=load('cloudfunctions/renianApi/index.js',{OPENID:'real'},async(event,id)=>{caller=id;return {};});
  assert.equal((await main({action:'entry.list'})).error.code,'CLIENT_UPGRADE_REQUIRED');
  assert.equal((await main({apiVersion:2,openid:'fake'})).ok,true);assert.equal(caller,'real');
});
test('API does not expose unexpected internal error or accept missing identity',async()=>{
  const bad=load('cloudfunctions/renianApi/index.js',{OPENID:'real'},async()=>{throw Object.assign(new Error('private DB data'),{code:'FORBIDDEN'});});
  const result=await bad({apiVersion:2});assert.equal(result.error.code,'INTERNAL');assert.equal(JSON.stringify(result).includes('private'),false);
  const missing=load('cloudfunctions/renianApi/index.js',{},async()=>{throw new Error('should not run');});
  assert.equal((await missing({apiVersion:2})).error.code,'NO_IDENTITY');
});
test('scheduled workers refuse ordinary WeChat callers',async()=>{
  for (const file of ['cloudfunctions/dailyReminder/index.js','cloudfunctions/mediaCleanup/index.js']) {
    let runs=0;const main=load(file,{OPENID:'caller'},async()=>{runs++;});
    const result=await main({});assert.equal(runs,0);assert.equal(JSON.stringify(result).includes('SCHEDULED_ONLY'),true);
  }
});
test('storage rules permit only owner staging writes and deny published writes/direct reads',()=>{
  const rules=JSON.parse(fs.readFileSync(path.join(root,'config/storage.rules.v2.json'),'utf8'));
  const allow=(expr,auth,resource)=>vm.runInNewContext(expr,{auth,resource});
  assert.equal(allow(rules.read,{openid:'A'},{openid:'A',path:'v2-upload/A/photo'}),false);
  assert.equal(allow(rules.write,{openid:'A'},{openid:'A',path:'v2-upload/A/photo'}),true);
  assert.equal(allow(rules.write,{openid:'B'},{openid:'A',path:'v2-upload/A/photo'}),false);
  assert.equal(allow(rules.write,{openid:'A'},{openid:'A',path:'v2-published/photo'}),false);
  assert.equal(allow(rules.write,null,{openid:'A',path:'v2-upload/A/photo'}),false);
});
