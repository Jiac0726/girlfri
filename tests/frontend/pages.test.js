const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const root = path.resolve(__dirname,'../..');
const tick = () => new Promise(r=>setImmediate(r));
function deferred() { let resolve,reject; const promise=new Promise((a,b)=>{resolve=a;reject=b;}); return {promise,resolve,reject}; }
function loadPage(name, api = {}, customWx = {}) {
  let page, sequence=0; const events=[], modules={};
  const wx = Object.assign(Object.fromEntries(['showToast','showLoading','hideLoading','stopPullDownRefresh','navigateTo','navigateBack','switchTab','pageScrollTo','previewImage','setClipboardData'].map(method=>[method,value=>events.push({method,value})])),{
    showModal(options) { options.success({confirm:true}); },
  },customWx);
  const remote=Object.assign({newRequestId:()=> 'request_'+(++sequence),isBindingError:e=>e.code==='NOT_BOUND'},api);
  function read(file) {
    file=path.resolve(file); if (!path.extname(file)) file+='.js';
    if(file===path.join(root,'services/cloud.js')) return remote;
    if(modules[file]) return modules[file].exports;
    const module={exports:{}}; modules[file]=module;
    vm.runInNewContext(fs.readFileSync(file,'utf8'),{
      require: spec=>read(path.resolve(path.dirname(file),spec)),module,exports:module.exports,
      Page: value=>page=value, wx, console, setTimeout, clearTimeout,
    },{filename:file});
    return module.exports;
  }
  read(path.join(root,'pages',name,name+'.js'));
  page.data=JSON.parse(JSON.stringify(page.data)); page.setData=patch=>Object.assign(page.data,patch);
  return {page,events,wx,read};
}
const session={bindingStatus:'active',coupleId:'pair',serverDate:'2026-09-26'};
const entry={id:'entry',text:'hello',mood:'',images:[],version:1,fromMe:true,createdAt:'2026-09-26T01:00:00Z',dayKey:'2026-09-26'};
test('older home summary response cannot restore a previous relation',async()=>{
  const old=deferred();let calls=0;
  const {page}=loadPage('index',{
    getSession:()=>++calls===1?old.promise:Promise.resolve({bindingStatus:'unbound'}),
    getEntryMonth:async()=>({totalEntries:9,recordDays:3,sharedDays:2,days:[]}),
  });
  const a=page.refresh(); await page.refresh(); old.resolve(session); await a;
  assert.equal(page.data.bindingStatus,'unbound'); assert.equal(page.data.totalEntries,0);
});
test('home loads only summary, blocks actions while loading, then opens composer and full feed',async()=>{
  const wait=deferred();
  const {page,events}=loadPage('index',{
    getSession:()=>wait.promise,
    getEntryMonth:async()=>({totalEntries:6,recordDays:3,sharedDays:2,days:[{date:'2026-09-26',count:2}]}),
  });
  const loading=page.refresh();page.writeEntry();page.goDailyFeed();assert.equal(events.length,0);
  wait.resolve(session);await loading;
  assert.equal(page.data.today,'2026-09-26');assert.equal(page.data.todayEntries,2);assert.equal(page.data.totalEntries,6);
  page.writeEntry();page.goDailyFeed();
  assert.equal(events[0].value.url,'/pages/entry/entry');
  assert.equal(events[1].value.url,'/pages/feed/feed');
});
test('expanded feed owns the full entry list',async()=>{
  const {page}=loadPage('feed',{getSession:async()=>session,listEntries:async()=>({items:[entry],nextCursor:null})});
  await page.refresh();
  assert.equal(page.data.entries.length,1);
  assert.equal(page.data.entries[0].text,'hello');
});
test('entry timeout freezes the submitted payload and retries with the same request id',async()=>{
  const sent=[];let tries=0;
  const {page}=loadPage('entry',{getSession:async()=>session,createEntry:async data=>{sent.push(JSON.parse(JSON.stringify(data)));if(++tries===1)throw Object.assign(new Error('timeout'),{code:'CLOUD_INVOKE_FAILED'});return entry;}});
  page._id='';await page.load(); page.onText({detail:{value:'最初的文字'}});
  page.chooseRating({currentTarget:{dataset:{type:'good'}}});await page.save();
  assert.equal(page.data.uncertain,true);page.onText({detail:{value:'被阻止的修改'}});
  page.chooseRating({currentTarget:{dataset:{type:'bad'}}});await page.save();
  assert.equal(sent.length,2);assert.deepEqual(sent[0],sent[1]);assert.equal(sent[0].text,'最初的文字');assert.equal(sent[0].ratingType,'good');
});
test('entry upload failure retains local draft and retries uploaded file confirmation',async()=>{
  let uploads=0,confirms=0;
  const {page}=loadPage('entry',{
    getSession:async()=>session,prepareMedia:async()=>({id:'photo',cloudPath:'staging'}),
    confirmMedia:async()=>{if(++confirms===1)throw Object.assign(new Error('network'),{code:'CLOUD_INVOKE_FAILED'});return {id:'photo',url:'signed'};},
    createEntry:async()=>entry,
  },{cloud:{uploadFile:async()=>{uploads++;return {fileID:'file'};}}});
  page._id='';await page.load();page.setData({images:[{localPath:'tmp',url:'tmp',size:10,uploadRequestId:'upload_123'}]});
  await page.save();assert.equal(page.data.images[0].localPath,'tmp');await page.save();
  assert.equal(uploads,1);assert.equal(confirms,2);
});
test('drafts are cleared when switching relationship',()=>{
  const {read}=loadPage('entry');const drafts=read(path.join(root,'services/entry-drafts.js'));
  drafts.activate('A');drafts.write('A','',{text:'private'});drafts.activate('B');
  assert.equal(drafts.read('B',''),null);assert.equal(drafts.read('A',''),null);
});
test('review ignores an older month response and keeps compact day labels',async()=>{
  const old=deferred();const {page}=loadPage('review',{
    getSession:async()=>session,
    getEntryMonth:month=>month==='2026-08'?old.promise:Promise.resolve({month,totalEntries:2,recordDays:1,sharedDays:1,days:[{date:'2026-09-26',count:2}]}),
    listEntries:async()=>({items:[]}),
  });
  page.setData({month:'2026-08'});const first=page.refresh();await tick();
  page.setData({month:'2026-09'});await page.refresh();old.resolve({month:'2026-08',totalEntries:99,days:[]});await first;
  assert.equal(page.data.month,'2026-09');assert.equal(page.data.monthLabel,'9月');assert.equal(page.data.totalEntries,2);
  assert.equal(page.data.days[0].dayLabel,'26日');
  page.chooseDay({currentTarget:{dataset:{day:'2026-09-26'}}});
  assert.equal(page.data.selectedDayLabel,'26日');
  page.clearDay();assert.equal(page.data.selectedDay,'');
});
test('gift retries a timeout without duplicate request or changing content',async()=>{
  const writes=[];let count=0;
  const {page}=loadPage('privileges',{giftCoupon:async data=>{writes.push(JSON.parse(JSON.stringify(data)));if(++count===1)throw Object.assign(new Error('network'),{code:'CLOUD_INVOKE_FAILED'});},listCoupons:async()=>({items:[]})});
  page.setData({title:'晚餐'});await page.gift();assert.equal(page.data.uncertain,true);
  page.onTitle({detail:{value:'新券'}});await page.gift();assert.deepEqual(writes[0],writes[1]);
});
test('agreement timeout freezes proposal and reuses its request id',async()=>{
  const writes=[];let count=0;
  const {page}=loadPage('permissions',{proposeAgreement:async data=>{writes.push(JSON.parse(JSON.stringify(data)));if(++count===1)throw Object.assign(new Error('network'),{code:'CLOUD_INVOKE_FAILED'});},listAgreements:async()=>({items:[]})});
  page.setData({title:'散步',content:'周日'});await page.submitAgreement();page.onContentInput({detail:{value:'周六'}});await page.submitAgreement();
  assert.deepEqual(writes[0],writes[1]);assert.equal(writes[0].content,'周日');
});
test('coupon client blocks author from redeeming own gift',async()=>{
  let writes=0;const {page}=loadPage('privileges',{requestCoupon:async()=>writes++});
  page.setData({items:[{id:'coupon',status:'available',fromMe:true,receivedByMe:false,version:1}]});
  await page.act({currentTarget:{dataset:{id:'coupon',action:'request'}}});assert.equal(writes,0);
});
test('binding failure has a retry state; own invite replacement requires confirmation',async()=>{
  let reads=0,joins=0;
  const {page}=loadPage('bind',{getSession:async()=>{if(++reads===1)throw new Error('offline');return {bindingStatus:'waiting',inviteCode:'ABCDEFGH'};},joinPair:async()=>joins++},{
    showModal:options=>options.success({confirm:false}),
  });
  await page.refresh();assert.equal(page.data.bindingStatus,'error');await page.refresh();
  page.setData({joinCode:'BCDEFGHJ'});await page.joinPair();assert.equal(joins,0);assert.equal(page.data.inviteCode,'ABCDEFGH');
});
test('profile private memo creates an item with attached image ids',async()=>{
  const writes=[];
  const saved={id:'memo1',title:'礼物',text:'下次见面记得带礼物',images:[{id:'photo',url:'signed'}],version:1,updatedAt:'2026-09-26T06:00:00Z'};
  const {page,events}=loadPage('profile',{
    createPrivateMemo:async data=>{writes.push(JSON.parse(JSON.stringify(data)));return saved;},
    listPrivateMemos:async()=>({items:[saved]}),
  });
  page.setData({bindingStatus:'active',authLoading:false,memoTitle:'礼物',memoText:'下次见面记得带礼物',memoImages:[{id:'photo',url:'signed'}]});
  await page.saveMemo();
  assert.equal(writes.length,1);
  assert.equal(writes[0].title,'礼物');
  assert.equal(writes[0].text,'下次见面记得带礼物');
  assert.deepEqual(writes[0].images,['photo']);
  assert.equal(page.data.memoItems.length,1);
  assert.equal(page.data.memoText,'');
  assert.equal(events.find(x=>x.method==='showToast').value.title,'只保存给你自己');
});
test('reminder is enabled only after explicit subscribe acceptance, with setting version',async()=>{
  const changes=[];
  const {page}=loadPage('profile',{updateReminderSettings:async(...data)=>{changes.push(data);return {enabled:true,time:'21:30',version:3};}},
    {requestSubscribeMessage:options=>options.success({tb0gjEGNaTQfOvLVKNdWKekwa3fSTdyCQkkTSpuNjtk:'accept'})});
  page.setData({bindingStatus:'active',authLoading:false,reminderReady:true});page._reminderVersion=2;
  await page.onReminderToggle({detail:{value:true}});assert.deepEqual(changes[0],[true,'21:30',2]);
});
test('subscription rejection never enables server setting',async()=>{
  let writes=0;const {page}=loadPage('profile',{updateReminderSettings:async()=>writes++},{requestSubscribeMessage:options=>options.success({})});
  page.setData({bindingStatus:'active',authLoading:false,reminderReady:true});await page.onReminderToggle({detail:{value:true}});assert.equal(writes,0);
});
test('cloud service always sends API v2 and fixed action',async()=>{
  let sent;const module={exports:{}};
  vm.runInNewContext(fs.readFileSync(path.join(root,'services/cloud.js'),'utf8'),{module,require:()=>({cloudEnv:'test'}),wx:{cloud:{callFunction:async data=>{sent=data;return {result:{ok:true,data:{}}};}}},console});
  await module.exports.createEntry({action:'pair.cancel',apiVersion:1});
  assert.equal(sent.data.action,'entry.create');assert.equal(sent.data.apiVersion,2);
});
