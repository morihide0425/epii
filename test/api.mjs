import assert from 'node:assert';
import { start, pushes, setFailPush } from './env.mjs';
const B = 'http://127.0.0.1:8787';
const env = await start();
const jst = () => { const d = new Date(Date.now() + 9 * 3600e3); return d.toISOString().slice(0, 10); };
const add = (s, n) => { const d = new Date(s + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const wd = s => new Date(s + 'T00:00:00Z').getUTCDay();
const T = jst();
const nextWd = (from, w) => { let d = from; while (wd(d) !== w) d = add(d, 1); return d; };
const post = async (path, body, headers = {}) => { const r = await fetch(B + path, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body || {}) }); return { status: r.status, body: await r.json(), headers: r.headers }; };
let ok = 0; const check = (c, m) => { assert(c, m); ok++; };
try {
  // pages
  let r = await fetch(B + '/'); let html = await r.text();
  check(html.includes('"liffId":"2011619064-letOFBEZ"') && html.includes('function leftAt'), 'customer page injected');
  r = await fetch(B + '/admin'); html = await r.text(); check(r.headers.get('x-frame-options') === 'DENY', 'admin headers');
  r = await fetch(B + '/logo.webp'); check(r.headers.get('content-type') === 'image/webp' && (await r.arrayBuffer()).byteLength > 1000, 'logo');

  // customer login
  let res = await post('/api/login', { idToken: 'bad' }); check(res.status === 401, 'bad token 401');
  res = await post('/api/login', { idToken: 'hana' }); check(res.body.ok, 'login ok');
  const tok = res.body.token; const auth = { authorization: 'Bearer ' + tok };
  const data = res.body.data;
  check(data.courses.length === 4 && data.settings.sessions.morning, 'seed courses/settings');
  res = await post('/api/init', {}, { authorization: 'Bearer x.y' }); check(res.status === 401, 'bad session 401');

  const courses = Object.fromEntries(data.courses.map(c => [c.name, c]));
  // pick a Saturday at least 5 days ahead
  const sat = nextWd(add(T, 5), 6);
  const req = (d, h = auth) => post('/api/request', { data: d }, h);
  const base = { date: sat, time: '18:00', guests: 2, courseId: courses['季節の薬膳フレンチ'].id, name: '山田 花子', phone: '090-1234-5678' };
  // validations
  res = await req({ ...base, name: '花' }); check(res.status === 400 && res.body.message.includes('フルネーム'), 'name');
  res = await req({ ...base, time: '11:30' }); check(res.status === 400 && /時間帯/.test(res.body.message), 'session mismatch ' + res.body.message);
  res = await req({ ...base, courseId: courses['シェフおまかせ'].id, guests: 1 }); check(res.body.message.includes('2名様'), 'min guests');
  const mon = nextWd(add(T, 3), 1);
  res = await req({ ...base, date: mon }); check(res.body.message.includes('承っていません'), 'monday closed');
  // deadline: morning course 3 days before -> date T+2 should fail
  const soon = [add(T, 1), add(T, 2)].find(d => [0, 3, 4, 5, 6].includes(wd(d)));
  if (soon) { res = await req({ ...base, date: soon, time: '08:30', courseId: courses['モーニング'].id }); check(res.body.message.includes('3日前まで'), 'morning deadline ' + res.body.message); }
  // lunch today 10:00 rule: today's date lunch — now JST early morning -> allowed if open today
  // success with alt
  pushes.length = 0;
  res = await req({ ...base, note: 'くるみアレルギー', altDate: sat, altTime: '19:00' });
  check(res.body.ok, 'request ok ' + JSON.stringify(res.body));
  const rid = res.body.reservation.id;
  check(pushes.length === 2 && pushes.some(p => p.to === 'Uowner') && pushes.some(p => p.to === 'U_hana' && p.messages[1].type === 'template'), 'owner + customer receipt');
  check(res.body.data.mine.length === 1 && res.body.data.holds.some(h => h.id === rid), 'mine + hold');

  // admin auth
  res = await post('/admin/api/boot', {}, { 'x-epii': '1' }); check(res.status === 401, 'admin 401');
  res = await post('/admin/api/login', { password: 'nope' }); check(res.status === 401, 'bad pw');
  res = await post('/admin/api/login', { password: 'pw-test-123' }); check(res.status === 200, 'admin login');
  const cookie = res.headers.get('set-cookie').split(';')[0];
  const A = { cookie, 'x-epii': '1' };
  res = await post('/admin/api/boot', {}, { cookie }); check(res.status === 403, 'csrf header required');
  res = await post('/admin/api/boot', {}, A); check(res.body.ok && res.body.requests.waiting.length === 1, 'boot');
  const w = res.body.requests.waiting[0];
  check(w.left === 16 && w.altLeft === 16 && w.suggestions.length > 0, 'left/suggest ' + JSON.stringify([w.left, w.altLeft, w.suggestions.slice(0, 2)]));
  check(w.suggestions.every(s => s.time >= '18:00'), 'suggest dinner only');

  // blocks: seats block 12 seats at 18:00-20:30 -> 18:00 left 0 for others (excluding hana 2)
  res = await post('/admin/api/addBlock', { date: sat, type: 'seats', start: '18:00', end: '20:30', seats: 12, memo: 'Instagram' }, A); check(res.body.ok, 'block add');
  res = await post('/api/login', { idToken: 'taro' }); const auth2 = { authorization: 'Bearer ' + res.body.token };
  res = await req({ ...base, name: '佐藤 太郎', guests: 3 }, auth2); check(res.body.message.includes('満席'), 'blocked full ' + res.body.message);
  // stop block from 19:30
  res = await post('/admin/api/addBlock', { date: sat, type: 'stop', start: '19:30', end: '23:59' }, A);
  res = await req({ ...base, name: '佐藤 太郎', time: '19:30' }, auth2); check(res.body.message.includes('満席'), 'stop block');
  res = await post('/admin/api/day', { date: sat }, A);
  check(res.body.slots.find(s => s.time === '19:30').stopped && res.body.slots.find(s => s.time === '18:00').used === 14, 'day view');
  const blk = res.body.blocks.find(b => b.type === 'seats');
  // reply with offer
  res = await post('/admin/api/requests', {}, A);
  const w2 = res.body.requests.waiting[0];
  check(w2.left === 4, 'left after block ' + w2.left);
  pushes.length = 0;
  const off = w2.suggestions[0];
  res = await post('/admin/api/reply', { id: rid, mode: 'offer', text: 'ご提案です', offer: off }, A);
  check(res.body.ok && pushes[0].messages[1].template.actions[0].uri.startsWith('https://miniapp.line.me/2011619064-letOFBEZ?view=offer'), 'offer push');
  res = await post('/admin/api/reply', { id: rid, mode: 'ok', text: 'x' }, A); check(res.body.message.includes('返事済み'), 'double reply');
  // customer accept
  res = await post('/api/accept', { id: rid }, auth2); check(res.status === 404, 'other user cannot accept');
  pushes.length = 0;
  res = await post('/api/accept', { id: rid }, auth); check(res.body.ok && res.body.data.mine[0].status === '確定' && res.body.data.mine[0].date === off.date, 'accept');
  check(pushes.length === 2, 'accept pushes');
  // customer cancel (date >= cancelDays)
  pushes.length = 0;
  res = await post('/api/cancel', { id: rid }, auth); check(res.body.ok && res.body.data.mine.length === 0 && pushes.length === 2, 'cancel + notify');
  // reply failure keeps state
  res = await req({ ...base, name: '佐藤 太郎', date: add(sat, 1), time: '12:00', courseId: courses['養生ランチ'].id }, auth2);
  check(res.body.ok, 'lunch request ' + res.body.message);
  const rid2 = res.body.reservation.id;
  setFailPush(true);
  res = await post('/admin/api/reply', { id: rid2, mode: 'ok', text: 'x' }, A); check(res.body.message.includes('LINEを送れませんでした'), 'push fail');
  setFailPush(false);
  res = await post('/admin/api/reply', { id: rid2, mode: 'ok', text: '確定です' }, A); check(res.body.ok, 'approve');
  // cancel deadline: move clock? cancelDays=2 test via settings
  res = await post('/admin/api/boot', {}, A);
  const s = res.body.settings;
  const s2 = JSON.parse(JSON.stringify(s)); s2.cancelDays = 30;
  res = await post('/admin/api/saveSettings', s2, A); check(res.body.ok, 'save settings');
  res = await post('/api/cancel', { id: rid2 }, auth2); check(res.body.message.includes('お電話'), 'cancel deadline');
  // invalid settings
  const s3 = JSON.parse(JSON.stringify(s)); s3.sessions.morning.last = '12:00';
  res = await post('/admin/api/saveSettings', s3, A); check(res.body.message.includes('モーニング'), 'overlap check');
  // courses
  res = await post('/admin/api/saveCourse', { name: '週末ブランチ', price: 3000, price_type: 'from', sessions: ['morning', 'lunch'], weekdays: [0, 6], min_guests: 1, cutoff_mode: 'custom', cutoff_days: 0, cutoff_time: '09:00' }, A);
  check(res.body.courses.some(c => c.name === '週末ブランチ' && c.price_type === 'from' && c.weekdays.join() === '0,6'), 'save course');
  const brunch = res.body.courses.find(c => c.name === '週末ブランチ');
  res = await req({ ...base, name: '佐藤 太郎', date: nextWd(add(T, 3), 3), time: '12:00', courseId: brunch.id }, auth2);
  check(res.body.message.includes('曜日'), 'course weekday ' + res.body.message);
  // 期間限定：期間外の日は予約できない。終わったメニューは予約ページに出ない
  const ev0 = nextWd(add(T, 8), 6);
  res = await post('/admin/api/saveCourse', { name: 'イベントランチ', price: 4000, sessions: ['lunch'], weekdays: [0, 1, 2, 3, 4, 5, 6], min_guests: 1, date_from: ev0, date_to: add(ev0, 6) }, A);
  const ev = res.body.courses.find(c => c.name === 'イベントランチ');
  check(ev && ev.date_from === ev0 && ev.date_to === add(ev0, 6), 'period saved');
  res = await post('/admin/api/saveCourse', Object.assign({}, ev, { date_from: add(ev0, 7), date_to: ev0 }), A);
  check(res.status >= 400 && res.body.message.includes('終わり'), 'period order checked');
  res = await req({ ...base, name: '佐藤 太郎', date: add(ev0, -1), time: '12:00', courseId: ev.id }, auth2);
  check(res.body.message.includes('期間限定'), 'outside period refused ' + res.body.message);
  res = await post('/api/login', { idToken: 'hana' });
  check(res.body.data.courses.some(c => c.id === ev.id && c.date_from === ev0), 'period course public');
  res = await post('/admin/api/saveCourse', Object.assign({}, ev, { date_from: add(T, -20), date_to: add(T, -1) }), A);
  res = await post('/api/login', { idToken: 'hana' });
  check(!res.body.data.courses.some(c => c.id === ev.id), 'ended course hidden');
  await post('/admin/api/deleteCourse', { id: ev.id }, A);
  res = await post('/admin/api/moveCourse', { id: brunch.id, dir: -1 }, A); check(res.body.courses[3].id === brunch.id, 'move');
  res = await post('/admin/api/toggleCourse', { id: brunch.id, visible: false }, A); check(!res.body.courses[3].visible, 'toggle');
  // day rules
  res = await post('/admin/api/setDay', { date: sat, kind: 'open', sessions: ['lunch'] }, A); check(res.body.ok, 'setDay');
  res = await post('/admin/api/month', { ym: sat.slice(0, 7) }, A);
  const dd = res.body.days.find(d => d.date === sat); check(dd.plan.custom && dd.plan.sessions.join() === 'lunch' && dd.blocks === 2, 'month');
  res = await req({ ...base, name: '佐藤 太郎', time: '19:00' }, auth2); check(res.body.message.includes('承っていません'), 'dinner closed by rule');
  res = await post('/admin/api/setDay', { date: sat, revert: true }, A);
  // weekly
  const s4 = JSON.parse(JSON.stringify(s)); s4.weekly['1'] = ['dinner'];
  res = await post('/admin/api/saveSettings', s4, A); check(res.body.settings.weekly['1'].join() === 'dinner', 'weekly');
  // phone add + upcoming + quota
  res = await post('/admin/api/addPhone', { date: sat, time: '18:30', guests: 30, name: '電話' }, A); check(res.body.full, 'phone full');
  res = await post('/admin/api/addPhone', { date: sat, time: '12:30', guests: 2, name: '電話 次郎', source: 'Instagram' }, A); check(res.body.ok, 'phone add');
  res = await post('/admin/api/upcoming', {}, A); check(res.body.list.length >= 2, 'upcoming');
  res = await post('/admin/api/deleteBlock', { id: blk.id }, A); check(res.body.ok, 'del block');
  res = await post('/admin/api/quota', {}, A); check(res.body.quota.ok && res.body.quota.limit === 200, 'quota');
  // admin cancel with notify
  pushes.length = 0;
  res = await post('/admin/api/cancel', { id: rid2, text: 'お取り消しします' }, A); check(res.body.ok && pushes.length === 1, 'admin cancel');
  // max active
  for (let i = 0; i < 3; i++) {
    const d = add(sat, 7 * (i + 1));
    const r3 = await req({ ...base, name: '佐藤 太郎', date: d }, auth2);
    if (i < 3) check(r3.body.ok || r3.body.message, 'multi');
  }
  res = await req({ ...base, name: '佐藤 太郎', date: add(sat, 35) }, auth2); check(res.body.message.includes('上限'), 'max active ' + res.body.message);
  // ===== 予約の変更 =====
  const sun = add(sat, 1);
  res = await req({ ...base, date: sun, time: '18:00', guests: 2 }, auth);
  check(res.body.ok, 'edit: request ' + res.body.message);
  const eid = res.body.reservation.id;
  res = await post('/admin/api/reply', { id: eid, mode: 'ok', text: '確定' }, A); check(res.body.ok, 'edit: approve');
  const dayOf = async d => (await post('/admin/api/day', { date: d }, A)).body;
  let item = (await dayOf(sun)).reservations.find(x => x.id === eid);
  check(item.updatedAt, 'edit: updatedAt in view');
  const E = (o) => post('/admin/api/edit', Object.assign({ id: eid, updatedAt: item.updatedAt, date: item.date, time: item.time, guests: item.guests, courseId: item.courseId, name: item.name, phone: item.phone, note: item.note }, o), A);
  // 名前だけ → LINEは送らない
  pushes.length = 0;
  res = await E({ name: '山田 花子（修正）' }); check(res.body.ok && !res.body.sent && pushes.length === 0, 'edit: name only no push');
  item = (await dayOf(sun)).reservations.find(x => x.id === eid);
  check(item.name === '山田 花子（修正）', 'edit: name saved');
  // 文面なしで時間変更 → エラー
  res = await E({ time: '19:00' }); check(res.body.message && res.body.message.includes('文面'), 'edit: text required');
  // 時間と人数を変更 → LINEを送る
  res = await E({ time: '19:00', guests: 3, text: '変更しました' });
  check(res.body.ok && res.body.sent && pushes.length === 1 && pushes[0].to === 'U_hana' && pushes[0].messages[1].type === 'template', 'edit: push on change');
  item = (await dayOf(sun)).reservations.find(x => x.id === eid);
  check(item.time === '19:00' && item.guests === 3 && item.holdTime === '19:00', 'edit: saved time/guests/hold');
  // 古い更新日時 → 失敗
  res = await post('/admin/api/edit', { id: eid, updatedAt: '2000-01-01 00:00', date: sun, time: '19:00', guests: 3, name: 'x', courseId: item.courseId, text: 'x' }, A);
  check(res.status === 409, 'edit: stale 409');
  // 休みの日 → 変更できない
  res = await E({ date: nextWd(add(sun, 1), 2), time: '18:00', text: 'x' }); check(res.body.message.includes('営業していません'), 'edit: closed day ' + res.body.message);
  // 過去 → 変更できない
  res = await E({ date: add(T, -1), text: 'x' }); check(res.body.message.includes('過ぎた'), 'edit: past');
  // 席が足りない → 確認 → 強制で保存
  res = await E({ guests: 40, text: 'x' }); check(res.body.confirm && res.body.message.includes('席数'), 'edit: seats confirm');
  // メニューが時間帯に合わない → 確認
  res = await E({ time: '12:00', courseId: courses['季節の薬膳フレンチ'].id, text: 'x' }); check(res.body.confirm && res.body.message.includes('ランチ'), 'edit: course session warn');
  // 送信に失敗 → 保存しない
  setFailPush(true);
  res = await E({ date: add(sun, 7), text: '日付変更' }); check(res.body.message.includes('保存していません'), 'edit: push fail');
  setFailPush(false);
  item = (await dayOf(sun)).reservations.find(x => x.id === eid); check(item && item.date === sun, 'edit: not saved on push fail');
  // 日付変更 → 新しい日に移る
  pushes.length = 0;
  res = await E({ date: add(sun, 7), text: '日付変更', force: true });
  check(res.body.ok && res.body.date === add(sun, 7) && pushes.length === 1, 'edit: date moved');
  check(!(await dayOf(sun)).reservations.some(x => x.id === eid) && (await dayOf(add(sun, 7))).reservations.some(x => x.id === eid), 'edit: moved day');
  const mineNow = (await post('/api/init', {}, auth)).body.data.mine.find(x => x.id === eid);
  check(mineNow && mineNow.date === add(sun, 7) && mineNow.guests === 3, 'edit: customer sees change');
  // 電話予約 → LINEは送らない
  res = await post('/admin/api/addPhone', { date: sun, time: '12:00', guests: 2, name: '電話 三郎' }, A);
  const ph = (await dayOf(sun)).reservations.find(x => x.name === '電話 三郎');
  pushes.length = 0;
  res = await post('/admin/api/edit', { id: ph.id, updatedAt: ph.updatedAt, date: sun, time: '12:30', guests: 4, courseId: '', name: ph.name, phone: '', note: '' }, A);
  check(res.body.ok && !res.body.sent && pushes.length === 0, 'edit: phone no push');
  // 確定以外は変更できない
  res = await post('/admin/api/cancel', { id: ph.id, text: '' }, A);
  res = await post('/admin/api/edit', { id: ph.id, date: sun, time: '12:30', guests: 4, name: 'x' }, A);
  check(res.body.message.includes('確定した予約だけ'), 'edit: only confirmed');
  // ===== お客様からの予約変更リクエスト =====
  const cd = add(sat, 14);
  res = await req({ ...base, date: cd, time: '18:00', guests: 2 }, auth); check(res.body.ok, 'chg: request ' + res.body.message);
  const cres = res.body.reservation.id;
  res = await post('/admin/api/reply', { id: cres, mode: 'ok', text: '確定' }, A); check(res.body.ok, 'chg: approve');
  let mine = (await post('/api/init', {}, auth)).body.data.mine.find(x => x.id === cres);
  check(mine.canChange === true && mine.changeRule.days === 2, 'chg: canChange ' + JSON.stringify(mine.changeRule));
  const CH = (o, h = auth) => post('/api/change', { data: Object.assign({ id: cres, date: cd, time: '19:00', guests: 3, courseId: courses['季節の薬膳フレンチ'].id }, o) }, h);
  res = await CH({}, auth2); check(res.status === 404, 'chg: other user');
  res = await CH({ time: '18:00', guests: 2 }); check(res.body.message.includes('今と同じ'), 'chg: same content');
  res = await CH({ date: nextWd(add(T, 3), 2) }); check(res.body.message.includes('承っていません'), 'chg: closed day ' + JSON.stringify(res.body));
  res = await CH({ courseId: courses['養生ランチ'].id }); check(res.body.message.includes('時間帯'), 'chg: course session');
  pushes.length = 0;
  res = await CH({}); check(res.body.ok, 'chg: create ' + res.body.message);
  check(pushes.length === 1 && pushes[0].to === 'Uowner' && pushes[0].messages[0].text.includes('予約変更のリクエスト'), 'chg: owner push');
  mine = res.body.data.mine.find(x => x.id === cres);
  check(mine.change && mine.change.time === '19:00' && mine.canChange === false, 'chg: pending shown');
  check(res.body.data.holds.some(h => h.id === cres && h.time === '18:00') && res.body.data.holds.some(h => h.id.startsWith('G') && h.time === '19:00' && h.guests === 3), 'chg: both slots held');
  res = await CH({ time: '19:30' }); check(res.body.message.includes('お申し込み中'), 'chg: only one pending');
  // 管理画面に表示される
  let q = (await post('/admin/api/requests', {}, A)).body.requests;
  check(q.changes.length === 1 && q.changes[0].oldTime === '18:00' && q.changes[0].time === '19:00' && q.changes[0].left >= 3, 'chg: admin list ' + JSON.stringify(q.changes[0] || {}));
  const cid = q.changes[0].id;
  let dayv = (await post('/admin/api/day', { date: cd }, A)).body;
  check(dayv.changes.length === 1, 'chg: day view');
  // お断り → 元の予約のまま、席は戻る
  pushes.length = 0;
  res = await post('/admin/api/replyChange', { id: cid, mode: 'ng', text: 'お断りします' }, A);
  check(res.body.ok && pushes.length === 1 && pushes[0].to === 'U_hana', 'chg: ng push');
  mine = (await post('/api/init', {}, auth)).body.data.mine.find(x => x.id === cres);
  check(mine.time === '18:00' && !mine.change && mine.canChange === true, 'chg: after ng');
  // もう一度 → 承認 → 予約が移動
  res = await CH({}); check(res.body.ok, 'chg: create 2');
  const cid2 = (await post('/admin/api/requests', {}, A)).body.requests.changes[0].id;
  pushes.length = 0;
  res = await post('/admin/api/replyChange', { id: cid2, mode: 'ok', text: '変更を承りました' }, A);
  check(res.body.ok && pushes.length === 1 && pushes[0].messages[1].type === 'template', 'chg: ok push');
  mine = (await post('/api/init', {}, auth)).body.data.mine.find(x => x.id === cres);
  check(mine.time === '19:00' && mine.guests === 3 && !mine.change, 'chg: moved ' + mine.time + mine.guests);
  dayv = (await post('/admin/api/day', { date: cd }, A)).body;
  check(dayv.reservations.filter(x => x.id === cres && x.time === '19:00').length === 1 && dayv.changes.length === 0, 'chg: day after ok');
  res = await post('/admin/api/replyChange', { id: cid2, mode: 'ok', text: 'x' }, A); check(res.body.message.includes('返事済み'), 'chg: double reply');
  // 取り下げ
  res = await CH({ time: '18:30', guests: 2 }); check(res.body.ok, 'chg: create 3');
  const cid3 = (await post('/admin/api/requests', {}, A)).body.requests.changes[0].id;
  pushes.length = 0;
  res = await post('/api/cancelChange', { id: cid3 }, auth); check(res.body.ok && !res.body.data.mine[0].change, 'chg: withdraw');
  check(pushes.length === 2 && pushes.some(p => p.to === 'Uowner' && p.messages[0].text.includes('取り下げ')) &&
    pushes.some(p => p.to === 'U_hana' && p.messages[0].text.includes('取り下げ')), 'chg: withdraw push');
  // 予約をキャンセルすると、変更リクエストも取り下げ
  res = await CH({ time: '18:30', guests: 2 }); check(res.body.ok, 'chg: create 4');
  res = await post('/api/cancel', { id: cres }, auth); check(res.body.ok, 'chg: cancel reservation');
  q = (await post('/admin/api/requests', {}, A)).body.requests; check(q.changes.length === 0, 'chg: withdrawn with cancel');
  // 変更締切：メニューごと（ランチは1日前）
  const lunchC = (await post('/admin/api/courses', {}, A)).body.courses.find(c => c.name === '養生ランチ');
  check(lunchC.chg_mode === 'custom' && lunchC.chg_days === 1, 'chg: seed lunch rule');
  res = await post('/admin/api/saveCourse', Object.assign({}, lunchC, { chg_mode: 'custom', chg_days: 0, chg_time: '09:00' }), A);
  check(res.body.courses.find(c => c.name === '養生ランチ').chg_days === 0, 'chg: save course rule');
  // 締切超過
  const soonDate = [add(T, 1), add(T, 2), add(T, 3)].find(d => ![1, 2].includes(wd(d)));
  res = await req({ ...base, date: soonDate, time: '12:00', guests: 2, courseId: lunchC.id }, auth);
  if (res.body.ok) {
    const rid3 = res.body.reservation.id;
    await post('/admin/api/reply', { id: rid3, mode: 'ok', text: 'ok' }, A);
    const m3 = (await post('/api/init', {}, auth)).body.data.mine.find(x => x.id === rid3);
    check(m3.changeRule.days === 0 && m3.changeRule.time === '09:00', 'chg: course rule applied');
    res = await post('/api/change', { data: { id: rid3, date: add(soonDate, 7), time: '12:00', guests: 2, courseId: lunchC.id } }, auth);
    check(res.body.ok || res.body.message.includes('変更受付は終了'), 'chg: deadline ' + res.body.message);
  }
  // scheduled
  const sched = await env.mf.getWorker().then(w => w.scheduled({ cron: '0 * * * *' }));
  check(sched.outcome === 'ok', 'scheduled ' + JSON.stringify(sched));
  // lockout
  for (let i = 0; i < 5; i++) await post('/admin/api/login', { password: 'x' + i });
  res = await post('/admin/api/login', { password: 'pw-test-123' }); check(res.status === 429, 'lockout');
  console.log('ALL OK', ok, 'checks');
} catch (e) {
  console.error('FAIL', e.stack);
  process.exitCode = 1;
} finally {
  await env.stop();
}
