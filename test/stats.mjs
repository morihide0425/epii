import { start } from './env.mjs';
const env=await start({port:8821, linePort:8822});
const B='http://127.0.0.1:8821';
const P=async (p,b,h={})=>{const r=await fetch(B+p,{method:'POST',headers:{'content-type':'application/json',...h},body:JSON.stringify(b||{})});return {status:r.status,body:await r.json(),headers:r.headers}};
const add=(s,n)=>{const d=new Date(s+'T00:00:00Z');d.setUTCDate(d.getUTCDate()+n);return d.toISOString().slice(0,10)};
const T=new Date(Date.now()+9*3600e3).toISOString().slice(0,10);
let D=add(T,6); while(new Date(D+'T00:00:00Z').getUTCDay()!==6) D=add(D,1);
const a=await P('/admin/api/login',{password:'pw-test-123'});
const AD={cookie:a.headers.get('set-cookie').split(';')[0],'x-epii':'1'};
const st=(await P('/admin/api/boot',{},AD)).body.settings; for (const d in st.weekly) st.weekly[d]=['morning','lunch','dinner']; await P('/admin/api/saveSettings',st,AD);
const tok=async id=>({authorization:'Bearer '+(await P('/api/login',{idToken:id})).body.token});
const din=(await P('/admin/api/courses',{},AD)).body.courses.find(c=>c.name==='季節の薬膳フレンチ');
const tr=(h,src,events)=>P('/api/track',{sid:'s1',src,events},h);
// 5人が見る（Google 2人、Instagram 1人、LINE 2人）
const U=[]; for (const id of ['a','b','c','d','e']) U.push(await tok(id));
await tr(U[0],'google',[{kind:'open'},{kind:'date',date:D},{kind:'time',date:D,time:'18:00'},{kind:'course',courseId:din.id}]);
await tr(U[1],'google',[{kind:'open'},{kind:'date',date:D}]);
await tr(U[2],'instagram',[{kind:'open'},{kind:'blocked',date:add(D,1),extra:'×'}]);
await tr(U[3],'line',[{kind:'open'},{kind:'filter',courseId:din.id}]);
await tr(U[4],'line',[{kind:'open'},{kind:'bogus'}]);   // 不正な種類は無視
// 1人が予約まで
const r=await P('/api/request',{data:{date:D,time:'18:00',guests:2,courseId:din.id,sei:'山田',mei:'花子',phone:'09011112222'}},U[0]);
console.log('予約:', r.body.ok);
// お店のアカウントは数えない
const owner=await tok('owner'); // env: OWNER_USER_ID='Uowner' → idToken 'owner' gives sub U_owner (not owner) so emulate
const an=(await P('/admin/api/analytics',{days:30},AD)).body;
console.log('今日の閲覧:', an.daily.slice(-1)[0], '| 合計', an.totals);
console.log('流れ:', an.funnel);
console.log('入口:', an.sources.map(x=>x.src+':'+x.users).join(' '));
console.log('満席で選べなかった日:', an.blocked);
console.log('メニュー:', an.courses);
console.log('同じ人の日数:', an.repeat, '| 見たが未予約(3日以上):', an.lookers.length);
// お客様の詳細に閲覧回数
const cust=(await P('/admin/api/customers',{},AD)).body.customers.find(c=>c.name.indexOf('山田')===0);
const det=(await P('/admin/api/customer',{key:cust.key},AD)).body;
console.log('山田さんの閲覧:', det.views);
// 不正：ログインなし
console.log('ログインなしの記録:', (await P('/api/track',{events:[{kind:'open'}]})).status);
await env.stop();
