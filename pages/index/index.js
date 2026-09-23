const app = getApp();
const api = require('../../services/cloud');
const WEEKS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
const pad = (n) => (n < 10 ? '0' + n : '' + n);
const fmtDate = (d) => d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());

Page({
  data: {
    dateStr: '', dayNum: '', yearMonth: '', weekDay: '', type: '', reason: '', submitted: false,
    loading: false, authLoading: true, bindingStatus: 'loading', canRate: false, partnerRating: null,
    monthStreak: 0, monthGoodRate: 0, streakHearts: [0,0,0,0,0,0,0,0]
  },
  onLoad() {
    const now = new Date();
    this.setData({ dateStr: fmtDate(now), dayNum: pad(now.getDate()), yearMonth: now.getFullYear() + '年' + pad(now.getMonth() + 1) + '月', weekDay: WEEKS[now.getDay()] });
  },
  onShow() { this.refreshSession(); },
  async refreshSession() {
    this.setData({ authLoading: true });
    try {
      const session = await api.getSession();
      const active = session.bindingStatus === 'active';
      this.setData({ authLoading: false, bindingStatus: session.bindingStatus || 'unbound', canRate: active });
      if (active) await Promise.all([this.loadToday(), this.loadMiniStats()]);
      else this.setData({ type:'', reason:'', submitted:false, partnerRating:null, monthStreak:0, monthGoodRate:0 });
    } catch (e) {
      this.setData({ authLoading:false, bindingStatus:'error' });
      wx.showToast({ title:e.message || '身份加载失败', icon:'none' });
    }
  },
  async loadToday() {
    try {
      const data = await api.getToday();
      const doc = data.rating || {};
      this.setData({ dateStr:data.date || this.data.dateStr, type:doc.type || '', reason:doc.reason || '', submitted:!!doc.type, canRate:!!data.canRate, partnerRating:data.partnerRating || null });
    } catch (e) {
      if (api.isBindingError(e)) return this.setData({ bindingStatus:'unbound', type:'', reason:'', submitted:false, canRate:false, partnerRating:null });
      wx.showToast({ title:e.message || '加载失败', icon:'none' });
    }
  },
  async loadMiniStats() {
    try {
      const rows = await api.listRatings();
      const now = new Date();
      const prefix = now.getFullYear() + '-' + pad(now.getMonth()+1) + '-';
      const month = rows.filter(x => String(x.date || '').indexOf(prefix) === 0);
      const good = month.filter(x => x.type === 'good').length;
      const rate = month.length ? Math.round(good / month.length * 100) : 0;
      const byDate = {};
      rows.forEach(x => { (byDate[x.date] ||= []).push(x); });
      let streak=0, cur=new Date(now.getFullYear(),now.getMonth(),now.getDate());
      while (true) {
        const key=fmtDate(cur), day=byDate[key] || [];
        if (!(day.length === 2 && day.every(x => x.type === 'good'))) break;
        streak += 1; cur.setDate(cur.getDate()-1);
      }
      this.setData({ monthStreak:streak, monthGoodRate:rate, streakHearts:Array.from({length:8},(_,i)=>i<Math.min(streak,8)) });
    } catch (_) {}
  },
  goBind(){ wx.navigateTo({url:'/pages/bind/bind'}); },
  goProfile(){ wx.navigateTo({url:'/pages/profile/profile'}); },
  goPermissions(){ wx.navigateTo({url:'/pages/permissions/permissions'}); },
  goPrivileges(){ wx.navigateTo({url:'/pages/privileges/privileges'}); },
  selectGood(){ if(this.data.canRate) this.setData({type:app.globalData.GOOD}); },
  selectNeutral(){ if(this.data.canRate) this.setData({type:app.globalData.NEUTRAL}); },
  selectBad(){ if(this.data.canRate) this.setData({type:app.globalData.BAD}); },
  onReasonInput(e){ if(this.data.canRate) this.setData({reason:e.detail.value}); },
  editToday(){ this.setData({submitted:false}); },
  async submit(){
    if(!this.data.canRate || !this.data.type || this.data.loading) return;
    this.setData({loading:true}); wx.showLoading({title:'保存中',mask:true});
    try{
      const data=await api.saveToday(this.data.type,this.data.reason); const rating=data.rating || {};
      this.setData({dateStr:data.date || this.data.dateStr,type:rating.type || this.data.type,reason:rating.reason || '',submitted:true});
      const label=this.data.type==='good'?'很好':(this.data.type==='neutral'?'还好':'有点糟');
      wx.showToast({title:'今天的「'+label+'」已记录',icon:'none'});
      await Promise.all([this.loadToday(),this.loadMiniStats()]);
    }catch(e){ wx.showToast({title:e.message || '提交失败',icon:'none'}); }
    finally{ wx.hideLoading(); this.setData({loading:false}); }
  }
});