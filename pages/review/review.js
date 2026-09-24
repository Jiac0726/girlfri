const api = require('../../services/cloud');
const WEEK_LABELS=['一','二','三','四','五','六','日'];
const MONTH_EN=['JANUARY','FEBRUARY','MARCH','APRIL','MAY','JUNE','JULY','AUGUST','SEPTEMBER','OCTOBER','NOVEMBER','DECEMBER'];
const pad=n=>n<10?'0'+n:''+n;
const fmtDate=d=>d.getFullYear()+'-'+pad(d.getMonth()+1)+'-'+pad(d.getDate());
function groupByDate(list){const m={};(list||[]).forEach(x=>{(m[x.date] ||= []).push(x)});return m}
function longestReason(rows){let best='';(rows||[]).forEach(x=>{const s=String(x.reason||'').trim();if(s.length>best.length)best=s});return best}

Page({
 data:{
  loading:false,ready:false,reviewMode:'calendar',year:0,month:0,monthLabel:'',canPrev:false,canNext:false,weeks:WEEK_LABELS,calendar:[],
  selectedDate:'',selectedDateLabel:'',selectedRecords:[],
  monthGood:0,monthNeutral:0,monthBad:0,monthGoodRate:0,monthBestStreak:0,monthRecordDays:0,monthMutualGoodDays:0,monthEn:'',
  monthQuote:'这个月还没有可展示的感受。'
 },
 onLoad(){const n=new Date();this.viewYear=n.getFullYear();this.viewMonth=n.getMonth();this.allRatings=[];this.earliest=null},
 onShow(){this.refreshAll()},
 onPullDownRefresh(){this.refreshAll(true)},
 async refreshAll(pull){
  if(this.data.loading)return;this.setData({loading:true});if(!pull)wx.showLoading({title:'整理回顾中'});
  try{
   const all=await api.listRatings();this.allRatings=all.slice();
   if(all.length){const old=all[all.length-1];const d=new Date(old.date+'T00:00:00');this.earliest={y:d.getFullYear(),m:d.getMonth()}}else this.earliest=null;
   this.renderMonth();this.setData({ready:true});
  }catch(e){if(api.isBindingError(e))wx.showModal({title:'先完成双人绑定',content:'绑定后才能看到两个人的共同回顾。',confirmText:'去绑定',confirmColor:'#f05b72',success:r=>{if(r.confirm)wx.navigateTo({url:'/pages/bind/bind'})}});else wx.showToast({title:e.message||'加载失败',icon:'none'})}
  finally{this.setData({loading:false});if(pull)wx.stopPullDownRefresh();else wx.hideLoading()}
 },
 renderMonth(){
  const y=this.viewYear,m=this.viewMonth,days=new Date(y,m+1,0).getDate(),now=new Date(),today=fmtDate(now);
  const start=y+'-'+pad(m+1)+'-01',end=y+'-'+pad(m+1)+'-'+pad(days);
  const rows=this.allRatings.filter(x=>x.date>=start&&x.date<=end).sort((a,b)=>a.date.localeCompare(b.date));
  const by=groupByDate(rows),good=rows.filter(x=>x.type==='good').length,neutral=rows.filter(x=>x.type==='neutral').length,bad=rows.filter(x=>x.type==='bad').length;
  let best=0,run=0,mutualGood=0;
  for(let d=1;d<=days;d++){const key=y+'-'+pad(m+1)+'-'+pad(d),rs=by[key]||[],mg=rs.length===2&&rs.every(x=>x.type==='good');if(mg){run++;mutualGood++}else run=0;if(run>best)best=run}
  const first=new Date(y,m,1),offset=(first.getDay()+6)%7,cal=[];
  for(let i=0;i<offset;i++)cal.push({key:'e'+i,empty:true});
  for(let d=1;d<=days;d++){const key=y+'-'+pad(m+1)+'-'+pad(d),rs=by[key]||[];cal.push({key,dayNum:d,hasRecord:rs.length>0,mutualGood:rs.length===2&&rs.every(x=>x.type==='good'),hasBad:rs.some(x=>x.type==='bad'),hasNeutral:rs.some(x=>x.type==='neutral')})}
  while(cal.length%7)cal.push({key:'t'+cal.length,empty:true});
  const isCurrent=y===now.getFullYear()&&m===now.getMonth();
  const canPrev=this.earliest&&(y>this.earliest.y||(y===this.earliest.y&&m>this.earliest.m));
  const monthDays=Object.keys(by);
  let selected=this.data.selectedDate;
  if(!selected||selected<start||selected>end)selected=monthDays.length?monthDays[monthDays.length-1]:(isCurrent?today:start);
  const quote=longestReason(rows)||'这个月还没有可展示的感受。';
  this.setData({year:y,month:m+1,monthLabel:y+'年'+(m+1)+'月',monthEn:MONTH_EN[m],canPrev:!!canPrev,canNext:!isCurrent,calendar:cal,
   monthGood:good,monthNeutral:neutral,monthBad:bad,monthGoodRate:rows.length?Math.round(good/rows.length*100):0,monthBestStreak:best,
   monthRecordDays:monthDays.length,monthMutualGoodDays:mutualGood,monthQuote:quote});
  this.applySelected(selected);
 },
 applySelected(key){
  if(!key)return;const rs=(this.allRatings||[]).filter(x=>x.date===key).map((x,i)=>Object.assign({},x,{key:key+'-'+i}));
  const d=new Date(key+'T00:00:00');
  this.setData({selectedDate:key,selectedDateLabel:(d.getMonth()+1)+'月'+d.getDate()+'日',selectedRecords:rs});
 },
 selectDay(e){const k=e.currentTarget.dataset.key;if(k&&!/^e|^t/.test(k))this.applySelected(k)},
 prevMonth(){if(!this.data.canPrev)return;this.viewMonth--;if(this.viewMonth<0){this.viewMonth=11;this.viewYear--}this.setData({selectedDate:''});this.renderMonth()},
 nextMonth(){if(!this.data.canNext)return;this.viewMonth++;if(this.viewMonth>11){this.viewMonth=0;this.viewYear++}this.setData({selectedDate:''});this.renderMonth()},
 showCalendar(){this.setData({reviewMode:'calendar'})},
 showMonth(){this.setData({reviewMode:'month'})},
 goProfile(){wx.navigateTo({url:'/pages/profile/profile'})}
});
