import { start } from './env.mjs';
const env=await start({port:8795, linePort:8796});
const B='http://127.0.0.1:8795';
const post=async (p,b,h={})=>{const r=await fetch(B+p,{method:'POST',headers:{'content-type':'application/json',...h},body:JSON.stringify(b||{})});return {status:r.status,body:await r.json(),headers:r.headers}};
const add=(s,n)=>{const d=new Date(s+'T00:00:00Z');d.setUTCDate(d.getUTCDate()+n);return d.toISOString().slice(0,10)};
const T=new Date(Date.now()+9*3600e3).toISOString().slice(0,10);
let D=add(T,6); while(new Date(D+'T00:00:00Z').getUTCDay()!==6) D=add(D,1);
const a=await post('/admin/api/login',{password:'pw-test-123'});
const AD={cookie:a.headers.get('set-cookie').split(';')[0],'x-epii':'1'};
const l1=await post('/api/login',{idToken:'u1'}); const A1={authorization:'Bearer '+l1.body.token};
const din=l1.body.data.courses.find(c=>c.name==='季節の薬膳フレンチ');
// 席数を4にして、同時に3名×2件を申し込む
const st=(await post('/admin/api/boot',{},AD)).body.settings; st.seats=4;
await post('/admin/api/saveSettings',st,AD);
const users=await Promise.all(['a','b','c'].map(x=>post('/api/login',{idToken:x})));
const reqs=users.map(u=>post('/api/request',{data:{date:D,time:'18:00',guests:3,courseId:din.id,name:'テスト 太郎',phone:'09011112222'}},{authorization:'Bearer '+u.body.token}));
const out=await Promise.all(reqs);
console.log('同時3件（4席・各3名）:', out.map(o=>o.body.ok?'OK':'NG').join(' / '));
const day=(await post('/admin/api/day',{date:D},AD)).body;
console.log('登録された人数:', day.reservations.reduce((s,r)=>s+r.guests,0), '席数:', day.seats);
// 変更リクエストの同時申し込み
const r=await post('/api/request',{data:{date:add(D,7),time:'18:00',guests:1,courseId:din.id,name:'山田 花子',phone:'09012345678'}},A1);
if (r.body.ok) {
  await post('/admin/api/reply',{id:r.body.reservation.id,mode:'ok',text:'ok'},AD);
  const two=await Promise.all([
    post('/api/change',{data:{id:r.body.reservation.id,date:add(D,7),time:'18:30',guests:1,courseId:din.id}},A1),
    post('/api/change',{data:{id:r.body.reservation.id,date:add(D,7),time:'19:00',guests:1,courseId:din.id}},A1)
  ]);
  console.log('同時に変更2件:', two.map(o=>o.body.ok?'OK':'NG').join(' / '));
  console.log('残った変更リクエスト:', (await post('/admin/api/requests',{},AD)).body.requests.changes.length, '件');
}
await env.stop();
