import { start } from './env.mjs';
const env=await start({port:8837, linePort:8838});
const B='http://127.0.0.1:8837';
const P=async (p,b,h={})=>{const r=await fetch(B+p,{method:'POST',headers:{'content-type':'application/json',...h},body:JSON.stringify(b||{})});return {status:r.status,body:await r.json(),headers:r.headers}};
const add=(s,n)=>{const d=new Date(s+'T00:00:00Z');d.setUTCDate(d.getUTCDate()+n);return d.toISOString().slice(0,10)};
const T=new Date(Date.now()+9*3600e3).toISOString().slice(0,10);
let D=add(T,6); while(new Date(D+'T00:00:00Z').getUTCDay()!==6) D=add(D,1);
const a=await P('/admin/api/login',{password:'pw-test-123'});
const AD={cookie:a.headers.get('set-cookie').split(';')[0],'x-epii':'1'};
const st=(await P('/admin/api/boot',{},AD)).body.settings; st.seats=6; for (const d in st.weekly) st.weekly[d]=['morning','lunch','dinner']; await P('/admin/api/saveSettings',st,AD);
const used=async t=>((await P('/admin/api/day',{date:D},AD)).body.slots.find(x=>x.time===t)||{}).used;
// 11:30から6名、14:30まで（いつもは90分＝13:00まで）
let r=await P('/admin/api/addPhone',{date:D,time:'11:30',until:'14:30',guests:6,name:'田村',source:'電話'},AD);
console.log('11:30〜14:30で全6席:', r.body.ok?'OK':r.body.message);
console.log('席の使用 11:30:',await used('11:30'),'/ 12:30:',await used('12:30'),'/ 13:00:',await used('13:00'),'（いつもの長さなら0）');
const res=(await P('/admin/api/day',{date:D},AD)).body.reservations[0];
console.log('一覧の表示:', res.time+'〜'+res.until);
// お客様側でも13:00が満席になっているか
const l=await P('/api/login',{idToken:'u1'}); const lun=l.body.data.courses.find(c=>c.name==='養生ランチ');
r=await P('/api/request',{data:{date:D,time:'13:00',guests:1,courseId:lun.id,sei:'山田',mei:'花子',phone:'09011112222'}},{authorization:'Bearer '+l.body.token});
console.log('お客様が13:00に1名:', r.body.ok?'通ってしまう':r.body.message);
console.log('予約ページに渡る席情報:', l.body.data.holds.find(h=>h.stay)?.stay+'分');
// いつもの長さを選んだ場合は記録しない
r=await P('/admin/api/addPhone',{date:D,time:'18:00',until:'20:30',guests:2,name:'鈴木',source:'電話'},AD);
const r2=(await P('/admin/api/day',{date:D},AD)).body.reservations.find(x=>x.name==='鈴木');
console.log('いつもの長さ（ディナー150分）:', r2.stay===null?'記録なし（いつもどおり）':r2.stay);
// 不正な値
r=await P('/admin/api/addPhone',{date:D,time:'18:00',until:'18:05',guests:1,name:'x',source:'電話'},AD);
console.log('5分だけ:', r.body.message);
// 全席（貸切）で何時まで
await P('/admin/api/addBlock',{date:add(D,7),type:'seats',start:'18:00',end:'22:00',allSeats:true,memo:'貸切'},AD);
console.log('貸切 18:00〜22:00 → 21:30の使用:', ((await P('/admin/api/day',{date:add(D,7)},AD)).body.slots.find(x=>x.time==='19:30')||{}).used);
await env.stop();
