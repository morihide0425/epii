import { start } from './env.mjs';
import { startIgMock, calls } from './igmock.mjs';
const mock = startIgMock(8833);
const env = await start({ port: 8834, linePort: 8835, extra: { IG_TOKEN: 'first-token-abcdefghijkl', IG_API_BASE: 'http://127.0.0.1:8833' } });
const B='http://127.0.0.1:8834';
const P=async (p,b,h={})=>{const r=await fetch(B+p,{method:'POST',headers:{'content-type':'application/json',...h},body:JSON.stringify(b||{})});return {status:r.status,body:await r.json(),headers:r.headers}};
const a=await P('/admin/api/login',{password:'pw-test-123'});
const AD={cookie:a.headers.get('set-cookie').split(';')[0],'x-epii':'1'};
await P('/admin/api/igSync',{},AD);
const db=await env.mf.getD1Database('DB');
// 21日前に発行したことにする → 次の取り込みで自動更新
const cur=JSON.parse((await db.prepare("SELECT v FROM kv WHERE k='igToken'").first()).v);
cur.at=Date.now()-21*86400000; await db.prepare("UPDATE kv SET v=? WHERE k='igToken'").bind(JSON.stringify(cur)).run();
await P('/admin/api/igSync',{},AD);
const after=JSON.parse((await db.prepare("SELECT v FROM kv WHERE k='igToken'").first()).v);
console.log('21日たったトークン:', after.token==='refreshed-token' ? '自動で更新された' : 'そのまま', '| 更新の呼び出し', calls.filter(c=>c==='/refresh_access_token').length, '回');
// 期限切れ
after.token='expired'; after.at=Date.now(); await db.prepare("UPDATE kv SET v=? WHERE k='igToken'").bind(JSON.stringify(after)).run();
const r=await P('/admin/api/igSync',{},AD);
const st=(await P('/admin/api/igStats',{days:30},AD)).body;
console.log('期限切れ:', r.body.result.message, '| 画面のエラー表示:', !!st.error);
await env.stop(); mock.close();
