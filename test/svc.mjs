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
  // まだ登録していない口座の明細：Claude が科目を提案 → そのまま登録
  res = await post('/admin/api/mfTx', {}, A);
  check(res.body.list.length >= 2 && res.body.list.every(t => t.amount > 0 && t.id.startsWith('TX')) && !res.body.list.some(t => t.content === 'ｽｸｴｱ'), 'unregistered bank lines ' + JSON.stringify(res.body.list.map(t => t.content)));
  const nt = res.body.list.find(t => t.id === 'TX%3D2');
  check(nt.ai && res.body.accounts.find(a => a.id === nt.ai.accountId).name === '通信費' && nt.ai.reason, 'suggested account');
  const nAi = calls.ai.length;
  res = await post('/admin/api/mfTx', {}, A);
  check(calls.ai.length === nAi, 'suggestions cached');
  res = await post('/admin/api/mfTxSave', { id: nt.id, date: nt.date, content: nt.content, accountId: nt.ai.accountId, rate: nt.ai.rate }, A);
  check(txs.find(t => t.id === 'TX%3D2').journalizing_status === 'registered', 'bank line registered');
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
  console.log(wk);
  console.log('ALL OK', ok, 'checks');
} catch (e) {
  console.error('FAILED after', ok, 'checks:', e.message);
  process.exitCode = 1;
} finally {
  await env.stop();
  mock.close();
}
