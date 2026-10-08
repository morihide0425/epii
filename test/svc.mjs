// Claude・Square・マネーフォワードの連携のテスト（仮のサーバーで動かす）
import assert from 'node:assert';
import { start, pushes } from './env.mjs';
import { startSvcMock, calls, journals, opts, SVC_ENV } from './svcmock.mjs';
const B = 'http://127.0.0.1:8787';
const mock = startSvcMock(8841);
const env = await start({ extra: Object.assign(SVC_ENV(8841), { WEEKLY_ANY_DAY: '1' }) });
const db = await env.mf.getD1Database('DB');
const jst = () => new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
const add = (s, n) => { const d = new Date(s + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const wd = s => new Date(s + 'T00:00:00Z').getUTCDay();
const T = jst();
const post = async (path, body, headers = {}) => { const r = await fetch(B + path, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body || {}) }); return { status: r.status, body: await r.json() }; };
const wait = async (fn, ms = 4000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await fn()) return true; await new Promise(r => setTimeout(r, 50)); } return false; };
let ok = 0; const check = (c, m) => { assert(c, m); ok++; };
try {
  // お客様のリクエスト → 裏で返事の下書きを用意する（電話番号は Claude に送らない）
  let res = await post('/api/login', { idToken: 'hana' });
  const auth = { authorization: 'Bearer ' + res.body.token };
  const courses = Object.fromEntries(res.body.data.courses.map(c => [c.name, c]));
  let sat = add(T, 5); while (wd(sat) !== 6) sat = add(sat, 1);
  res = await post('/api/request', { data: { date: sat, time: '18:00', guests: 2, courseId: courses['季節の薬膳フレンチ'].id, sei: '山田', mei: '花子', phone: '090-1234-5678', note: '結婚記念日です。くるみアレルギー。連絡は080-9999-8888へ' } }, auth);
  check(res.body.ok, 'request');
  const rid = res.body.reservation.id;
  check(await wait(() => calls.ai.length === 1), 'warm reply called');
  const first = JSON.stringify(calls.ai[0].body);
  check(!first.includes('1234-5678') && !first.includes('9999') && !first.includes('山田') && !first.includes('花子'), 'no phone/name sent ' + first.slice(0, 300));
  check(first.includes('（電話番号）') && first.includes('結婚記念日'), 'note scrubbed but kept');
  check(calls.ai[0].body.model === 'claude-opus-5-5' && calls.ai[0].body.output_config.effort === 'low' && calls.ai[0].body.output_config.format.type === 'json_schema', 'model/effort/schema');
  check(calls.ai[0].headers['anthropic-beta'] === 'server-side-fallback-2026-07-01' && calls.ai[0].body.fallbacks === 'default', 'fallback opt-in');

  // 管理画面
  res = await post('/admin/api/login', { password: 'pw-test-123' });
  const r0 = await fetch(B + '/admin/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: 'pw-test-123' }) });
  const A = { cookie: r0.headers.get('set-cookie').split(';')[0], 'x-epii': '1' };
  res = await post('/admin/api/boot', {}, A);
  check(res.body.features.ai && res.body.features.square && res.body.features.mf, 'features');
  res = await post('/admin/api/aiReply', { kind: 'r', id: rid, mode: 'ok' }, A);
  check(res.body.add.includes('｜') && res.body.add.includes('おめでとう'), 'draft add ' + res.body.add);
  check(calls.ai.length === 1, 'draft served from cache');
  res = await post('/admin/api/aiReply', { kind: 'r', id: rid, mode: 'ng' }, A);
  check(calls.ai.length === 2 && res.body.add.includes('申し訳'), 'other mode generates');
  res = await post('/admin/api/aiReply', { kind: 'r', id: rid, mode: 'ok', fresh: true, before: 'x' }, A);
  check(calls.ai.length === 3 && JSON.stringify(calls.ai[2].body).includes('前に考えた案'), 'rewrite asks for variation');

  // 来店前メモ：前に来たことがあるお客様（同じ電話番号）の今日の予約
  const past = add(T, -20);
  await db.prepare("INSERT INTO reservations (id, created_at, updated_at, status, date, time, session, guests, name, phone, course_id, course_name, note, hold_date, hold_time, hold_session, source, memo, arrived) VALUES ('RP1', ?, ?, '確定', ?, '12:00', 'lunch', 2, '佐藤 恵', '09011112222', '', '養生ランチ', '辛いもの苦手', ?, '12:00', 'lunch', '電話', '', 'yes')").bind(past + ' 10:00', past + ' 10:00', past, past).run();
  await db.prepare("INSERT INTO reservations (id, created_at, updated_at, status, date, time, session, guests, name, phone, course_id, course_name, note, hold_date, hold_time, hold_session, source, memo) VALUES ('RT1', ?, ?, '確定', ?, '11:30', 'lunch', 2, '佐藤 恵', '09011112222', '', '養生ランチ', '', ?, '11:30', 'lunch', '電話', '')").bind(T + ' 08:00', T + ' 08:00', T, T).run();
  res = await post('/admin/api/day', { date: T }, A);
  check(res.body.aiMissing.includes('RT1') && !Object.keys(res.body.aiMemos).length, 'memo missing ' + JSON.stringify(res.body.aiMissing));
  res = await post('/admin/api/aiMemos', { date: T }, A);
  check(res.body.memos.RT1 && res.body.memos.RT1.includes('2回目'), 'memo made');
  const memoCall = JSON.stringify(calls.ai[calls.ai.length - 1].body);
  check(!memoCall.includes('09011112222') && !memoCall.includes('佐藤') && memoCall.includes('辛いもの苦手'), 'memo has history, no name/phone');
  res = await post('/admin/api/day', { date: T }, A);
  check(res.body.aiMemos.RT1 && !res.body.aiMissing.length, 'memo cached in day');

  // Square：今日の売上と、予約のない会計
  res = await post('/admin/api/sales', {}, A);
  check(res.body.connected && res.body.day === T && res.body.count === 3, 'sales today ' + JSON.stringify(res.body).slice(0, 300));
  check(res.body.total === 9600 + 4800 + 9600, 'total ' + res.body.total);
  // 11:30〜13:00 の予約（RT1）には 12:55 の会計が結びつく
  check(res.body.resCount === 1 && res.body.withRes === 9600, 'matched to reservation ' + res.body.resCount);
  const open = res.body.open;
  check(open.length >= 2 && open.every(p => p.amount > 0), 'open list ' + open.length);
  const sqCalls = calls.sq.length;
  res = await post('/admin/api/sales', {}, A);
  check(calls.sq.length === sqCalls, 'sales cached for 2 min');
  const today2 = open.filter(p => p.date === T);
  res = await post('/admin/api/salesLink', { id: today2[0].id, action: 'new', name: '田中 美咲' }, A);
  check(res.body.key && !res.body.sales.open.some(p => p.id === today2[0].id), 'linked new customer');
  let cust = await post('/admin/api/customer', { key: res.body.key }, A);
  check(cust.body.extra === 1 && cust.body.name === '田中 美咲', 'new customer visit ' + JSON.stringify([cust.body.extra, cust.body.name]));
  const custKey = res.body.key;
  res = await post('/admin/api/salesLink', { id: today2[0].id, action: 'undo' }, A);
  cust = await post('/admin/api/customer', { key: custKey }, A);
  check(cust.body.extra === 0 && res.body.sales.open.some(p => p.id === today2[0].id), 'undo');
  res = await post('/admin/api/salesLink', { id: today2[0].id, action: 'res' }, A);
  check(res.body.sales.resCount === 2, 'marked as reservation payment');
  res = await post('/admin/api/salesLink', { id: today2[1].id, action: 'skip' }, A);
  check(!res.body.sales.open.some(p => p.id === today2[1].id) && res.body.sales.walkCount === 1, 'skip keeps walk-in');
  res = await post('/admin/api/salesLink', { id: today2[1].id, action: 'skip' }, A);
  check(res.status === 400, 'cannot link twice');

  // 売上・経費の分析
  res = await post('/admin/api/money', { period: 'last' }, A);
  check(res.body.hasSales && res.body.hasExpense && res.body.now.sales > 0 && res.body.now.expense > 0, 'money last ' + JSON.stringify(res.body.now));
  check(res.body.months.length === 6 && res.body.expenses[0].name === '仕入高', 'months/expenses');
  check(res.body.now.food === res.body.expenses[0].value, 'food = 仕入高');
  res = await post('/admin/api/money', { period: 'month' }, A);
  check(res.body.period.key === 'month' && res.body.now.payments > 0, 'money month');
  res = await post('/admin/api/moneyAi', {}, A);
  check(res.body.insight.items.length === 3 && res.body.insight.items[0].todo.includes('｜'), 'insight');
  const moneyCall = calls.ai[calls.ai.length - 1].body;
  check(moneyCall.output_config.effort === 'medium' && JSON.stringify(moneyCall).includes('月ごと') && !JSON.stringify(moneyCall).includes('090'), 'insight facts');
  res = await post('/admin/api/money', { period: '3m' }, A);
  check(res.body.insight && res.body.insight.items.length === 3, 'insight stored');

  // レシート：読み取り → 登録 → 取り消し
  const img = Buffer.from('fake-jpeg-data-for-test').toString('base64');
  res = await post('/admin/api/rcptList', {}, A);
  check(res.body.connected && res.body.list.count === 0, 'receipt list empty');
  res = await post('/admin/api/rcptRead', { image: img, type: 'image/jpeg' }, A);
  check(res.body.read.amount === 6480 && res.body.read.payee === '阿倍野青果' && res.body.read.unsure.includes('date'), 'read ' + JSON.stringify(res.body.read));
  const acc = res.body.accounts.find(a => a.name === '仕入高');
  check(res.body.read.accountId === acc.id && res.body.pays.some(p => p.name === '現金'), 'account & pays');
  check(calls.ai[calls.ai.length - 1].body.messages[0].content[0].type === 'image', 'image sent');
  const rd = res.body.read;
  res = await post('/admin/api/rcptSave', { date: rd.date, amount: '6,480', payee: rd.payee, memo: rd.memo, accountId: rd.accountId, payId: rd.payId, rate: '8', payment: 'cash', image: img }, A);
  check(res.body.list.count === 1 && res.body.list.total === 6480 && res.body.attached && !res.body.check, 'saved ' + JSON.stringify(res.body).slice(0, 200));
  const j = journals[journals.length - 1];
  check(j.branches[0].debitor.tax_id === 'T3' && j.branches[0].debitor.value + j.branches[0].debitor.tax_value === 6480 && j.branches[0].creditor.account_id === rd.payId, 'journal body');
  check(calls.mf.some(c => c.startsWith('GET /journals/NEW')), 'verified by GET');
  res = await post('/admin/api/rcptSave', { date: rd.date, amount: 3300, payee: 'ホームセンター', accountId: res.body.list.items[0] && acc.id, payId: rd.payId, rate: 'mixed', amount8: 1100 }, A);
  const j2 = journals[journals.length - 1];
  check(j2.branches.length === 2 && j2.branches[1].debitor.tax_id === 'T2', 'mixed rates');
  res = await post('/admin/api/rcptUndo', { id: res.body.list.items[0].id }, A);
  check(res.body.list.count === 1 && !journals.includes(j2), 'undo deletes journal');
  res = await post('/admin/api/rcptSave', { date: 'x', amount: 1, accountId: acc.id, payId: rd.payId }, A);
  check(res.status === 400, 'bad date');
  const big = 'A'.repeat(30000);
  res = await post('/admin/api/addCustomer', { name: big }, A);
  check(res.status === 400 && res.body.message.includes('大きすぎ'), 'normal api keeps small limit');

  // Instagram
  res = await post('/admin/api/igOpenings', {}, A);
  check(Array.isArray(res.body.openings), 'openings');
  res = await post('/admin/api/igDraft', { date: 'free', kind: 'story' }, A);
  check(res.body.draft.story.includes('｜') && !res.body.draft.post && res.body.style.length === 3, 'ig story only');
  const igCall = calls.ai[calls.ai.length - 1].body;
  check(Array.isArray(igCall.system) && igCall.system[1].cache_control && igCall.output_config.effort === 'low', 'captions cached on Claude side');
  res = await post('/admin/api/igDraft', { date: 'free', kind: 'post' }, A);
  check(res.body.draft.post.includes('#') && res.body.draft.story && res.body.style.length === 3, 'ig post added, story kept');
  check(JSON.stringify(calls.ai[calls.ai.length - 1].body).includes('style は空の配列でよい'), 'style read once');
  const story1 = res.body.draft.story;
  res = await post('/admin/api/igDraft', { date: 'free', kind: 'story', before: story1 }, A);
  check(res.body.draft.story !== story1 && res.body.draft.post.includes('#'), 'rewrite only story');
  res = await post('/admin/api/igSave', { date: 'free', kind: 'post', text: '手で直した文 #épii' }, A);
  check(res.body.draft.post === '手で直した文 #épii' && res.body.draft.edited.post, 'edit saved');
  res = await post('/admin/api/igSave', { date: 'free', kind: 'reel', remove: true }, A);
  res = await post('/admin/api/igSave', { date: 'free', kind: 'story', remove: true }, A);
  res = await post('/admin/api/igOpenings', {}, A);
  check(res.body.drafts.free.post === '手で直した文 #épii' && !res.body.drafts.free.story && res.body.style.length === 3, 'openings keep edits/deletes');

  // Claude が混み合っているとき
  opts.aiFail = 1;
  res = await post('/admin/api/aiReply', { kind: 'r', id: rid, mode: 'ok', fresh: true }, A);
  check(res.status === 502 && res.body.message.includes('混み合って'), 'overloaded message');

  // 変更のリクエストにも、裏で下書きを用意する
  res = await post('/admin/api/reply', { id: rid, mode: 'ok', text: 'ok' }, A);
  check(res.body.ok, 'approved');
  const n2 = calls.ai.length;
  res = await post('/api/change', { data: { id: rid, date: sat, time: '19:00', guests: 2, courseId: courses['季節の薬膳フレンチ'].id } }, auth);
  check(res.body.ok, 'change ' + JSON.stringify(res.body));
  check(await wait(() => calls.ai.length === n2 + 1), 'warm change reply');
  const gtext = JSON.stringify(calls.ai[calls.ai.length - 1].body);
  check(gtext.includes('ご予約の変更の承認') && gtext.includes('変更のご希望') && !gtext.includes('5678'), 'change facts');
  const req = await post('/admin/api/requests', {}, A);
  const gid = req.body.requests.changes[0].id;
  const n3 = calls.ai.length;
  res = await post('/admin/api/aiReply', { kind: 'g', id: gid, mode: 'ok' }, A);
  check(calls.ai.length === n3 && typeof res.body.add === 'string', 'change draft cached');

  // 週のまとめ（定期実行から）
  pushes.length = 0;
  const sc = await fetch(B + '/cdn-cgi/mf/scheduled');
  check(sc.ok, 'scheduled');
  check(await wait(() => pushes.some(p => p.messages[0].text.includes('先週のまとめ')), 8000), 'weekly pushed');
  const wk = pushes.find(p => p.messages[0].text.includes('先週のまとめ')).messages[0].text;
  check(calls.ai.filter(c => c.body.system.includes('相談役')).pop().body.output_config.effort === 'high', 'weekly thinks harder');
  check(wk.includes('売上 ¥') && wk.includes('今週やること') && !wk.includes('｜') && wk.includes('1. 土曜ディナー'), 'weekly text\n' + wk);
  pushes.length = 0;
  await fetch(B + '/cdn-cgi/mf/scheduled');
  await new Promise(r => setTimeout(r, 1500));
  check(!pushes.some(p => p.messages[0].text.includes('先週のまとめ')), 'weekly once');
  console.log(wk);
  console.log('ALL OK', ok, 'checks');
} catch (e) {
  console.error('FAILED after', ok, 'checks:', e.message);
  process.exitCode = 1;
} finally {
  await env.stop();
  mock.close();
}
