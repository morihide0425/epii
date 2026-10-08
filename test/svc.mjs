// Claude・Square・マネーフォワードの連携のテスト（仮のサーバーで動かす）
import assert from 'node:assert';
import { start, pushes } from './env.mjs';
import { startSvcMock, calls, journals, txs, opts, SVC_ENV } from './svcmock.mjs';
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
  const openOf = x => x.pays.filter(p => p.link === '');
  const open = openOf(res.body);
  check(open.length === 2 && open.every(p => p.amount > 0) && res.body.pays.length === 3, 'open list ' + open.length);
  check(res.body.resv.length === 1 && res.body.resv[0].name === '佐藤 恵' && res.body.resv[0].paid === 9600 && res.body.pays.find(p => p.link === 'auto').resName === '佐藤 恵', 'reservations as candidates');
  const sqCalls = calls.sq.length;
  res = await post('/admin/api/sales', {}, A);
  check(calls.sq.length === sqCalls, 'sales cached for 2 min');
  const today2 = open;
  res = await post('/admin/api/salesLink', { id: today2[0].id, action: 'new', name: '田中 美咲' }, A);
  check(res.body.key && !openOf(res.body.sales).some(p => p.id === today2[0].id) && res.body.sales.pays.find(p => p.id === today2[0].id).custName === '田中 美咲', 'linked new customer');
  let cust = await post('/admin/api/customer', { key: res.body.key }, A);
  check(cust.body.extra === 1 && cust.body.name === '田中 美咲', 'new customer visit ' + JSON.stringify([cust.body.extra, cust.body.name]));
  const custKey = res.body.key;
  // 間違えたら直せる：予約の会計に付け替えると、お客様の来店は1回戻る
  res = await post('/admin/api/salesLink', { id: today2[0].id, action: 'res', resId: 'RT1' }, A);
  cust = await post('/admin/api/customer', { key: custKey }, A);
  check(cust.body.extra === 0 && res.body.sales.resCount === 2 && res.body.sales.resGroups === 1 && res.body.sales.resv[0].paid > 9600, 're-link to reservation (split bill = 1 group)');
  res = await post('/admin/api/salesLink', { id: today2[0].id, action: 'res', resId: 'nope' }, A);
  check(res.status === 400, 'reservation required');
  res = await post('/admin/api/salesLink', { id: today2[0].id, action: 'undo' }, A);
  check(openOf(res.body.sales).some(p => p.id === today2[0].id), 'undo back to automatic');
  res = await post('/admin/api/salesLink', { id: today2[1].id, action: 'skip' }, A);
  check(!openOf(res.body.sales).some(p => p.id === today2[1].id) && res.body.sales.walkCount === 2 && res.body.sales.pays.find(p => p.id === today2[1].id).link === 'skip', 'skip keeps walk-in');
  // 割り勘：予約の会計の前後5分の会計は、同じ組にまとめる
  const db1 = await env.mf.getD1Database('DB');
  await db1.prepare("INSERT INTO sq_payments (id, ts, date, amount, refunded, tip, method, status, link) VALUES ('PX1', ?, ?, 3000, 0, 0, 'カード', 'COMPLETED', '')").bind(T + ' 12:57', T).run();
  await db1.prepare("DELETE FROM kv WHERE k = 'sqMonths'").run();
  res = await post('/admin/api/sales', {}, A);
  const px = res.body.pays.find(p => p.id === 'PX1');
  check(px && px.link === 'auto' && px.resName === '佐藤 恵' && res.body.resGroups === 1 && res.body.resCount === 2, 'split bill auto ' + JSON.stringify(px));

  // CSVの書き出し
  await db1.prepare("UPDATE reservations SET note = '=1+1, \"夜\"' WHERE id = 'RT1'").run();
  res = await post('/admin/api/exportCsv', { kind: 'customers' }, A);
  let lines = res.body.csv.split('\r\n');
  check(res.body.name.startsWith('お客様一覧_') && lines[0].startsWith('お名前,電話番号,来店回数') && lines[0].endsWith('会計の合計（Square）'), 'customers csv head ' + lines[0]);
  const sato = lines.find(l => l.startsWith('佐藤 恵,'));
  check(sato && sato.includes('090-1111-2222') && sato.includes(',' + past + ',') && sato.endsWith(',12600'), 'customers csv row ' + sato);
  check(sato.includes('"\'=1+1, ""夜"" / 辛いもの苦手"'), 'csv escaping ' + sato);
  res = await post('/admin/api/exportCsv', { kind: 'customers', keys: [custKey] }, A);
  check(res.body.count === 1 && res.body.csv.split('\r\n')[1].startsWith('田中 美咲,'), 'customers csv filtered');
  res = await post('/admin/api/exportCsv', { kind: 'reservations', from: T, to: T }, A);
  lines = res.body.csv.split('\r\n');
  const rt1 = lines.find(l => l.includes('佐藤 恵'));
  check(res.body.count === 1 && lines[0].startsWith('予約日,曜日,時間,時間帯,状態,来店') && rt1.startsWith(T + ',') && rt1.includes(',ランチ,確定,予定,佐藤 恵,090-1111-2222,2,') && rt1.endsWith(',12600'), 'reservations csv ' + rt1);
  res = await post('/admin/api/exportCsv', { kind: 'reservations' }, A);
  check(res.body.count >= 3 && res.body.name.includes('すべて') && res.body.csv.includes(past + ',') && res.body.csv.includes(',来店,'), 'reservations csv all');
  await db1.prepare("UPDATE reservations SET note = '' WHERE id = 'RT1'").run();

  // 売上・経費の分析
  res = await post('/admin/api/money', { period: 'last' }, A);
  check(res.body.hasSales && res.body.hasExpense && res.body.now.sales > 0 && res.body.now.expense > 0, 'money last ' + JSON.stringify(res.body.now));
  check(res.body.months.length === 6 && res.body.expenses[0].name === '仕入高', 'months/expenses');
  check(res.body.now.food === res.body.expenses[0].value, 'food = 仕入高');
  res = await post('/admin/api/money', { period: 'month' }, A);
  check(res.body.period.key === 'month' && res.body.now.payments > 0, 'money month');
  check(res.body.payees && res.body.payees.length >= 0, 'payees');
  const mfCalls = calls.mf.filter(c => c.startsWith('GET /journals?')).length;
  res = await post('/admin/api/money', { period: 'last' }, A);
  check(calls.mf.filter(c => c.startsWith('GET /journals?')).length === mfCalls, 'mf data kept on site');
  // 分析：分野ごとに Claude の気づき。前回の気づきを添えて続きとして考える
  res = await post('/admin/api/analysisAi', { section: 'money' }, A);
  check(res.body.insight.items.length === 2 && res.body.insight.items[0].title.includes('売上'), 'money section');
  let aiBody = JSON.stringify(calls.ai[calls.ai.length - 1].body);
  check(aiBody.includes('売上と経費だけ') && aiBody.includes('科目別') && !aiBody.includes('予約ページ（直近30日）') && !aiBody.includes('090'), 'money facts only');
  res = await post('/admin/api/aiNote', { text: '仕入れは主に阿倍野青果。電話は090-1111-2222' }, A);
  res = await post('/admin/api/analysisAi', { section: 'money' }, A);
  aiBody = JSON.stringify(calls.ai[calls.ai.length - 1].body);
  check(aiBody.includes('前回') && aiBody.includes('阿倍野青果') && !aiBody.includes('1111-2222'), 'previous items + owner note (no phone)');
  res = await post('/admin/api/analysisAi', { section: 'summary' }, A);
  check(res.body.insight.items.length === 3 && res.body.insight.items[0].todo.includes('｜'), 'summary');
  aiBody = JSON.stringify(calls.ai[calls.ai.length - 1].body);
  check(aiBody.includes('【売上と経費】') && aiBody.includes('【予約と予約ページ】') && aiBody.includes('【Instagram】'), 'summary sees all');
  res = await post('/admin/api/analysisAi', { section: 'booking' }, A);
  check(res.body.insight.items[0].title.includes('予約'), 'booking section');
  res = await post('/admin/api/dash', {}, A);
  check(res.body.money.hasSales && res.body.ai.summary.items.length === 3 && res.body.ai.money && res.body.ai.booking && res.body.note.includes('阿倍野青果') && res.body.booking, 'dash');
  res = await post('/admin/api/money', { period: '3m' }, A);
  check(res.body.insight && res.body.insight.items.length === 2, 'money insight from section');

  // レシート：読み取り → 登録（現金は仕訳を作る／デビットは口座の明細と結びつける）→ 取り消し
  const img = Buffer.from('fake-jpeg-data-for-test').toString('base64');
  res = await post('/admin/api/rcptList', {}, A);
  check(res.body.connected && res.body.list.count === 0 && res.body.list.idle === null, 'receipt list empty');
  res = await post('/admin/api/rcptRead', { image: img, type: 'image/jpeg' }, A);
  check(res.body.read.amount === 6480 && res.body.read.payee === '阿倍野青果' && res.body.read.unsure.includes('date') && res.body.read.invoiceNo === 'T1234567890123' && res.body.read.reason.includes('野菜'), 'read ' + JSON.stringify(res.body.read));
  const acc = res.body.accounts.find(a => a.name === '仕入高');
  check(res.body.read.accountId === acc.id && acc.help.includes('食材') && res.body.read.pay === 'cash' && res.body.pays.some(p => p.kind === 'debit') && res.body.pays.some(p => p.kind === 'own'), 'account help & pays');
  check(JSON.stringify(calls.ai[calls.ai.length - 1].body).includes('仕入高（料理に使う食材'), 'account help sent to Claude');
  check(calls.ai[calls.ai.length - 1].body.messages[0].content[0].type === 'image', 'image sent');
  const rd = res.body.read;
  res = await post('/admin/api/rcptSave', { date: rd.date, amount: '6,480', payee: rd.payee, memo: rd.memo, accountId: rd.accountId, pay: 'cash', rate: '8', payment: 'cash', invoiceNo: rd.invoiceNo, image: img }, A);
  check(res.body.list.count === 1 && res.body.list.total === 6480 && res.body.attached && !res.body.check && !res.body.waiting, 'saved ' + JSON.stringify(res.body).slice(0, 200));
  const j = journals[journals.length - 1];
  check(j.branches[0].debitor.tax_id === 'T3' && j.branches[0].debitor.value + j.branches[0].debitor.tax_value === 6480 && j.branches[0].creditor.account_id === 'A%3D5' && j.branches[0].debitor.invoice_kind === 'INVOICE_KIND_QUALIFIED' && j.memo.includes('T1234567890123'), 'cash journal ' + JSON.stringify(j));
  check(calls.mf.some(c => c.startsWith('GET /journals/NEW')), 'verified by GET');
  // デビットカード：口座の明細（¥6,580）があれば、それを仕訳にする（二重にならない）
  const nJ = journals.length;
  res = await post('/admin/api/rcptSave', { date: rd.date, amount: 6580, payee: '阿倍野青果', memo: '野菜', accountId: acc.id, pay: 'debit', rate: '8', payment: 'card', image: img }, A);
  check(!res.body.waiting && res.body.matched.includes('アベノセイカ') && res.body.attached, 'debit matched ' + JSON.stringify(res.body).slice(0, 200));
  check(journals.length === nJ + 1 && journals[journals.length - 1].transaction_id === 'TX%3D1' && txs[0].journalizing_status === 'registered', 'journalized the transaction, no duplicate');
  // 明細がまだないデビットの支払い：預かって、明細が届いたら登録する
  res = await post('/admin/api/rcptSave', { date: rd.date, amount: 4400, payee: 'ホームセンター', memo: '洗剤', accountId: res.body.list.items[0] && acc.id, pay: 'debit', rate: 'mixed', amount8: 1100, image: img }, A);
  check(res.body.waiting && res.body.list.waiting === 1 && res.body.list.items[0].status === 'wait', 'waiting for bank line');
  const nJ2 = journals.length;
  txs.push({ id: 'TX%3D9', date: rd.date, value: 4400, side: 'EXPENSE', content: 'VISAデビット ホームセンター', journalizing_status: 'none' });
  const db0 = await env.mf.getD1Database('DB');
  await db0.prepare("DELETE FROM kv WHERE k = 'rcptMatchAt'").run();
  res = await post('/admin/api/rcptList', {}, A);
  check(res.body.list.waiting === 0 && journals.length === nJ2 + 1, 'matched later');
  const jm = journals[journals.length - 1];
  check(jm.branches.length === 2 && jm.branches[0].debitor.tax_id === 'T3' && jm.branches[1].debitor.tax_id === 'T2' && jm.branches[1].creditor.account_id === 'A%3D9', 'mixed split after journalize ' + JSON.stringify(jm.branches));
  check(!(await db0.prepare('SELECT COUNT(*) AS n FROM receipt_photos').first()).n, 'photo deleted after match');
  res = await post('/admin/api/rcptUndo', { id: res.body.list.items[0].id }, A);
  check(!journals.includes(jm) && txs.find(t => t.id === 'TX%3D9').journalizing_status === 'none', 'undo returns bank line');
  res = await post('/admin/api/rcptSave', { date: 'x', amount: 1, accountId: acc.id, pay: 'cash' }, A);
  check(res.status === 400, 'bad date');
  // 明細が来ないとき：待たずに登録（普通預金）
  res = await post('/admin/api/rcptSave', { date: rd.date, amount: 777, payee: 'テスト', accountId: acc.id, pay: 'debit', rate: '10', image: img }, A);
  const wid = res.body.list.items.find(x => x.status === 'wait').id;
  res = await post('/admin/api/rcptForce', { id: wid }, A);
  check(res.body.list.waiting === 0 && journals[journals.length - 1].branches[0].creditor.account_id === 'A%3D9', 'force with bank account');
  const forcedJ = journals[journals.length - 1];
  check((await db0.prepare('SELECT COUNT(*) AS n FROM receipt_photos WHERE id = ?').bind(wid).first()).n === 1, 'forced keeps the photo for later');
  // そのあと明細が届いた：明細から仕訳を作り直し、先に作った仕訳は消す（二重にしない）
  txs.push({ id: 'TX%3D5', date: rd.date, value: 777, side: 'EXPENSE', content: 'VISAデビット テスト', journalizing_status: 'none' });
  res = await post('/admin/api/mfTx', { suggest: false }, A);
  check(res.body.list.find(t => t.id === 'TX%3D5').receipt, 'late bank line marked as receipt');
  const nJ5 = journals.length;
  await db0.prepare("DELETE FROM kv WHERE k = 'rcptMatchAt'").run();
  res = await post('/admin/api/rcptList', {}, A);
  const fj = journals.find(x => x.transaction_id === 'TX%3D5');
  check(journals.length === nJ5 && !journals.includes(forcedJ) && fj && txs.find(t => t.id === 'TX%3D5').journalizing_status === 'registered', 'late bank line replaces the forced journal');
  check(!(await db0.prepare('SELECT COUNT(*) AS n FROM receipt_photos WHERE id = ?').bind(wid).first()).n && calls.mf.some(c => c.startsWith('POST /vouchers')), 'photo moved to the new journal');
  // 現金を選んだのに同じ金額の口座の明細がある：デビットかどうか聞く
  txs.push({ id: 'TX%3D6', date: rd.date, value: 3300, side: 'EXPENSE', content: 'VISAデビット カネモト', journalizing_status: 'none' });
  const nJ6 = journals.length;
  res = await post('/admin/api/rcptSave', { date: rd.date, amount: 3300, payee: '金本商店', accountId: acc.id, pay: 'cash', rate: '8', image: img }, A);
  check(res.body.askDebit && res.body.askDebit.content.includes('カネモト') && journals.length === nJ6, 'ask if paid by debit ' + JSON.stringify(res.body).slice(0, 120));
  res = await post('/admin/api/rcptSave', { date: rd.date, amount: 3300, payee: '金本商店', accountId: acc.id, pay: 'debit', rate: '8', image: img }, A);
  check(res.body.matched && txs.find(t => t.id === 'TX%3D6').journalizing_status === 'registered' && journals.length === nJ6 + 1, 'answered debit -> linked');
  txs.push({ id: 'TX%3D10', date: rd.date, value: 2200, side: 'EXPENSE', content: 'ATM', journalizing_status: 'none' });
  res = await post('/admin/api/rcptSave', { date: rd.date, amount: 2200, payee: '雑貨店', accountId: acc.id, pay: 'cash', rate: '10', keepPay: true, image: img }, A);
  check(!res.body.askDebit && journals[journals.length - 1].branches[0].creditor.account_id === 'A%3D5', 'answered cash -> cash journal');
  txs.splice(txs.findIndex(t => t.id === 'TX%3D10'), 1);
  // まだ登録していない口座の明細：Claude が科目を提案 → そのまま登録
  res = await post('/admin/api/mfTx', {}, A);
  check(res.body.list.length >= 2 && res.body.list.every(t => t.amount > 0 && t.id.startsWith('TX')) && !res.body.list.some(t => t.content === 'ｽｸｴｱ'), 'unregistered bank lines ' + JSON.stringify(res.body.list.map(t => t.content)));
  const nt = res.body.list.find(t => t.id === 'TX%3D2');
  check(nt.ai && res.body.accounts.find(a => a.id === nt.ai.accountId).name === '通信費' && nt.ai.reason, 'suggested account');
  check(nt.sure && res.body.list.find(t => t.id === 'TX%3D3').sure, 'sure lines marked');
  const nAi = calls.ai.length;
  res = await post('/admin/api/mfTx', {}, A);
  check(calls.ai.length === nAi, 'suggestions cached');
  res = await post('/admin/api/mfTxSave', { id: nt.id, date: nt.date, content: nt.content, accountId: nt.ai.accountId, rate: nt.ai.rate }, A);
  check(txs.find(t => t.id === 'TX%3D2').journalizing_status === 'registered', 'bank line registered');
  // 自分のために使ったお金（国民年金など）は事業主貸。消費税なし、経費には入れない
  const pt = (await post('/admin/api/mfTx', {}, A)).body;
  const pen = pt.list.find(t => t.id === 'TX%3D11');
  const own = pt.accounts.find(a => a.personal);
  check(own && own.name === '事業主貸' && pen.ai.accountId === own.id && pen.ai.rate === 'none' && String(calls.ai[calls.ai.length - 1].body.system).includes('事業主貸'), 'personal suggested ' + JSON.stringify(pen.ai));
  res = await post('/admin/api/mfTxSave', { id: pen.id, date: pen.date, content: pen.content, accountId: own.id, rate: '10' }, A);
  const pj = journals.find(x => x.transaction_id === 'TX%3D11');
  check(pj && pj.branches[0].debitor.account_id === 'A%3D11' && !['T2', 'T3'].includes(pj.branches[0].debitor.tax_id), 'personal journal without tax ' + JSON.stringify(pj && pj.branches));
  // 先に口座の明細を登録してから、同じ支払いのレシートを撮った：新しい仕訳は作らず、登録済みの仕訳に写真と内容をまとめる
  const txj = journals.find(x => x.transaction_id === 'TX%3D2');
  const nJ3 = journals.length;
  const vouchers0 = calls.mf.filter(c => c.startsWith('POST /vouchers')).length;
  const tel = (await post('/admin/api/rcptRead', { image: img, type: 'image/jpeg' }, A)).body.accounts.find(a => a.name === '通信費');
  res = await post('/admin/api/rcptSave', { date: nt.date, amount: 5500, payee: 'NTT西日本', memo: '電話代', accountId: tel.id, pay: 'debit', rate: '10', invoiceNo: 'T9999999999999', image: img }, A);
  check(res.body.merged && !res.body.waiting && journals.length === nJ3 && calls.mf.filter(c => c.startsWith('POST /vouchers')).length === vouchers0 + 1, 'receipt after bank line: merged, no duplicate ' + JSON.stringify(res.body).slice(0, 160));
  check(txj.branches[0].remark === 'NTT西日本 電話代' && txj.branches[0].debitor.invoice_kind === 'INVOICE_KIND_QUALIFIED' && txj.branches[0].creditor.account_id === 'A%3D9', 'merged journal rewritten ' + JSON.stringify(txj.branches));
  // 同じ金額のレシートがもう1枚：その仕訳はもう使ったので、新しい明細を待つ
  res = await post('/admin/api/rcptSave', { date: nt.date, amount: 5500, payee: 'NTT西日本', memo: '電話代', accountId: tel.id, pay: 'debit', rate: '10', image: img }, A);
  check(res.body.waiting && journals.length === nJ3, 'same journal not used twice');
  const wid2 = res.body.list.items.find(x => x.status === 'wait').id;
  txs.push({ id: 'TX%3D8', date: nt.date, value: 5500, side: 'EXPENSE', content: 'NTTﾋｶﾞｼﾆﾎﾝ', journalizing_status: 'none' });
  res = await post('/admin/api/mfTxSave', { id: 'TX%3D8', date: nt.date, content: 'NTT', accountId: tel.id, rate: '10' }, A);
  const nJ4 = journals.length;
  res = await post('/admin/api/rcptForce', { id: wid2 }, A);
  check(res.body.matched && res.body.list.waiting === 0 && journals.length === nJ4, 'force finds the bank line registered meanwhile');
  // 現金で登録したレシートと同じ金額の明細には注意を出す
  txs.push({ id: 'TX%3D7', date: rd.date, value: 6480, side: 'EXPENSE', content: 'VISAデビット アベノセイカ', journalizing_status: 'none' });
  res = await post('/admin/api/mfTx', { suggest: false }, A);
  const dup = res.body.list.find(t => t.id === 'TX%3D7');
  check(dup && dup.dupe && dup.dupe.payee === '阿倍野青果', 'possible duplicate warned ' + JSON.stringify(dup));
  txs.splice(txs.findIndex(t => t.id === 'TX%3D7'), 1);
  // 分析のところで Claude と話す（数字は30分ごとにまとめ直し、Claude側にとっておいてもらう）
  res = await post('/admin/api/aiChat', { messages: [{ role: 'user', text: '先月と比べてどう？' }] }, A);
  check(res.body.answer.includes('売上') && res.body.remember === '', 'chat ' + JSON.stringify(res.body));
  const chatBody = calls.ai[calls.ai.length - 1].body;
  check(chatBody.system[1].cache_control && chatBody.system[1].text.includes('【売上と経費】') && chatBody.messages.length === 1, 'chat facts cached');
  res = await post('/admin/api/aiChat', { messages: [{ role: 'user', text: '先月と比べてどう？' }, { role: 'assistant', text: '前の答え' }, { role: 'user', text: '仕入れは市場で、毎週火曜にまとめて買っています' }] }, A);
  const chat2 = calls.ai[calls.ai.length - 1].body;
  check(chat2.messages.length === 3 && chat2.messages[1].role === 'assistant' && chat2.system[1].text === chatBody.system[1].text && res.body.remember.includes('火曜'), 'chat thread + remember');
  res = await post('/admin/api/aiNote', { text: '' }, A);
  res = await post('/admin/api/dash', {}, A);
  check(res.body.note === '' && res.body.noteAt === '', 'note cleared');

  // Claude に相談
  res = await post('/admin/api/aiAsk', { question: '洗剤は何の科目？', history: [{ q: '前の質問', a: '前の答え' }], context: { payee: 'ホームセンター', amount: 1100 } }, A);
  check(res.body.answer.includes('消耗品費') && res.body.account === '消耗品費' && res.body.accountId, 'ask');
  check(JSON.stringify(calls.ai[calls.ai.length - 1].body).includes('前の答え'), 'ask keeps the thread');
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
  check(calls.ai.filter(c => String(c.body.system).includes('相談役')).slice(-4).every(c => c.body.output_config.effort === 'high'), 'weekly makes all 4 sections, thinking harder');
  check(wk.includes('【経費の登録】') && wk.includes('まだ登録していないもの'), 'weekly expense reminder');
  check(wk.includes('売上 ¥') && wk.includes('今週やること') && !wk.includes('｜') && wk.includes('1. 土曜ディナー'), 'weekly text\n' + wk);
  pushes.length = 0;
  await fetch(B + '/cdn-cgi/mf/scheduled');
  await new Promise(r => setTimeout(r, 1500));
  check(!pushes.some(p => p.messages[0].text.includes('先週のまとめ')), 'weekly once');
  check(wk.includes('先週もおつかれさまでした') && String(calls.ai.find(c => String(c.body.system).includes('週のはじめに送るLINE')).body.messages[0].content[0].text).includes('売上'), 'weekly cheer');

  // 月の目標（利益で決める → 必要な売上・残りの営業日で1日あたり・予約なら何名）
  res = await post('/admin/api/goal', { save: true, on: true, kind: 'profit', amount: '300,000' }, A);
  const g = res.body.status;
  check(res.body.cfg.amount === 300000 && g.on && g.need > 300000 && g.openDays > 0 && g.trend.perGuest > 0, 'goal from profit ' + JSON.stringify(g).slice(0, 300));
  check(g.leftDays === 0 || (g.perDay > 0 && g.perDayGuests > 0 && g.perDay * g.leftDays >= g.remain), 'per remaining business day');
  check(g.breakEven > 0 && g.need === Math.ceil((300000 + g.trend.fixed) / (1 - g.trend.ratio) / 1000) * 1000, 'need = (profit + fixed) / (1 - food ratio)');
  res = await post('/admin/api/sales', {}, A);
  check(res.body.goal && res.body.goal.need === g.need, 'goal on today sales');
  res = await post('/admin/api/money', { period: 'month' }, A);
  check(res.body.goal && res.body.goal.on, 'goal on money');
  res = await post('/admin/api/analysisAi', { section: 'money' }, A);
  const mtext = calls.ai[calls.ai.length - 1].body.messages[0].content[0].text;
  check(mtext.includes('今月の目標：利益 ¥300,000') && mtext.includes('利益が出はじめる売上の目安') && mtext.includes('利益をどう増やすか'), 'profit and goal sent to Claude');
  res = await post('/admin/api/goalAdvice', {}, A);
  check(res.body.profit === 300000 && res.body.sales === 820000 && res.body.text.includes('目安'), 'goal advice ' + JSON.stringify(res));
  res = await post('/admin/api/goal', { save: true, on: false, kind: 'sales', amount: 900000 }, A);
  res = await post('/admin/api/sales', {}, A);
  check(!res.body.goal, 'goal off hides it');

  // 仕込みメモ：次の営業日の予約を、前の晩にお店のLINEへ（予約がなければ送らない）
  const day0 = (await post('/admin/api/prep', { preview: true }, A)).body;
  const nd = day0.preview.next;
  check(nd > T && wd(nd) !== 1 && wd(nd) !== 2, 'next business day ' + nd);
  const db2 = await env.mf.getD1Database('DB');
  await db2.prepare("DELETE FROM reservations WHERE date = ?").bind(nd).run();
  await db2.prepare("INSERT INTO reservations (id, created_at, updated_at, status, date, time, session, guests, name, phone, course_id, course_name, note, hold_date, hold_time, hold_session, source, memo) VALUES ('PP0', ?, ?, '確定', ?, '12:00', 'lunch', 2, '高橋 誠', '', '', '養生ランチ', '', ?, '12:00', 'lunch', '電話', '')").bind(T + ' 09:00', T + ' 09:00', add(nd, 7), add(nd, 7)).run();
  res = await post('/admin/api/prep', { preview: true }, A);
  check(res.body.preview.date > nd && res.body.preview.note.includes('次の営業日は予約がないので') && res.body.preview.text.startsWith('【仕込みメモ '), 'no reservations on next day: nearest day ' + JSON.stringify(res.body.preview).slice(0, 200));
  // これからの予約がひとつもない：見本のお客様で見せる（DBには入れない）
  await db2.prepare("UPDATE reservations SET status = '確定待避' WHERE status = '確定' AND date > ?").bind(T).run();
  res = await post('/admin/api/prep', { preview: true }, A);
  const sp = res.body.preview;
  check(sp.sample && sp.text.startsWith('【仕込みメモ（見本） ') && sp.text.includes('見本花子様 2名 養生ランチ') && sp.text.includes('見本太郎様 3名 季節の薬膳フレンチ') && sp.note.includes('見本のお客様') && sp.text.includes('くるみアレルギー'), 'sample preview\n' + sp.text);
  check(!JSON.stringify(calls.ai[calls.ai.length - 1].body).includes('見本花子'), 'sample names not sent');
  check(!(await db2.prepare("SELECT COUNT(*) AS n FROM reservations WHERE id LIKE 'sample%'").first()).n, 'sample not stored');
  await db2.prepare("UPDATE reservations SET status = '確定' WHERE status = '確定待避'").run();
  await db2.prepare("INSERT INTO reservations (id, created_at, updated_at, status, date, time, session, guests, name, phone, course_id, course_name, note, hold_date, hold_time, hold_session, source, memo) VALUES ('PP1', ?, ?, '確定', ?, '18:00', 'dinner', 2, '佐藤 恵', '09011112222', '', '季節の薬膳フレンチ', '結婚記念日。くるみアレルギー。090-1234-9999', ?, '18:00', 'dinner', 'LINE', '')").bind(T + ' 09:00', T + ' 09:00', nd, nd).run();
  await db2.prepare("INSERT INTO reservations (id, created_at, updated_at, status, date, time, session, guests, name, phone, course_id, course_name, note, hold_date, hold_time, hold_session, source, memo) VALUES ('PP2', ?, ?, '確定', ?, '11:30', 'lunch', 3, '鈴木 一郎', '', '', '養生ランチ', '', ?, '11:30', 'lunch', '電話', '')").bind(T + ' 09:00', T + ' 09:00', nd, nd).run();
  res = await post('/admin/api/prep', { preview: true }, A);
  const pv = res.body.preview.text;
  check(pv.startsWith('【仕込みメモ ') && pv.includes('ご予約 2組 5名') && pv.includes('11:30 鈴木 一郎様 3名 養生ランチ（初めて）') && pv.includes('18:00 佐藤 恵様 2名 季節の薬膳フレンチ（'), 'prep list\n' + pv);
  check(pv.includes('■ コースごとの人数') && pv.includes('季節の薬膳フレンチ 2名') && pv.includes('18:00 佐藤様：くるみアレルギー') && pv.includes('18:00 佐藤様：結婚記念日') && pv.includes('くるみを使わない皿を1名分') && pv.includes('今夜は早めに休んでくださいね') && !pv.includes('｜'), 'prep sections');
  const pbody = JSON.stringify(calls.ai[calls.ai.length - 1].body);
  check(!pbody.includes('佐藤') && !pbody.includes('鈴木') && !pbody.includes('1234-9999') && !pbody.includes('09011112222'), 'no names or phones to Claude');
  const nAi2 = calls.ai.length;
  res = await post('/admin/api/prep', { preview: true, parts: { cheer: false, course: false }, note: 'パンの発注を確認' }, A);
  check(calls.ai.length === nAi2 && !res.body.preview.text.includes('■ コースごとの人数') && !res.body.preview.text.includes('休んでくださいね') && res.body.preview.text.includes('■ いつものメモ\nパンの発注を確認'), 'parts switch + cached');
  // 当日の朝まで受け付けるメニュー：過去の同じ曜日に、前の晩より後に入った予約から見込みを出す（設定も Claude に渡す）
  const lunch = await db2.prepare("SELECT id FROM courses WHERE name = '養生ランチ'").first();
  await db2.prepare("UPDATE courses SET cutoff_mode = 'custom', cutoff_days = 0, cutoff_time = '09:00' WHERE id = ?").bind(lunch.id).run();
  const sendDay = T > add(nd, -1) ? T : add(nd, -1);
  const lead = Math.round((Date.parse(nd) - Date.parse(sendDay)) / 86400000);
  for (const w of [7, 14]) {
    const d = add(nd, -w);
    await db2.prepare("INSERT INTO reservations (id, created_at, updated_at, status, date, time, session, guests, name, phone, course_id, course_name, note, hold_date, hold_time, hold_session, source, memo, arrived) VALUES (?, ?, ?, '確定', ?, '12:00', 'lunch', 3, '過去 客', '', ?, '養生ランチ', '', ?, '12:00', 'lunch', 'LINE', '', 'yes')")
      .bind('PH' + w, add(d, -lead) + ' 23:58', add(d, -lead) + ' 23:58', d, lunch.id, d).run();
  }
  res = await post('/admin/api/prep', { preview: true, parts: {}, note: '' }, A);
  const ft = res.body.preview.text;
  check(ft.includes('■ これから入りそうな予約（見込み）') && /・養生ランチ（当日9:00まで受付）いま3名。まだ増えそうなので [\d〜]+名分の用意を/.test(ft) && ft.includes('（過去'), 'forecast for same-day menu\n' + ft);
  const fin = String(calls.ai[calls.ai.length - 1].body.messages[0].content[0].text);
  check(fin.includes('【お店の設定（管理画面の設定タブ）】') && fin.includes('養生ランチ：') && fin.includes('予約の締切 当日09:00まで') && fin.includes('これから入りそうな予約の見込み') && !fin.includes('過去 客'), 'settings and forecast sent to Claude');
  res = await post('/admin/api/analysisAi', { section: 'booking' }, A);
  check(String(calls.ai[calls.ai.length - 1].body.messages[0].content[0].text).includes('予約の締切 当日09:00まで'), 'settings in analysis');
  // 入れることを足す：Claude にまとめてもらう項目と、毎回同じ文の項目
  const pcust = [{ id: 'cdrink', title: 'ドリンクの準備', kind: 'ai', body: 'ノンアルコールを頼みそうな方を書き出して' }, { id: 'cclose', title: '閉店後', kind: 'text', body: '冷蔵庫の温度を確認' }, { id: 'coff', title: '止めた項目', kind: 'text', body: '出ない', on: false }];
  res = await post('/admin/api/prep', { preview: true, parts: {}, note: '', custom: pcust }, A);
  const ct = res.body.preview.text;
  check(ct.includes('■ ドリンクの準備（Claude）\n・11:30 鈴木様：ノンアル1名') && ct.includes('■ 閉店後\n冷蔵庫の温度を確認') && !ct.includes('止めた項目'), 'custom items\n' + ct);
  check(String(calls.ai[calls.ai.length - 1].body.messages[0].content[0].text).includes('cdrink｜ドリンクの準備｜ノンアルコールを頼みそうな方'), 'custom ask sent to Claude');
  await post('/admin/api/prep', { save: true, on: false, time: '21:00', parts: {}, note: '', custom: pcust.concat([{ title: '', body: 'x' }]) }, A);
  const saved = (await post('/admin/api/prep', {}, A)).body.cfg.custom;
  check(saved.length === 3 && saved[2].on === false && saved[0].kind === 'ai', 'custom saved');
  // オンにして時刻を過ぎていれば、定期実行で1回だけ送る
  await post('/admin/api/prep', { save: true, on: true, time: '00:00', parts: {}, note: '' }, A);
  pushes.length = 0;
  await fetch(B + '/cdn-cgi/mf/scheduled');
  check(await wait(() => pushes.some(p => p.messages[0].text.startsWith('【仕込みメモ')), 8000), 'prep pushed by schedule');
  pushes.length = 0;
  await fetch(B + '/cdn-cgi/mf/scheduled');
  await new Promise(r => setTimeout(r, 1500));
  check(!pushes.some(p => p.messages[0].text.startsWith('【仕込みメモ')), 'prep once a day');
  // 前の晩より前に送っていて、そのあと予約が変わった：前の日の晩にもう一度送る
  if (add(nd, -1) === T) {
    const sent = JSON.parse((await db2.prepare("SELECT v FROM kv WHERE k = 'prepSent'").first()).v);
    sent[nd].day = add(T, -2);
    await db2.prepare("UPDATE kv SET v = ? WHERE k = 'prepSent'").bind(JSON.stringify(sent)).run();
    await db2.prepare("DELETE FROM kv WHERE k = 'prepChecked'").run();
    await db2.prepare("UPDATE reservations SET guests = 4 WHERE id = 'PP2'").run();
    pushes.length = 0;
    await fetch(B + '/cdn-cgi/mf/scheduled');
    check(await wait(() => pushes.some(p => p.messages[0].text.includes('前に送ったあとで予約が変わりました') && p.messages[0].text.includes('2組 6名')), 8000), 'update sent the evening before');
  }
  // 振込は Claude が確かだと言っても、まとめて登録には入れない
  txs.push({ id: 'TX%3D30', date: T, value: 8800, side: 'EXPENSE', content: 'PCﾌﾘｺﾐ ﾔﾏﾀﾞｼﾖｳﾃﾝ', journalizing_status: 'none' });
  res = await post('/admin/api/mfTx', {}, A);
  const tr = res.body.list.find(t => t.id === 'TX%3D30');
  check(tr && tr.ai && tr.ai.sure && !tr.sure, 'transfers are never bulk');
  txs.splice(txs.findIndex(t => t.id === 'TX%3D30'), 1);
  // 予約0件の日：「見込みがあれば送る」にしていれば、見込みだけのメモを作る
  await db2.prepare("UPDATE reservations SET status = '確定待避' WHERE date = ? AND status = '確定'").bind(nd).run();
  res = await post('/admin/api/prep', { save: true, on: true, time: '21:00', parts: {}, note: '', empty: false }, A);
  res = await post('/admin/api/prep', { preview: true }, A);
  check(res.body.preview.date !== nd, 'empty day not sent by default');
  await post('/admin/api/prep', { save: true, on: true, time: '21:00', parts: {}, note: '', empty: true }, A);
  res = await post('/admin/api/prep', { preview: true }, A);
  check(res.body.preview.date === nd && res.body.preview.text.includes('ご予約 まだありません（見込みだけ）') && res.body.preview.text.includes('■ これから入りそうな予約') && !res.body.preview.text.includes('■ 時間ごと'), 'empty day with forecast\n' + res.body.preview.text);
  await db2.prepare("UPDATE reservations SET status = '確定' WHERE status = '確定待避'").run();
  await post('/admin/api/prep', { save: true, on: false, time: '21:00', parts: {}, note: '', empty: false }, A);
  // 口座の明細をおすすめのまま、まとめて登録
  txs.push({ id: 'TX%3D20', date: T, value: 1100, side: 'EXPENSE', content: 'ﾃｽﾄ1', journalizing_status: 'none' }, { id: 'TX%3D21', date: T, value: 2200, side: 'EXPENSE', content: 'ﾃｽﾄ2', journalizing_status: 'none' });
  const accs = (await post('/admin/api/mfTx', { suggest: false }, A)).body.accounts;
  res = await post('/admin/api/mfTxSaveAll', { items: [{ id: 'TX%3D20', date: T, content: 'ﾃｽﾄ1', accountId: accs[0].id, rate: '10' }, { id: 'TX%3D21', date: T, content: 'ﾃｽﾄ2', accountId: accs[0].id, rate: '10' }, { id: 'TX%3D20', date: T, content: 'ﾃｽﾄ1', accountId: accs[0].id, rate: '10' }] }, A);
  check(res.body.done.length === 2 && res.body.failed.length === 1 && txs.filter(t => t.id === 'TX%3D20' || t.id === 'TX%3D21').every(t => t.journalizing_status === 'registered'), 'bulk register ' + JSON.stringify(res.body));
  console.log(wk);
  console.log('ALL OK', ok, 'checks');
} catch (e) {
  console.error('FAILED after', ok, 'checks:', e.message);
  process.exitCode = 1;
} finally {
  await env.stop();
  mock.close();
}
