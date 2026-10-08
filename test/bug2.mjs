import { start, pushes, setFailPush } from './env.mjs';
const env=await start({port:8793, linePort:8794});
const B='http://127.0.0.1:8793';
const post=async (p,b,h={})=>{const r=await fetch(B+p,{method:'POST',headers:{'content-type':'application/json',...h},body:JSON.stringify(b||{})});return {status:r.status,body:await r.json(),headers:r.headers}};
const add=(s,n)=>{const d=new Date(s+'T00:00:00Z');d.setUTCDate(d.getUTCDate()+n);return d.toISOString().slice(0,10)};
const T=new Date(Date.now()+9*3600e3).toISOString().slice(0,10);
let D=add(T,6); while(new Date(D+'T00:00:00Z').getUTCDay()!==6) D=add(D,1);
const l1=await post('/api/login',{idToken:'u1'}); const A1={authorization:'Bearer '+l1.body.token};
const din=l1.body.data.courses.find(c=>c.name==='季節の薬膳フレンチ');
const a=await post('/admin/api/login',{password:'pw-test-123'});
const AD={cookie:a.headers.get('set-cookie').split(';')[0],'x-epii':'1'};
const mk=(o)=>post('/api/request',{data:{date:D,time:'18:00',guests:2,courseId:din.id,name:'山田 花子',phone:'09012345678',...o}},A1);
const who=t=>pushes.filter(p=>p.to==='U_u1').map(p=>p.messages[0].text.split('\n').find(x=>x.trim()&&!x.includes('様'))||'').slice(-1)[0];
// 1) 確定 → お客様キャンセル
let r=await mk({}); const id1=r.body.reservation.id;
await post('/admin/api/reply',{id:id1,mode:'ok',text:'確定'},AD);
pushes.length=0;
r=await post('/api/cancel',{id:id1},A1);
console.log('確定のキャンセル → お客様へ:', pushes.filter(p=>p.to==='U_u1').length, '件 |', who());
// 2) 返事待ちを取り下げ
r=await mk({time:'18:30'}); const id2=r.body.reservation.id;
pushes.length=0;
r=await post('/api/cancel',{id:id2},A1);
console.log('リクエスト取り下げ → お客様へ:', pushes.filter(p=>p.to==='U_u1').length, '件 |', who());
// 3) 提案を見送り
r=await mk({time:'19:00'}); const id3=r.body.reservation.id;
const sug=(await post('/admin/api/requests',{},AD)).body.requests.waiting.find(x=>x.id===id3).suggestions[0];
await post('/admin/api/reply',{id:id3,mode:'offer',text:'ご提案',offer:sug},AD);
pushes.length=0;
r=await post('/api/decline',{id:id3},A1);
console.log('提案の見送り → お客様へ:', pushes.filter(p=>p.to==='U_u1').length, '件 |', who());
// 4) 変更の取り下げ
r=await mk({time:'19:30'}); const id4=r.body.reservation.id;
await post('/admin/api/reply',{id:id4,mode:'ok',text:'確定'},AD);
const c=await post('/api/change',{data:{id:id4,date:D,time:'13:00',guests:2,courseId:l1.body.data.courses.find(x=>x.name==='養生ランチ').id}},A1);
const cid=(await post('/admin/api/requests',{},AD)).body.requests.changes[0].id;
pushes.length=0;
r=await post('/api/cancelChange',{id:cid},A1);
console.log('変更の取り下げ → お客様へ:', pushes.filter(p=>p.to==='U_u1').length, '件 |', who());
// 5) 送信失敗時に状態が戻るか
setFailPush(true);
const before=(await post('/admin/api/day',{date:D},AD)).body.reservations.find(x=>x.id===id4);
r=await post('/admin/api/edit',{id:id4,updatedAt:before.updatedAt,date:D,time:'18:30',guests:4,courseId:din.id,name:before.name,phone:'090',note:'',text:'変更します'},AD);
const after=(await post('/admin/api/day',{date:D},AD)).body.reservations.find(x=>x.id===id4);
console.log('送信失敗時:', r.body.message, '| 予約は', after.time, after.guests+'名（元は', before.time, before.guests+'名）');
setFailPush(false);
await env.stop();
