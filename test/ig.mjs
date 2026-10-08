import { start } from './env.mjs';
import { startIgMock, calls } from './igmock.mjs';
const mock = startIgMock(8830);
const env = await start({ port: 8831, linePort: 8832, extra: { IG_TOKEN: 'first-token-abcdefghijkl', IG_API_BASE: 'http://127.0.0.1:8830' } });
const B='http://127.0.0.1:8831';
const P=async (p,b,h={})=>{const r=await fetch(B+p,{method:'POST',headers:{'content-type':'application/json',...h},body:JSON.stringify(b||{})});return {status:r.status,body:await r.json(),headers:r.headers}};
const a=await P('/admin/api/login',{password:'pw-test-123'});
const AD={cookie:a.headers.get('set-cookie').split(';')[0],'x-epii':'1'};
// Instagramから予約ページを開いた人
for (const id of ['i1','i2','i3']) { const t=(await P('/api/login',{idToken:id})).body.token; await P('/api/track',{sid:'s',src:'ig-story',events:[{kind:'open'}]},{authorization:'Bearer '+t}); }
let r=await P('/admin/api/igSync',{},AD);
console.log('取り込み:', JSON.stringify(r.body.result));
const st=(await P('/admin/api/igStats',{days:30},AD)).body;
console.log('アカウント:', st.account, '| 取り込み時刻あり:', !!st.syncedAt);
const t=st.daily[st.daily.length-1];
console.log('今日の数値:', {reach:t.reach, views:t.views, profileViews:t.profileViews, linkTaps:t.linkTaps, followers:t.followers, igOpens:t.igOpens, stories:t.stories});
console.log('取り込んだ日数:', st.daily.filter(x=>x.reach!==null && x.reach!==undefined).length, '日');
console.log('投稿:', st.media.length, '件 |', st.media.slice(0,3).map(m=>m.kind+':reach'+m.reach+':visits'+m.visits).join(' '));
console.log('空き（告知候補）:', st.openings.length, '件');
// 同じ日の2回目の自動取り込みは間引く
const before=calls.length;
await env.mf.getWorker().then(w=>w.scheduled({cron:'0 */12 * * *'}));
console.log('定期実行の重複取り込み:', calls.length-before===0 ? '間引かれた' : (calls.length-before)+'回呼んだ');
await env.stop(); mock.close();
