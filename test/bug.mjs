import { start, pushes, setFailPush } from './env.mjs';
const env=await start({port:8789, linePort:8792});
const B='http://127.0.0.1:8789';
const post=async (p,b,h={})=>{const r=await fetch(B+p,{method:'POST',headers:{'content-type':'application/json',...h},body:JSON.stringify(b||{})});return {status:r.status,body:await r.json(),headers:r.headers}};
const add=(s,n)=>{const d=new Date(s+'T00:00:00Z');d.setUTCDate(d.getUTCDate()+n);return d.toISOString().slice(0,10)};
const T=new Date(Date.now()+9*3600e3).toISOString().slice(0,10);
let D=add(T,6); while(new Date(D+'T00:00:00Z').getUTCDay()!==6) D=add(D,1);
const l1=await post('/api/login',{idToken:'u1'}); const A1={authorization:'Bearer '+l1.body.token};
const l2=await post('/api/login',{idToken:'u2'}); const A2={authorization:'Bearer '+l2.body.token};
const din=l1.body.data.courses.find(c=>c.name==='季節の薬膳フレンチ');
const a=await post('/admin/api/login',{password:'pw-test-123'});
const AD={cookie:a.headers.get('set-cookie').split(';')[0],'x-epii':'1'};
const mk=(o,h)=>post('/api/request',{data:{date:D,time:'18:00',guests:2,courseId:din.id,name:'山田 花子',phone:'09012345678',...o}},h);
// 1件目：確定させる
let r=await mk({},A1); const id1=r.body.reservation.id;
await post('/admin/api/reply',{id:id1,mode:'ok',text:'確定'},AD);
// 変更リクエストを出す
r=await post('/api/change',{data:{id:id1,date:D,time:'19:00',guests:2,courseId:din.id}},A1);
console.log('変更リクエスト:', r.body.ok ? 'OK' : r.body.message);
// その日に新しい予約を入れられるか（不具合の再現）
r=await mk({time:'18:30'},A2);
console.log('変更リクエストがある日の新規予約:', r.body.ok ? 'OK' : 'NG → ' + r.body.message);
// 変更リクエストの二重登録
const dup=await Promise.all([
  post('/api/change',{data:{id:id1,date:D,time:'19:30',guests:2,courseId:din.id}},A1),
  post('/api/change',{data:{id:id1,date:D,time:'13:00',guests:2,courseId:din.id}},A1)
]);
console.log('同時に2件の変更リクエスト:', dup.map(x=>x.body.ok?'OK':'NG').join(' / '));
const chg=(await post('/admin/api/requests',{},AD)).body.requests.changes;
console.log('残っている変更リクエスト数:', chg.length);
// LINE送信が失敗したときの状態
setFailPush(true);
const r2=await mk({time:'12:00',courseId:l1.body.data.courses.find(c=>c.name==='養生ランチ').id},A2);
const id2=r2.body.ok ? r2.body.reservation.id : null;
setFailPush(false);
await env.stop();
