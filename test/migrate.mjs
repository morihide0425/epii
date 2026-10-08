import { Miniflare } from 'miniflare';
import http from 'node:http';
const line = http.createServer((req,res)=>{let b='';req.on('data',c=>b+=c);req.on('end',()=>{
  if(req.url.includes('verify')){const p=new URLSearchParams(b);res.end(JSON.stringify({sub:'U_'+p.get('id_token'),name:'n'}));return}
  res.end('{}')})}).listen(8823);
const mf=new Miniflare({modules:true, scriptPath:new URL('../dist/worker.js',import.meta.url).pathname,
  compatibilityDate:'2025-09-01', d1Databases:['DB'], port:8824, host:'127.0.0.1',
  bindings:{ADMIN_PASSWORD:'pw-test-123',LINE_TOKEN:'tok',OWNER_USER_ID:'Uowner',LINE_CHANNEL_ID:'2011619064',LIFF_ID:'x',LINE_ID:'@x',LINE_API_BASE:'http://127.0.0.1:8823'}});
await mf.ready;
const db=await mf.getD1Database('DB');
for (const sql of [
 'CREATE TABLE kv (k TEXT PRIMARY KEY, v TEXT NOT NULL)',
 'CREATE TABLE reservations (id TEXT PRIMARY KEY, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, status TEXT NOT NULL, date TEXT NOT NULL, time TEXT NOT NULL, session TEXT NOT NULL, guests INTEGER NOT NULL, name TEXT NOT NULL, phone TEXT, course_id TEXT, course_name TEXT, note TEXT, alt_date TEXT, alt_time TEXT, offer_date TEXT, offer_time TEXT, hold_date TEXT NOT NULL, hold_time TEXT NOT NULL, hold_session TEXT NOT NULL, source TEXT, user_id TEXT, line_name TEXT, reminded_at TEXT, memo TEXT)',
 'CREATE TABLE courses (id TEXT PRIMARY KEY, sort INTEGER NOT NULL, visible INTEGER NOT NULL, name TEXT NOT NULL, price INTEGER NOT NULL, price_type TEXT NOT NULL, description TEXT, sessions TEXT NOT NULL, weekdays TEXT NOT NULL, min_guests INTEGER NOT NULL, cutoff_mode TEXT NOT NULL, cutoff_days INTEGER NOT NULL, cutoff_time TEXT NOT NULL)',
 'CREATE TABLE day_rules (date TEXT PRIMARY KEY, kind TEXT NOT NULL, sessions TEXT NOT NULL)',
 'CREATE TABLE blocks (id TEXT PRIMARY KEY, date TEXT NOT NULL, type TEXT NOT NULL, start TEXT NOT NULL, end TEXT NOT NULL, seats INTEGER, memo TEXT, created_at TEXT NOT NULL)',
 'CREATE TABLE login_fail (ip TEXT PRIMARY KEY, count INTEGER NOT NULL, until INTEGER NOT NULL)'
]) await db.prepare(sql).run();
const T=new Date(Date.now()+9*3600e3).toISOString().slice(0,10);
const add=(s,n)=>{const d=new Date(s+'T00:00:00Z');d.setUTCDate(d.getUTCDate()+n);return d.toISOString().slice(0,10)};
let D=add(T,6); while(new Date(D+'T00:00:00Z').getUTCDay()!==6) D=add(D,1);
await db.prepare("INSERT INTO kv VALUES ('schema','1')").run();
await db.prepare("INSERT INTO kv VALUES ('settings', ?)").bind(JSON.stringify({seats:6,maxGuests:4,aheadDays:40,cutoff:{days:3,time:'23:59'},weekly:{0:['lunch','dinner'],1:[],2:[],3:['lunch'],4:['lunch','dinner'],5:['lunch','dinner'],6:['morning','lunch','dinner']}})).run();
await db.prepare("INSERT INTO courses VALUES ('C1',1,1,'養生ランチコース',3800,'fixed','季節の薬膳','lunch','0,1,2,3,4,5,6',1,'custom',0,'10:00')").run();
await db.prepare("INSERT INTO courses VALUES ('C2',2,1,'薬膳ディナー',8800,'from','全7皿','dinner','0,1,2,3,4,5,6',2,'default',3,'23:59')").run();
await db.prepare("INSERT INTO reservations VALUES ('R1','2026-09-20 10:00','2026-09-20 10:00','確定',?,'12:00','lunch',2,'テスト 太郎','09011112222','C1','養生ランチコース','','','','','',?,'12:00','lunch','LINE','U_hana','はな',NULL,'')").bind(D,D).run();
const B='http://127.0.0.1:8824';
const post=async (p,b,h={})=>{const r=await fetch(B+p,{method:'POST',headers:{'content-type':'application/json',...h},body:JSON.stringify(b||{})});return {status:r.status,body:await r.json(),headers:r.headers}};
const l=await post('/api/login',{idToken:'hana'});
console.log('移行後のログイン:', l.body.ok ? 'OK' : l.body.message, '| schema:', (await db.prepare("SELECT v FROM kv WHERE k='schema'").first()).v);
console.log('既存の予約:', l.body.data.mine.map(m=>m.date+' '+m.time+' '+m.course).join(' / '));
const a=await post('/admin/api/login',{password:'pw-test-123'});
const AD={cookie:a.headers.get('set-cookie').split(';')[0],'x-epii':'1'};
const boot=await post('/admin/api/boot',{},AD);
console.log('管理画面:', boot.body.ok ? 'OK' : boot.body.message, '| メニュー', boot.body.courses.map(c=>c.name+'(上限'+(c.cap||'なし')+')').join(', '));
console.log('お客様台帳:', (await post('/admin/api/customers',{},AD)).body.total, '名 | 分析:', (await post('/admin/api/analytics',{days:30},AD)).body.totals);
console.log('記録:', (await post('/api/track',{sid:'x',src:'google',events:[{kind:'open'}]},{authorization:'Bearer '+l.body.token})).body.ok);
await mf.dispose(); line.close();
