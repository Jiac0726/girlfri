const app = getApp();
const api = require('../../services/cloud');
const WEEKS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
const pad = (n) => (n < 10 ? '0' + n : '' + n);
const fmtDate = (d) => d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
function dateFields(value) {
  const parts = value.split('-').map(Number);
  const day = new Date(parts[0], parts[1] - 1, parts[2]);
  return {
    dateStr: value,
    dayNum: pad(parts[2]),
    yearMonth: parts[0] + '年' + pad(parts[1]) + '月',
    weekDay: WEEKS[day.getDay()],
  };
}

Page({
  data: {
    dateStr: '', dayNum: '', yearMonth: '', weekDay: '', type: '', reason: '', submitted: false,
    loading: false, authLoading: true, loadError: '', bindingStatus: 'loading', canRate: false, partnerRating: null,
    monthStreak: 0, monthGoodRate: 0, streakHearts: [0,0,0,0,0,0,0,0]
  },
  onLoad() {
    this._requestVersion = 0;
    const today = new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString().slice(0, 10);
    this.setData(dateFields(today));
  },
  onShow() { return this.refreshSession(); },
  async refreshSession() {
    if (this.data.loading) return;
    const version = ++this._requestVersion;
    this.setData({ authLoading: true, canRate: false, loadError: '' });
    try {
      const session = await api.getSession();
      if (version !== this._requestVersion) return;
      const active = session.bindingStatus === 'active';
      this.setData({ bindingStatus: session.bindingStatus || 'unbound' });
      if (active) {
        // Load the server's date and rating before opening the editor or computing stats.
        await this.loadToday(version);
        if (version === this._requestVersion && this.data.canRate) await this.loadMiniStats(version);
      } else this.setData({ authLoading:false, type:'', reason:'', submitted:false, partnerRating:null, monthStreak:0, monthGoodRate:0, streakHearts:[0,0,0,0,0,0,0,0] });
    } catch (e) {
      if (version !== this._requestVersion) return;
      this.setData({ authLoading:false, bindingStatus:'error', canRate:false, loadError:'暂时无法加载今天的记录，请重试。' });
    }
  },
  async loadToday(version = this._requestVersion) {
    const request = this._todayRequest = (this._todayRequest || 0) + 1;
    this.setData({ canRate:false });
    try {
      const data = await api.getToday();
      if (version !== this._requestVersion || request !== this._todayRequest) return;
      const doc = data.rating || {};
      this.setData(Object.assign(dateFields(data.date || this.data.dateStr), {
        authLoading:false, loadError:'', type:doc.type || '', reason:doc.reason || '',
        submitted:!!doc.type, canRate:!!data.canRate, partnerRating:data.partnerRating || null,
      }));
    } catch (e) {
      if (version !== this._requestVersion || request !== this._todayRequest) return;
      if (api.isBindingError(e)) return this.setData({ authLoading:false, bindingStatus:'unbound', type:'', reason:'', submitted:false, canRate:false, partnerRating:null });
      this.setData({ authLoading:false, canRate:false, loadError:'暂时无法加载今天的记录，请重试。' });
    }
  },
  async loadMiniStats(version = this._requestVersion) {
    try {
      const rows = await api.listRatings();
      if (version !== this._requestVersion) return;
      const parts = this.data.dateStr.split('-').map(Number);
      const now = new Date(parts[0], parts[1] - 1, parts[2]);
      const prefix = this.data.dateStr.slice(0, 7) + '-';
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
  selectGood(){ if(this.data.canRate && !this.data.loading) this.setData({type:app.globalData.GOOD}); },
  selectNeutral(){ if(this.data.canRate && !this.data.loading) this.setData({type:app.globalData.NEUTRAL}); },
  selectBad(){ if(this.data.canRate && !this.data.loading) this.setData({type:app.globalData.BAD}); },
  onReasonInput(e){ if(this.data.canRate && !this.data.loading) this.setData({reason:e.detail.value}); },
  editToday(){ if(this.data.canRate && !this.data.loading) this.setData({submitted:false}); },
  async submit(){
    if(!this.data.canRate || !this.data.type || this.data.loading || this.data.authLoading) return;
    const version = ++this._requestVersion;
    this.setData({loading:true,canRate:false}); wx.showLoading({title:'保存中',mask:true});
    try{
      const data=await api.saveToday(this.data.type,this.data.reason); const rating=data.rating || {};
      this.setData(Object.assign(dateFields(data.date || this.data.dateStr), {type:rating.type || this.data.type,reason:rating.reason || '',submitted:true}));
      const label=this.data.type==='good'?'很好':(this.data.type==='neutral'?'还好':'有点糟');
      wx.showToast({title:'今天的「'+label+'」已记录',icon:'none'});
      await this.loadToday(version);
      await this.loadMiniStats(version);
    }catch(e){ this.setData({canRate:true}); wx.showToast({title:e.message || '提交失败',icon:'none'}); }
    finally{ wx.hideLoading(); this.setData({loading:false}); }
  }
});
