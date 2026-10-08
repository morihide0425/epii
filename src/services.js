/* =========================================================
 * 外部サービスとの連携（Claude・Square・マネーフォワード）
 * ・お客様の電話番号・LINEのID・お名前は Claude に送らない
 * ・お客様への返事は自動で送らない（下書きを作るだけ。送るのはお店）
 * ・つながっていないサービスの機能は、画面に出さない
 * ========================================================= */

const AI_MODEL = 'claude-opus-5-5';
// 文節の区切りの印。画面で変なところで改行しないために Claude に入れてもらい、送る文・コピーする文からは消す
const BRK = '｜';
const AI_BREAK_RULE = '画面で変なところで改行されないよう、文節の切れ目に「｜」を入れてください（例：ご来店を｜心より｜お待ちして｜おります。）。句読点のあとには必ず入れます。数字・金額・日付・割合・カタカナ語・ハッシュタグ・URLの途中には入れません。';

function features(env) {
  return { ai: !!env.ANTHROPIC_API_KEY, square: !!env.SQUARE_ACCESS_TOKEN, mf: !!env.MF_API_KEY };
}
function plain(v) { return String(v || '').split(BRK).join(''); }
// Claude の文：制御文字を除き、区切りの印の重なりや端の印を整える
function aiText(v, max) {
  return clean(v, max || 600).replace(/[|]/g, BRK).replace(/｜{2,}/g, BRK).replace(/^｜|｜$/g, '').replace(/｜?\n｜?/g, '\n');
}

// お客様の個人情報（電話番号・メール）を消してから Claude に渡す
function noPrivate(v, max) {
  return clean(String(v || '').normalize('NFKC'), max || 500)
    .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, '（メール）')
    .replace(/\+?\d[\d\-‐－―−()（）\s]{6,}\d/g, m => (m.replace(/\D/g, '').length >= 8 ? '（電話番号）' : m));
}

async function hashOf(obj) {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(obj)));
  return b64url(new Uint8Array(d)).slice(0, 16);
}
async function kvGet(env, k) {
  const r = await env.DB.prepare('SELECT v FROM kv WHERE k = ?').bind(k).first();
  if (!r) return null;
  try { return JSON.parse(r.v); } catch (e) { return null; }
}
async function kvPut(env, k, v) {
  await env.DB.prepare('INSERT OR REPLACE INTO kv (k, v) VALUES (?, ?)').bind(k, JSON.stringify(v)).run();
}
async function aiCacheGet(env, k) {
  const r = await env.DB.prepare('SELECT src, v, at FROM ai_cache WHERE k = ?').bind(k).first();
  if (!r) return null;
  try { return { src: r.src, v: JSON.parse(r.v), at: r.at }; } catch (e) { return null; }
}
async function aiCachePut(env, k, src, v) {
  await env.DB.prepare('INSERT OR REPLACE INTO ai_cache (k, src, v, at) VALUES (?, ?, ?, ?)')
    .bind(k, src, JSON.stringify(v), jstStamp(Date.now())).run();
}
function monthLast(ym) {
  const p = ym.split('-').map(Number);
  return ym + '-' + pad(new Date(Date.UTC(p[0], p[1], 0)).getUTCDate());
}
function addMonths(ym, n) {
  const p = ym.split('-').map(Number);
  const d = new Date(Date.UTC(p[0], p[1] - 1 + n, 1));
  return d.getUTCFullYear() + '-' + pad(d.getUTCMonth() + 1);
}
function monthsBetween(from, to) {
  const out = [];
  for (let ym = from.slice(0, 7); ym <= to.slice(0, 7); ym = addMonths(ym, 1)) out.push(ym);
  return out;
}
function jdShort(date) { const p = String(date).split('-').map(Number); return p[1] + '/' + p[2]; }

/* ---------- Claude ---------- */
function aiBase(env) { return env.ANTHROPIC_API_BASE || 'https://api.anthropic.com'; }

// 1回の問い合わせ。schema があれば、その形の JSON で受け取る
async function claude(env, o) {
  if (!env.ANTHROPIC_API_KEY) fail('Claudeがまだつながっていません（ANTHROPIC_API_KEY）。', 400, 'AI_OFF');
  const body = {
    model: AI_MODEL,
    max_tokens: o.maxTokens || 8000,
    system: o.system,
    messages: o.messages || [{ role: 'user', content: o.content }],
    output_config: { effort: o.effort || 'low' },
    // 安全のための判定で断られたときは、Anthropic がすすめる別のモデルで書き直す
    fallbacks: 'default'
  };
  if (o.schema) body.output_config.format = { type: 'json_schema', schema: o.schema };
  const send = async withFallback => {
    const b = Object.assign({}, body);
    const h = { 'content-type': 'application/json', 'x-api-key': env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' };
    if (withFallback) h['anthropic-beta'] = 'server-side-fallback-2026-07-01';
    else delete b.fallbacks;
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), o.timeout || 110000);
    try {
      return await fetch(aiBase(env) + '/v1/messages', { method: 'POST', headers: h, body: JSON.stringify(b), signal: ac.signal });
    } catch (e) {
      return fail(e && e.name === 'AbortError' ? 'Claudeの返事に時間がかかりすぎました。もう一度お試しください。' : 'Claudeにつながりませんでした。電波の良い場所でもう一度お試しください。', 502, 'AI_NET');
    } finally {
      clearTimeout(timer);
    }
  };
  let res = await send(true);
  if (res.status === 400) {
    const t = await res.clone().text();
    if (/fallback/i.test(t)) res = await send(false);
  }
  let j = null;
  try { j = await res.json(); } catch (e) { /* 何もしない */ }
  if (!res.ok) {
    const msg = j && j.error ? String(j.error.message || '') : '';
    console.error('Claude API', res.status, msg);
    const why = res.status === 401 ? 'ANTHROPIC_API_KEYが正しくありません'
      : /credit|balance|billing/i.test(msg) ? 'Claudeのクレジットの残高が足りません'
      : res.status === 429 || res.status === 529 || res.status === 503 ? '混み合っています。少し待ってからお試しください'
      : 'エラーコード ' + res.status;
    fail('Claudeにつながりませんでした（' + why + '）。', 502, 'AI_ERROR');
  }
  if (j.stop_reason === 'refusal') fail('Claudeがこの内容は書けないと判断しました。', 400, 'AI_REFUSAL');
  if (j.stop_reason === 'max_tokens') fail('Claudeの返事が途中で切れました。もう一度お試しください。', 502, 'AI_CUT');
  const text = (j.content || []).filter(c => c.type === 'text').map(c => c.text).join('').trim();
  if (!o.schema) return text;
  try { return JSON.parse(text); } catch (e) { return fail('Claudeの返事を読み取れませんでした。もう一度お試しください。', 502, 'AI_PARSE'); }
}
function strSchema(props, required) {
  return { type: 'object', additionalProperties: false, required: required || Object.keys(props), properties: props };
}
// 同時に動かす数を抑えて順に処理する
async function eachLimit(list, n, fn) {
  const out = new Array(list.length);
  let i = 0;
  const worker = async () => { while (i < list.length) { const k = i++; out[k] = await fn(list[k], k); } };
  await Promise.all(Array.from({ length: Math.min(n, list.length) }, worker));
  return out;
}

/* ---------- お客様の来店の記録（Claude に渡す形。名前・電話は入れない） ---------- */
function guestFacts(r, grouped, info, today) {
  const key = grouped.keyOf[r.id];
  if (!key) return null;
  const g = grouped.groups[key];
  const before = g.rows.filter(x => x.id !== r.id && (x.date + x.time) < (r.date + r.time));
  const visits = before.filter(x => isVisit(x, today)).length + (info[key] ? info[key].extra : 0);
  const status = x => x.status === '確定' ? (x.arrived === 'no' ? '来店なし' : isVisit(x, today) ? '来店' : '予約中') : x.status;
  return {
    key: key,
    visits: visits,
    walkins: info[key] ? info[key].extra : 0,
    past: before.slice(0, 8).map(x => ({ date: x.date, course: x.course_name || '', guests: x.guests, state: status(x), note: noPrivate(x.note, 120) })),
    memo: noPrivate(info[key] ? info[key].memo : '', 300)
  };
}
function pastText(f) {
  if (!f || (!f.past.length && !f.walkins)) return 'なし（初めてのお客様）';
  const lines = f.past.map(x => '・' + jdLong(x.date) + '　' + x.course + '　' + x.guests + '名　' + x.state + (x.note ? '　ご要望：' + x.note : ''));
  if (f.walkins) lines.push('・予約なしの来店 ' + f.walkins + '回（日付の記録なし）');
  return lines.join('\n');
}

/* ---------- (1) 返事の下書き：決まった文面に足す「ひと言」 ---------- */
const REPLY_SYSTEM = [
  'あなたは、大阪・阿倍野の小さな薬膳レストラン「épii」（店主ひとりで営業）の店主の代わりに、予約のお客様へLINEで送る返事に添える「ひと言」を考えます。',
  '返事の本文（お礼・日時・人数・メニュー・署名）はお店の決まった文面で送ります。あなたが書くのは、本文の途中に差し込む1〜2文だけです。',
  '',
  '書き方：',
  '- 丁寧で、あたたかく、控えめな敬語（です・ます）。絵文字・顔文字・「！」は使わない。',
  '- 2文まで、合わせて80文字くらいまで。',
  '- このお客様だから書けることに触れる：ご要望（記念日・お誕生日・お連れ様・アレルギーや苦手な食材など）、何回目のご来店か。触れることがなければ、空の文字列を返す。',
  '- 2回目以降のお客様には、またお越しいただけることへのお礼を。初めての方に「いつも」などとは書かない。',
  '- お店が約束していないことは書かない（無料のサービス、特別な料理やケーキ、席の指定、値引き、当日の対応の細かい内容）。アレルギーや苦手な食材は「承りました」「お料理で配慮いたします」くらいにとどめる。',
  '- 日時・人数・メニュー名・お店の名前・お客様のお名前・電話番号は書かない（本文に入っている）。',
  '- 返事の種類に合わせる。お断り・別の日時のご提案では、ご希望に沿えないお詫びや、またの機会を楽しみにしていることを、押しつけがましくなく。お断りなのに「お待ちしております」とは書かない。',
  '- ' + AI_BREAK_RULE
].join('\n');
const REPLY_KIND = {
  ok: 'ご予約の承認（ご希望の日時で確定）', ok2: 'ご予約の承認（第1希望は満席のため、第2希望の日時で確定）',
  offer: '別の日時のご提案（ご希望の日時は満席）', ng: 'お断り（ご希望の日時は満席）',
  cok: 'ご予約の変更の承認', cng: 'ご予約の変更のお断り（元のご予約はそのまま）'
};

async function replyFacts(env, b) {
  const kind = b.kind === 'g' ? 'g' : 'r';
  const id = String(b.id || '');
  const today = jstStamp(Date.now()).slice(0, 10);
  const s = await getSettings(env);
  let r, c = null;
  if (kind === 'g') {
    c = await env.DB.prepare('SELECT * FROM change_requests WHERE id = ?').bind(id).first();
    if (!c) fail('変更のリクエストが見つかりません。');
    r = await env.DB.prepare('SELECT * FROM reservations WHERE id = ?').bind(c.res_id).first();
  } else {
    r = await env.DB.prepare('SELECT * FROM reservations WHERE id = ?').bind(id).first();
  }
  if (!r) fail('予約が見つかりません。');
  const mode = kind === 'g' ? (b.mode === 'ok' ? 'cok' : 'cng') : (REPLY_KIND[b.mode] ? b.mode : 'ok');
  const [rows, info] = await Promise.all([allCustomerRows(env), customerInfo(env)]);
  const f = guestFacts(r, groupCustomers(rows, info), info, today);
  const when = (d, t, k) => jdLong(d) + ' ' + t + '（' + sessionLabel(s, k || r.session) + '）';
  const lines = ['今日：' + jdLong(today), '返事の種類：' + REPLY_KIND[mode]];
  if (kind === 'g') {
    lines.push('今のご予約：' + when(r.date, r.time) + '　' + r.guests + '名　' + r.course_name);
    lines.push('変更のご希望：' + when(c.date, c.time, c.session) + '　' + c.guests + '名　' + c.course_name);
  } else {
    lines.push('ご希望：' + when(r.date, r.time) + '　' + r.guests + '名　' + r.course_name);
    if (r.alt_date) lines.push('第2希望：' + when(r.alt_date, r.alt_time));
    if (mode === 'offer' && b.offer && isDate(b.offer.date)) lines.push('ご提案する日時：' + when(b.offer.date, b.offer.time));
  }
  lines.push('ご要望（お客様の入力）：' + (noPrivate(r.note, 300) || 'なし'));
  lines.push('これまでのご来店（' + (f ? f.visits : 0) + '回）：\n' + pastText(f));
  if (f && f.memo) lines.push('お店のメモ：' + f.memo);
  const note = await ownerNote(env);
  if (note) lines.push('お店からClaudeへのメモ（返事に関係することだけ参考に）：' + note);
  const key = 'reply:' + kind + ':' + id + ':' + mode + (mode === 'offer' && b.offer ? ':' + b.offer.date + ' ' + b.offer.time : '');
  return { key: key, text: lines.join('\n') };
}

async function adminAiReply(env, b) {
  const facts = await replyFacts(env, b);
  const src = await hashOf(facts.text);
  if (!b.fresh) {
    const hit = await aiCacheGet(env, facts.key);
    if (hit && hit.src === src) return { add: hit.v };
  }
  let ask = facts.text;
  if (b.fresh && b.before) ask += '\n\n前に考えた案（これとは違う言い回しにしてください）：' + plain(clean(b.before, 300));
  const out = await claude(env, {
    system: REPLY_SYSTEM, effort: 'low', maxTokens: 6000,
    content: [{ type: 'text', text: ask }],
    schema: strSchema({ add: { type: 'string', description: '本文に差し込む1〜2文。触れることがなければ空の文字列' } })
  });
  const add = aiText(out.add, 300);
  await aiCachePut(env, facts.key, src, add);
  return { add: add };
}

// リクエストが届いたら、お店が開く前に下書きを用意しておく（失敗しても何もしない）
async function warmReply(env, kind, id) {
  if (!env.ANTHROPIC_API_KEY) return;
  try {
    if (kind === 'g') {
      const req = await adminRequestsData(env);
      const c = (req.changes || []).find(x => x.id === id);
      if (c) await adminAiReply(env, { kind: 'g', id: id, mode: c.left >= c.guests ? 'ok' : 'ng' });
      return;
    }
    const req = await adminRequestsData(env);
    const r = req.waiting.find(x => x.id === id);
    if (!r) return;
    const mode = r.left >= r.guests ? 'ok' : (r.altDate && r.altLeft >= r.guests ? 'ok2' : 'offer');
    await adminAiReply(env, { kind: 'r', id: id, mode: mode, offer: mode === 'offer' ? r.suggestions[0] : null });
  } catch (e) {
    console.error('下書きの準備に失敗', e && e.message);
  }
}

/* ---------- (4) 来店前メモ ---------- */
const MEMO_SYSTEM = [
  'あなたは、小さな薬膳レストラン「épii」の店主のために、今日来店するお客様の「来店前メモ」を書きます。店主が仕込みや接客の前に、3秒で読める長さにします。',
  '- 60文字以内。短い文や体言止めでよい（敬語はいらない）。',
  '- 書くこと：何回目のご来店か、前回いつ何を召し上がったか、ご要望の傾向（アレルギー・苦手な食材・記念日・お連れ様）、来店なしやキャンセルが続いていないか、お店のメモの要点。',
  '- 今回のご要望はすでに画面に出ているので、そのままは繰り返さない（過去と関係があるときだけ触れる）。',
  '- データにないことは書かない。推測しない。',
  '- ' + AI_BREAK_RULE
].join('\n');

function memoInput(r, grouped, info, today) {
  if (['確定', '返事待ち', '提案中'].indexOf(r.status) < 0) return null;
  const f = guestFacts(r, grouped, info, today);
  if (!f || (!f.past.length && !f.memo && !f.walkins)) return null;
  return [
    '今回：' + jdLong(r.date) + ' ' + r.time + '　' + r.guests + '名　' + (r.course_name || ''),
    '今回のご要望：' + (noPrivate(r.note, 200) || 'なし'),
    'これまで（新しい順。予約なしの来店 ' + f.walkins + '回を含めて ' + f.visits + '回来店）：\n' + pastText(f),
    'お店のメモ：' + (f.memo || 'なし')
  ].join('\n');
}

// その日の予約の来店前メモ（作ってあるものはすぐ返し、ないものは作る）
async function dayMemos(env, rows, make, pre) {
  const today = jstStamp(Date.now()).slice(0, 10);
  let grouped, info;
  if (pre) { grouped = pre.grouped; info = pre.info; } else {
    const both = await Promise.all([allCustomerRows(env), customerInfo(env)]);
    info = both[1];
    grouped = groupCustomers(both[0], info);
  }
  const want = [];
  for (const r of rows) {
    const text = memoInput(r, grouped, info, today);
    if (text) want.push({ id: r.id, text: text, src: await hashOf(text) });
  }
  if (!want.length) return { memos: {}, missing: [] };
  const keys = want.map(w => 'memo:' + w.id);
  const hits = {};
  (await env.DB.prepare('SELECT k, src, v FROM ai_cache WHERE k IN (' + keys.map(() => '?').join(',') + ')').bind(...keys).all()).results
    .forEach(x => { hits[x.k] = x; });
  const memos = {};
  const missing = [];
  want.forEach(w => {
    const h = hits['memo:' + w.id];
    if (h && h.src === w.src) { try { memos[w.id] = JSON.parse(h.v); } catch (e) { missing.push(w); } } else missing.push(w);
  });
  if (!make) return { memos: memos, missing: missing.map(w => w.id) };
  await eachLimit(missing, 3, async w => {
    try {
      const out = await claude(env, {
        system: MEMO_SYSTEM, effort: 'low', maxTokens: 4000,
        content: [{ type: 'text', text: w.text }],
        schema: strSchema({ memo: { type: 'string' } })
      });
      memos[w.id] = aiText(out.memo, 160);
      await aiCachePut(env, 'memo:' + w.id, w.src, memos[w.id]);
    } catch (e) {
      if (e && e.code === 'AI_OFF') throw e;
      console.error('来店前メモ', e && e.message);
    }
  });
  return { memos: memos, missing: [] };
}
async function adminAiMemos(env, b) {
  const date = String(b.date || '');
  if (!isDate(date)) fail('日付が正しくありません。');
  const rows = (await env.DB.prepare("SELECT * FROM reservations WHERE hold_date = ? AND status IN ('確定','返事待ち','提案中') ORDER BY hold_time").bind(date).all()).results;
  return { memos: (await dayMemos(env, rows, true)).memos };
}

/* ---------- Square（レジの売上） ---------- */
function sqBase(env) { return env.SQUARE_API_BASE || 'https://connect.squareup.com'; }
const SQ_VERSION = '2025-01-23';
const PAY_METHOD = { CARD: 'カード', CASH: '現金', WALLET: 'QR・電子マネー', EXTERNAL: 'そのほか', BANK_ACCOUNT: '口座', BUY_NOW_PAY_LATER: 'あと払い', SQUARE_ACCOUNT: 'そのほか' };
const SQ_RES_LINKS = "('auto','res')";

async function sqFetchRange(env, from, to) {
  const begin = new Date(Date.parse(from + 'T00:00:00+09:00')).toISOString();
  const end = new Date(Date.parse(addDays(to, 1) + 'T00:00:00+09:00')).toISOString();
  let cursor = '';
  let n = 0;
  for (let page = 0; page < 80; page++) {
    const q = new URLSearchParams({ begin_time: begin, end_time: end, sort_order: 'ASC', limit: '100' });
    if (env.SQUARE_LOCATION_ID) q.set('location_id', env.SQUARE_LOCATION_ID);
    if (cursor) q.set('cursor', cursor);
    let res;
    try {
      res = await fetch(sqBase(env) + '/v2/payments?' + q.toString(), {
        headers: { authorization: 'Bearer ' + env.SQUARE_ACCESS_TOKEN, 'square-version': SQ_VERSION, accept: 'application/json' }
      });
    } catch (e) {
      fail('Squareにつながりませんでした（通信エラー）。', 502, 'SQ_NET');
    }
    let j = {};
    try { j = await res.json(); } catch (e) { /* 何もしない */ }
    if (!res.ok) {
      const er = j.errors && j.errors[0];
      console.error('Square', res.status, er ? er.code + ' ' + er.detail : '');
      fail('Squareにつながりませんでした（' + (res.status === 401 ? 'SQUARE_ACCESS_TOKENが正しくありません' : res.status === 403 ? 'トークンに売上を読む権限がありません' : 'エラーコード ' + res.status) + '）。', 502, 'SQ_ERROR');
    }
    const list = j.payments || [];
    const now = jstStamp(Date.now());
    if (list.length) {
      await env.DB.batch(list.map(p => {
        const ts = jstFromIso(p.created_at);
        const total = p.total_money ? Number(p.total_money.amount) || 0 : (p.amount_money ? Number(p.amount_money.amount) || 0 : 0);
        return env.DB.prepare(
          "INSERT INTO sq_payments (id, ts, date, amount, refunded, tip, method, status, link, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, '', ?) " +
          'ON CONFLICT(id) DO UPDATE SET ts = excluded.ts, date = excluded.date, amount = excluded.amount, refunded = excluded.refunded, tip = excluded.tip, method = excluded.method, status = excluded.status, updated_at = excluded.updated_at'
        ).bind(String(p.id), ts, ts.slice(0, 10), total, p.refunded_money ? Number(p.refunded_money.amount) || 0 : 0,
          p.tip_money ? Number(p.tip_money.amount) || 0 : 0, PAY_METHOD[p.source_type] || 'そのほか', String(p.status || ''), now);
      }));
    }
    n += list.length;
    cursor = j.cursor || '';
    if (!cursor) break;
  }
  return n;
}

// 月ごとに取り込む。今月は前回の取り込みの前日から、終わった月は月が明けて3日たったら確定
async function sqEnsure(env, months, maxAge) {
  if (!env.SQUARE_ACCESS_TOKEN) return [];
  const st = (await kvGet(env, 'sqMonths')) || {};
  const today = jstStamp(Date.now()).slice(0, 10);
  const cur = today.slice(0, 7);
  const touched = [];
  for (const ym of months) {
    if (ym > cur) continue;
    const at = st[ym] || 0;
    let from;
    if (ym === cur) {
      if (at && Date.now() - at < maxAge) continue;
      from = at ? jstStamp(at).slice(0, 10) : ym + '-01';
      from = addDays(from, -1) < ym + '-01' ? ym + '-01' : addDays(from, -1);
      await sqFetchRange(env, from, today);
    } else {
      const settled = at && at > stampMs(addDays(monthLast(ym), 3) + ' 00:00');
      if (settled || (at && Date.now() - at < Math.max(maxAge, 3600000))) continue;
      from = ym + '-01';
      await sqFetchRange(env, from, monthLast(ym));
    }
    st[ym] = Date.now();
    touched.push({ from: from, to: ym === cur ? today : monthLast(ym) });
    await kvPut(env, 'sqMonths', st);
  }
  if (touched.length) await sqMatch(env, touched[0].from, touched[touched.length - 1].to);
  return touched;
}

// 会計と予約を照らし合わせる：予約の終わりごろの会計を、その予約の会計とみなす（手で決めたものは変えない）
async function sqMatch(env, from, to) {
  const s = await getSettings(env);
  const rs = await env.DB.batch([
    env.DB.prepare("SELECT id, ts, date, link, res_id FROM sq_payments WHERE date BETWEEN ? AND ? AND status = 'COMPLETED' AND amount > refunded AND link IN ('', 'auto') ORDER BY ts").bind(from, to),
    env.DB.prepare("SELECT id, date, time, session, stay, arrived, guests FROM reservations WHERE date BETWEEN ? AND ? AND status = '確定' AND (arrived IS NULL OR arrived != 'no')").bind(from, to)
  ]);
  const byDate = {};
  rs[0].results.forEach(p => { (byDate[p.date] = byDate[p.date] || { pays: [], res: [] }).pays.push(p); });
  rs[1].results.forEach(r => { if (byDate[r.date]) byDate[r.date].res.push(r); });
  const updates = [];
  Object.values(byDate).forEach(d => {
    const owner = {};
    const tOf = p => toMin(p.ts.slice(11, 16));
    const res = d.res.map(r => {
      const start = toMin(r.time);
      const stay = Number(r.stay) || (s.sessions[r.session] ? Number(s.sessions[r.session].stay) : 120) || 120;
      return { id: r.id, start: start, end: start + stay, guests: Number(r.guests) || 1 };
    }).sort((a, b) => a.end - b.end);
    // 1. 予約ごとに、終わりの時刻にいちばん近い会計を1つ
    res.forEach(r => {
      let best = null;
      d.pays.forEach(p => {
        if (owner[p.id]) return;
        const t = tOf(p);
        if (t < r.start + 20 || t > r.end + 90) return;
        const score = Math.abs(t - r.end);
        if (!best || score < best.score) best = { id: p.id, score: score, t: t };
      });
      if (best) { owner[best.id] = r.id; r.paidAt = best.t; }
    });
    // 2. 別々の会計（割り勘）：その予約の会計の前後5分の会計は、人数－1件まで同じ予約の会計にする
    res.forEach(r => {
      if (r.paidAt === undefined || r.guests < 2) return;
      let extra = 0;
      d.pays.filter(p => !owner[p.id] && Math.abs(tOf(p) - r.paidAt) <= 5)
        .sort((a, b) => Math.abs(tOf(a) - r.paidAt) - Math.abs(tOf(b) - r.paidAt))
        .forEach(p => { if (extra < r.guests - 1) { owner[p.id] = r.id; extra++; } });
    });
    d.pays.forEach(p => {
      const link = owner[p.id] ? 'auto' : '';
      const rid = owner[p.id] || null;
      if (p.link !== link || (p.res_id || null) !== rid) {
        updates.push(env.DB.prepare('UPDATE sq_payments SET link = ?, res_id = ? WHERE id = ? AND link IN (\'\', \'auto\')').bind(link, rid, p.id));
      }
    });
  });
  for (let i = 0; i < updates.length; i += 50) await env.DB.batch(updates.slice(i, i + 50));
}

// 今日の画面：今日（会計がまだなければ昨日）の売上、その日の会計すべて（直せるように）、その日の予約（会計を結びつける候補）
async function adminSales(env, b) {
  if (!env.SQUARE_ACCESS_TOKEN) return { connected: false };
  const today = jstStamp(Date.now()).slice(0, 10);
  const from = addDays(today, -3);
  let error = '';
  try {
    await sqEnsure(env, monthsBetween(from, today), b && b.force ? 0 : 120000);
    await sqMatch(env, from, today);
  } catch (e) {
    if (!e.userFacing) throw e;
    error = e.message;
  }
  const rows = (await env.DB.prepare("SELECT * FROM sq_payments WHERE date BETWEEN ? AND ? AND status = 'COMPLETED' ORDER BY ts DESC").bind(from, today).all()).results;
  const net = p => Math.max(0, (Number(p.amount) || 0) - (Number(p.refunded) || 0));
  const day = rows.some(p => p.date === today) || !rows.length ? today : rows[0].date;
  const list = rows.filter(p => p.date === day && net(p) > 0);
  const isRes = p => p.link === 'auto' || p.link === 'res';
  const withRes = list.filter(isRes);
  // その日の予約（予約した人を、会計を結びつける候補の先頭に出す）
  const s = await getSettings(env);
  const resRows = (await env.DB.prepare("SELECT id, time, name, guests, course_name, stay, session, arrived FROM reservations WHERE date = ? AND status = '確定' ORDER BY time").bind(day).all()).results;
  const paid = {};
  withRes.forEach(p => { if (p.res_id) paid[p.res_id] = (paid[p.res_id] || 0) + net(p); });
  const resv = resRows.map(r => {
    const stay = Number(r.stay) || (s.sessions[r.session] ? Number(s.sessions[r.session].stay) : 120) || 120;
    return { id: r.id, time: r.time, until: toHM(toMin(r.time) + stay), name: r.name, guests: r.guests, course: r.course_name || '', paid: paid[r.id] || 0, noShow: r.arrived === 'no' };
  });
  const resName = {};
  resv.forEach(r => { resName[r.id] = r.name; });
  // お客様に結びつけた会計の名前
  const custKeys = list.filter(p => p.link === 'cust' && p.cust_key).map(p => p.cust_key);
  const custName = {};
  if (custKeys.length) {
    const info = await customerInfo(env);
    const groups = groupCustomers(await allCustomerRows(env), info).groups;
    custKeys.forEach(k => { const t = mergedTarget(info, k); custName[k] = (info[t] && info[t].name) || (groups[t] && groups[t].name) || ''; });
  }
  const st = (await kvGet(env, 'sqMonths')) || {};
  return {
    connected: true, error: error, today: today, day: day,
    total: list.reduce((a, p) => a + net(p), 0), count: list.length,
    withRes: withRes.reduce((a, p) => a + net(p), 0), resCount: withRes.length,
    resGroups: Object.keys(paid).length + withRes.filter(p => !p.res_id).length,
    walkIn: list.filter(p => !isRes(p)).reduce((a, p) => a + net(p), 0),
    walkCount: list.length - withRes.length,
    syncedAt: st[today.slice(0, 7)] ? jstStamp(st[today.slice(0, 7)]) : '',
    pays: list.map(p => ({ id: p.id, date: p.date, time: p.ts.slice(11, 16), amount: net(p), method: p.method || '', link: p.link || '',
      resId: p.res_id || '', resName: p.res_id ? resName[p.res_id] || '' : '', custName: p.cust_key ? custName[p.cust_key] || '' : '' })),
    resv: resv
  };
}

// 会計を、予約・お客様に結びつける／予約なしのままにする／自動に戻す（何度でも直せる。Squareのデータは変えない）
async function adminSalesLink(env, b) {
  const p = await env.DB.prepare('SELECT * FROM sq_payments WHERE id = ?').bind(String(b.id || '')).first();
  if (!p) fail('会計が見つかりません。画面を更新してください。');
  const act = String(b.action || '');
  if (['res', 'cust', 'new', 'skip', 'undo'].indexOf(act) < 0) fail('操作を選び直してください。');
  let rid = null;
  if (act === 'res') {
    const r = await env.DB.prepare("SELECT id FROM reservations WHERE id = ? AND date = ? AND status = '確定'").bind(String(b.resId || ''), p.date).first();
    if (!r) fail('予約が見つかりません。画面を更新してください。');
    rid = r.id;
  }
  let key = '';
  if (act === 'cust' || act === 'new') {
    key = String(b.key || '').slice(0, 60);
    if (act === 'new') key = (await adminAddCustomer(env, { name: b.name, tel: b.tel, extra: 0 })).key;
    const info0 = await customerInfo(env);
    const k = mergedTarget(info0, key);
    const groups = groupCustomers(await allCustomerRows(env), info0).groups;
    if (!k || (!groups[k] && !info0[k])) fail('お客様が見つかりません。');
    key = k;
  }
  // 前に結びつけたお客様の「予約なしの来店」を1回戻す
  if (p.link === 'cust' && p.cust_key) {
    const info = await customerInfo(env);
    const k = mergedTarget(info, p.cust_key);
    await upsertCustomer(env, k, { extra: Math.max(0, (info[k] ? info[k].extra : 0) - 1) });
  }
  if (act === 'cust' || act === 'new') {
    const info = await customerInfo(env);
    await upsertCustomer(env, key, { extra: (info[key] ? info[key].extra : 0) + 1 });
  }
  const link = act === 'undo' ? '' : act === 'new' ? 'cust' : act;
  await env.DB.prepare('UPDATE sq_payments SET link = ?, res_id = ?, cust_key = ? WHERE id = ?').bind(link, rid, key || null, p.id).run();
  if (act === 'undo') await sqMatch(env, p.date, p.date);
  return { sales: await adminSales(env, {}), key: key };
}

/* ---------- マネーフォワード クラウド（経費・レシートの登録） ---------- */
function mfAuthBase(env) { return env.MF_AUTH_BASE || 'https://api.biz.moneyforward.com'; }
function mfBase(env) { return env.MF_API_BASE || 'https://api-accounting.moneyforward.com/api/v3'; }
let mfJwt = null;

// APIキーを1時間使える通行証に替える（期限の1分前までは使い回す）
async function mfToken(env, force) {
  if (!env.MF_API_KEY) fail('マネーフォワードがまだつながっていません（MF_API_KEY）。', 400, 'MF_OFF');
  const tag = env.MF_API_KEY.slice(-8);
  if (!force && mfJwt && mfJwt.tag === tag && mfJwt.exp > Date.now() + 60000) return mfJwt.token;
  let res;
  try {
    res = await fetch(mfAuthBase(env) + '/auth/exchange', { method: 'POST', headers: { authorization: 'Bearer ' + env.MF_API_KEY, accept: 'application/json' } });
  } catch (e) {
    fail('マネーフォワードにつながりませんでした（通信エラー）。', 502, 'MF_NET');
  }
  let j = {};
  try { j = await res.json(); } catch (e) { /* 何もしない */ }
  if (!res.ok || !j.access_token) {
    console.error('MF exchange', res.status);
    fail('マネーフォワードにつながりませんでした（' + (res.status === 401 || res.status === 403 ? 'MF_API_KEYが正しくないか、期限が切れています' : res.status === 429 ? '少し待ってからお試しください' : 'エラーコード ' + res.status) + '）。', 502, 'MF_AUTH');
  }
  mfJwt = { token: j.access_token, exp: Date.now() + (Number(j.expires_in) || 3600) * 1000, tag: tag };
  return mfJwt.token;
}
async function mfOffice(env) {
  if (env.MF_OFFICE_CODE) return String(env.MF_OFFICE_CODE).trim();
  const saved = await kvGet(env, 'mfOffice');
  if (saved && saved.tag === env.MF_API_KEY.slice(-8)) return saved.code;
  const res = await fetch(mfAuthBase(env) + '/v2/tenant/tenant_user', { headers: { authorization: 'Bearer ' + await mfToken(env), accept: 'application/json' } });
  let j = {};
  try { j = await res.json(); } catch (e) { /* 何もしない */ }
  const items = j.items || [];
  if (!res.ok || !items.length || !items[0].tenant_code) fail('マネーフォワードの事業者が見つかりませんでした（MF_OFFICE_CODEに事業者番号を登録してください）。', 502, 'MF_OFFICE');
  await kvPut(env, 'mfOffice', { code: items[0].tenant_code, tag: env.MF_API_KEY.slice(-8) });
  return items[0].tenant_code;
}
// IDはURLエンコード済みで届くので、%を含む値はそのまま送る
function mfQ(v) { v = String(v); return /%[0-9A-Fa-f]{2}/.test(v) ? v : encodeURIComponent(v); }
async function mfApi(env, method, path, query, body) {
  const qs = ['office_code=' + mfQ(await mfOffice(env))];
  Object.keys(query || {}).forEach(k => {
    const v = query[k];
    if (v === undefined || v === null || v === '') return;
    (Array.isArray(v) ? v : [v]).forEach(x => qs.push(k + '=' + mfQ(x)));
  });
  const url = mfBase(env) + path + '?' + qs.join('&');
  const go = async tok => fetch(url, {
    method: method,
    headers: Object.assign({ authorization: 'Bearer ' + tok, accept: 'application/json' }, body !== undefined ? { 'content-type': 'application/json' } : {}),
    body: body !== undefined ? JSON.stringify(body) : undefined
  });
  let res;
  try {
    res = await go(await mfToken(env));
    if (res.status === 401) res = await go(await mfToken(env, true));
  } catch (e) {
    if (e && e.userFacing) throw e;
    fail('マネーフォワードにつながりませんでした（通信エラー）。', 502, 'MF_NET');
  }
  const text = await res.text();
  let j = {};
  try { j = text ? JSON.parse(text) : {}; } catch (e) { /* 何もしない */ }
  if (!res.ok) {
    console.error('MF API', method, path, res.status, text.slice(0, 300));
    const detail = j.errors && j.errors[0] ? (j.errors[0].message || j.errors[0].code || '') : (j.message || '');
    fail('マネーフォワードでエラーになりました（' + (res.status === 403 ? 'このAPIキーには権限がありません' : res.status === 429 ? '少し待ってからお試しください' : (detail ? clean(detail, 80) : 'エラーコード ' + res.status)) + '）。', 502, 'MF_ERROR');
  }
  return j;
}

// 勘定科目・税区分・税込か税抜か（1日1回取り直す）
async function mfMaster(env, force) {
  const saved = await kvGet(env, 'mfMaster');
  if (!force && saved && Date.now() - saved.at < 86400000) return saved;
  const [a, t, ts] = await Promise.all([
    mfApi(env, 'GET', '/accounts'),
    mfApi(env, 'GET', '/taxes'),
    mfApi(env, 'GET', '/term_settings').catch(() => ({}))
  ]);
  const terms = (ts.term_settings || []).slice().sort((x, y) => String(y.start_date).localeCompare(String(x.start_date)));
  const m = {
    at: Date.now(),
    method: terms[0] ? terms[0].accounting_method || '' : '',
    accounts: (a.accounts || []).filter(x => x.available !== false).map(x => ({ id: x.id, name: x.name || '', group: x.account_group || '' })),
    taxes: (t.taxes || []).filter(x => x.available !== false).map(x => ({ id: x.id, name: x.name || x.abbreviation || '' }))
  };
  await kvPut(env, 'mfMaster', m);
  return m;
}
// 経費の税区分（仕入れの8%軽減・10%・対象外）を名前から探す
function pickTax(taxes, rate) {
  const buy = taxes.filter(t => /仕入/.test(t.name) && !/(輸入|非課税|対応|共通|返還|貸倒|特定)/.test(t.name));
  let list;
  if (rate === '8') list = buy.filter(t => /軽/.test(t.name) && /8/.test(t.name));
  else if (rate === '10') list = buy.filter(t => /10/.test(t.name) && !/軽/.test(t.name));
  else list = taxes.filter(t => /(対象外|不課税)/.test(t.name));
  list.sort((x, y) => x.name.length - y.name.length);
  return list[0] ? list[0].id : null;
}
// 支払い方法（会計が分からなくても選べる言葉で）。debit は口座の明細と結びつけて、二重に登録しない
const PAY_KINDS = [
  { kind: 'debit', label: 'デビットカード・口座から', help: '事業用の口座から出たお金です。口座の明細と結びつけるので、二重には登録されません。', account: '普通預金' },
  { kind: 'cash', label: '現金（お店のお金）', help: 'レジやお店の財布から払ったとき。', account: '現金' },
  { kind: 'own', label: '自分のお金・個人のカード', help: '自分の財布や個人のカードで払ったとき（事業主借で登録します）。', account: '事業主借' }
];
function payOptions(m) {
  return PAY_KINDS.map(p => {
    const a = m.accounts.find(x => x.name === p.account);
    return a || p.kind === 'debit' ? { kind: p.kind, label: p.label, help: p.help, id: a ? a.id : '' } : null;
  }).filter(Boolean);
}
// 勘定科目のやさしい説明（画面に出し、Claude の手がかりにもする）
const ACCOUNT_HELP = {
  '仕入高': '料理に使う食材・飲み物・お酒', '消耗品費': '10万円未満の道具・食器・日用品・洗剤', '水道光熱費': '電気・ガス・水道',
  '通信費': '電話・インターネット・切手', '地代家賃': 'お店の家賃', '支払手数料': '振込手数料・決済の手数料・サービスの利用料',
  '広告宣伝費': 'チラシ・広告・ショップカード', '旅費交通費': '電車・バス・タクシー・駐車場', '接待交際費': '取引先との食事・お祝い・手土産',
  '雑費': 'どれにも当てはまらない少額のもの', '修繕費': '設備や道具の修理', '租税公課': '印紙・税金（所得税・住民税は除く）',
  '荷造運賃': '宅配便・送料', '新聞図書費': '本・雑誌・新聞', '福利厚生費': '従業員のための費用', '研修費': 'セミナー・講習',
  '支払保険料': 'お店の保険', '車両費': 'ガソリン・車の維持費', 'リース料': 'リース契約の機器', '外注工賃': '外に頼んだ作業',
  '衛生費': '清掃・衛生用品', '会議費': '打ち合わせの飲食', '諸会費': '組合・協会の会費', '減価償却費': '高い設備を年ごとに分けた費用'
};
async function expenseOptions(env, m) {
  const used = {};
  try {
    (await env.DB.prepare('SELECT account, COUNT(*) AS n FROM mf_lines WHERE date >= ? GROUP BY account').bind(addDays(jstStamp(Date.now()).slice(0, 10), -180)).all())
      .results.forEach(r => { used[r.account] = r.n; });
  } catch (e) { /* まだ表がないとき */ }
  return m.accounts.filter(a => a.group === 'EXPENSE')
    .map(a => ({ id: a.id, name: a.name, help: ACCOUNT_HELP[a.name] || '', n: used[a.name] || 0 }))
    .sort((x, y) => (y.n - x.n) || ((y.help ? 1 : 0) - (x.help ? 1 : 0)));
}
// これまでの登録（お店→科目）。Claude が科目を選ぶ手がかり
async function accountHistory(env) {
  const out = [];
  const seen = {};
  const add = (k, acc) => { const key = String(k || '').slice(0, 14); if (key && acc && !seen[key]) { seen[key] = true; out.push(key + '→' + acc); } };
  (await env.DB.prepare("SELECT payee, account FROM receipts WHERE status IN ('ok','wait') ORDER BY created_at DESC LIMIT 80").all()).results.forEach(r => add(r.payee, r.account));
  try { (await env.DB.prepare("SELECT remark, account FROM mf_lines WHERE remark != '' ORDER BY date DESC LIMIT 300").all()).results.forEach(r => add(r.remark, r.account)); } catch (e) { /* 何もしない */ }
  return out.slice(0, 40);
}
// お店がClaudeに伝えておくこと（どの下書き・分析にも添える）
async function ownerNote(env) {
  const v = await kvGet(env, 'aiNote');
  return v && v.text ? noPrivate(v.text, 1000) : '';
}

/* ---------- マネーフォワードのデータを手元に置く ----------
 * 経費の仕訳は月ごとに取り込んで表（mf_lines）に置く。今月は10分、先月は6時間、それより前は7日たったら取り直す（差分は月単位）
 */
async function mfMonth(env, ym, maxAge) {
  const st = await kvGet(env, 'mfs:' + ym);
  if (!(st && Date.now() - st.at < maxAge)) {
    const m = await mfMaster(env);
    const acc = {};
    m.accounts.forEach(a => { acc[a.id] = a; });
    const gross = m.method !== 'TAX_EXCLUDED';
    const lines = [];
    for (let page = 1; page <= 20; page++) {
      const j = await mfApi(env, 'GET', '/journals', { start_date: ym + '-01', end_date: monthLast(ym), per_page: 1000, page: page });
      (j.journals || []).forEach(jr => (jr.branches || []).forEach(br => {
        [['debitor', 1], ['creditor', -1]].forEach(x => {
          const side = br[x[0]];
          if (!side || !side.account_id) return;
          const a = acc[side.account_id];
          if (!a || a.group !== 'EXPENSE') return;
          const v = (Number(side.value) || 0) + (gross ? Number(side.tax_value) || 0 : 0);
          if (v) lines.push([String(jr.id || ''), jr.transaction_date, a.name, x[1] * v, clean(br.remark || jr.memo || '', 60)]);
        });
      }));
      const meta = j.metadata || {};
      if (!meta.total_pages || page >= meta.total_pages) break;
    }
    const stmts = [env.DB.prepare('DELETE FROM mf_lines WHERE ym = ?').bind(ym)];
    lines.forEach(l => stmts.push(env.DB.prepare('INSERT INTO mf_lines (jid, date, ym, account, value, remark) VALUES (?, ?, ?, ?, ?, ?)').bind(l[0], l[1], ym, l[2], l[3], l[4])));
    for (let i = 0; i < stmts.length; i += 80) await env.DB.batch(stmts.slice(i, i + 80));
    await kvPut(env, 'mfs:' + ym, { at: Date.now(), n: lines.length });
  }
  const rows = (await env.DB.prepare('SELECT date, account, value, remark FROM mf_lines WHERE ym = ?').bind(ym).all()).results;
  return { rows: rows.map(r => [r.date, r.account, r.value, r.remark]) };
}
async function mfTouched(env, date) { await env.DB.prepare('DELETE FROM kv WHERE k = ?').bind('mfs:' + String(date).slice(0, 7)).run(); }
const FOOD = /仕入/;

/* ---------- 口座の明細（デビットカード・引き落とし） ---------- */
// レシートと同じ金額で、まだ登録していない口座の明細を探す（支払った日の2日前〜7日後）
async function mfFindTx(env, amount, date) {
  const today = jstStamp(Date.now()).slice(0, 10);
  const end = addDays(date, 7) > today ? today : addDays(date, 7);
  const j = await mfApi(env, 'GET', '/transactions', { start_date: addDays(date, -2), end_date: end, side: 'EXPENSE', journalizing_statuses: 'none', value_min: amount, value_max: amount, per_page: 50 });
  const list = (j.transactions || []).filter(t => Number(t.value) === amount && (!t.side || t.side === 'EXPENSE') && (!t.journalizing_status || t.journalizing_status === 'none'));
  list.sort((a, b) => Math.abs(diffDays(date, a.date)) - Math.abs(diffDays(date, b.date)));
  return list[0] || null;
}
// 口座の明細から「もう登録してある」仕訳を探す（明細のボタンやマネーフォワードで先に登録したもの）。
// 口座の側（貸方）の合計がレシートの金額と同じで、まだほかのレシートと結びついていないもの
async function mfFindJournaled(env, amount, date) {
  const today = jstStamp(Date.now()).slice(0, 10);
  const end = addDays(date, 7) > today ? today : addDays(date, 7);
  const j = await mfApi(env, 'GET', '/journals', { start_date: addDays(date, -2), end_date: end, per_page: 200 });
  const used = {};
  (await env.DB.prepare("SELECT journal_id FROM receipts WHERE status = 'ok' AND journal_id != ''").all()).results.forEach(r => { used[r.journal_id] = 1; });
  const total = jr => (jr.branches || []).reduce((a, br) => a + (br.creditor ? (Number(br.creditor.value) || 0) : 0), 0);
  const list = (j.journals || []).filter(jr => jr.transaction_id && !used[jr.id] && total(jr) === amount);
  list.sort((a, b) => Math.abs(diffDays(date, a.transaction_date)) - Math.abs(diffDays(date, b.transaction_date)));
  return list[0] || null;
}
// 仕訳の中身を、レシートの内容（科目・税率・摘要・登録番号）に書き換える。口座の側はそのまま
async function mfRewrite(env, m, jid, f) {
  const g = await mfApi(env, 'GET', '/journals/' + encodeURIComponent(jid));
  const jr = g.journal || {};
  const cr = ((jr.branches || [])[0] || {}).creditor || {};
  const parts = f.rate === 'mixed' ? [['8', f.amount8], ['10', f.amount - f.amount8]] : [[f.rate, f.amount]];
  await mfApi(env, 'PUT', '/journals/' + encodeURIComponent(jid), null, { journal: {
    transaction_date: jr.transaction_date || f.date, journal_type: jr.journal_type || 'journal_entry',
    memo: [jr.memo || '', f.invoice ? '登録番号 ' + f.invoice : ''].filter(Boolean).join('・'),
    branches: parts.map(p => {
      const deb = { account_id: f.accountId, value: p[1] };
      const t = pickTax(m.taxes, p[0]);
      if (t) deb.tax_id = t;
      if (f.invoice) deb.invoice_kind = 'INVOICE_KIND_QUALIFIED';
      const c = { account_id: cr.account_id, value: p[1] };
      if (cr.sub_account_id) c.sub_account_id = cr.sub_account_id;
      return { debitor: deb, creditor: c, remark: f.remark };
    })
  } });
}
// 口座の明細とレシートを結びつける。まだ登録していない明細があればそこから仕訳を作り、
// 先に登録してあればその仕訳をレシートの内容に直す（どちらでも仕訳は1つだけ）
async function mfLinkReceipt(env, m, f) {
  const tx = await mfFindTx(env, f.amount, f.date);
  if (tx) { const res = await mfFromTx(env, m, tx, f); return Object.assign(res, { matched: clean(tx.content, 40) }); }
  const jr = await mfFindJournaled(env, f.amount, f.date);
  if (!jr) return null;
  let check = '';
  try { await mfRewrite(env, m, jr.id, f); } catch (e) { check = '登録済みの仕訳に写真は付けましたが、科目や税率は書き換えられませんでした。マネーフォワードで確かめてください。'; }
  const remark = ((jr.branches || [])[0] || {}).remark || '';
  return { jid: jr.id, check: check, matched: clean(remark || '登録済みの明細', 40), merged: true };
}
// 明細から仕訳を作る（口座の科目はマネーフォワードが決める）。8%と10%が混ざるときは、あとで2行に分ける
async function mfFromTx(env, m, tx, f) {
  const body = { transaction_id: tx.id, account_id: f.accountId, remark: f.remark };
  const tax = pickTax(m.taxes, f.rate === 'mixed' ? '8' : f.rate);
  if (tax) body.tax_id = tax;
  if (f.invoice) body.invoice_kind = 'INVOICE_KIND_QUALIFIED';
  const r = await mfApi(env, 'POST', '/transactions/journalize', null, body);
  let jid = (r.journal && r.journal.id) || r.journal_id || (r.journals && r.journals[0] && r.journals[0].id) || '';
  if (!jid) {
    const j = await mfApi(env, 'GET', '/journals', { start_date: tx.date, end_date: tx.date, transaction_ids: tx.id });
    const hit = (j.journals || []).find(x => x.transaction_id === tx.id) || (j.journals || [])[0];
    jid = hit ? hit.id : '';
  }
  let check = '';
  if (jid && f.rate === 'mixed') {
    try { await mfRewrite(env, m, jid, Object.assign({}, f, { date: tx.date })); }
    catch (e) { check = '8%と10%の分け方は登録できませんでした。マネーフォワードで直してください。'; }
  }
  return { jid: jid, check: check };
}
// 写真を証憑として仕訳に添付する（予約システムには残さない）
async function mfAttach(env, jid, date, image) {
  if (!jid || !image) return false;
  try {
    await mfApi(env, 'POST', '/vouchers', null, { journal_id: jid, voucher_files: [{ file_name: 'receipt-' + date + '.jpg', file_data: String(image).replace(/^data:[^,]*,/, '') }] });
    return true;
  } catch (e) { console.error('証憑の添付に失敗', e && e.message); return false; }
}

/* ---------- レシートの登録（今日の画面から） ---------- */
const RECEIPT_SYSTEM = [
  'あなたは、小さな飲食店の経理を手伝っています。店主は会計に詳しくありません。レシート・領収書の写真から、マネーフォワードの確定申告に経費として登録する内容を読み取ります。',
  '- date：支払った日を YYYY-MM-DD で。年がないときは今日に近い日付にする（未来にならないように）。和暦は西暦に直す。',
  '- total：支払った合計金額（税込、円、整数）。おつり・お預かりと間違えない。',
  '- payee：お店・会社の名前（支店名はなくてよい、20文字以内）。',
  '- items：買ったものを短く（例「にんじん・れんこん他」、20文字以内）。帳簿の「摘要」になる。',
  '- invoice_no：インボイスの登録番号（T＋13桁の数字）。なければ空。',
  '- rate：消費税の税率。食料品だけなら "8"、それ以外だけなら "10"、両方あれば "mixed"、税のかからないもの（切手・印紙など）は "none"、分からなければ "unknown"。',
  '- amount8・amount10：rate が "mixed" のときだけ、8%と10%それぞれの税込の金額。それ以外は 0。',
  '- payment：支払い方法。現金 "cash"、カード（デビット・クレジット）"card"、QRコード・電子マネー "qr"、分からなければ "unknown"。',
  '- account：勘定科目。必ず、渡した一覧の中から1つ選ぶ（一覧の説明を参考に）。過去の登録に同じお店があれば、それに合わせる。',
  '- reason：その科目にした理由を、会計の言葉を使わずに短く（25文字以内）。例「料理に使う野菜なので」。',
  '- unsure：読み取りに自信がない項目（"date"・"total"・"payee"・"rate"・"account" から）。',
  '- note：自信がない理由を短く（30文字以内、なければ空）。例「日付の数字がかすれています」。',
  '- readable：レシートとして読めないとき（写真がぼやけている、レシートではない）は false。'
].join('\n');
const RECEIPT_SCHEMA = strSchema({
  readable: { type: 'boolean' }, date: { type: 'string' }, total: { type: 'integer' }, payee: { type: 'string' },
  items: { type: 'string' }, invoice_no: { type: 'string' },
  rate: { type: 'string', enum: ['8', '10', 'mixed', 'none', 'unknown'] },
  amount8: { type: 'integer' }, amount10: { type: 'integer' },
  payment: { type: 'string', enum: ['cash', 'card', 'qr', 'unknown'] },
  account: { type: 'string' }, reason: { type: 'string' },
  unsure: { type: 'array', items: { type: 'string', enum: ['date', 'total', 'payee', 'rate', 'account'] } },
  note: { type: 'string' }
});

function imageBlock(b) {
  const data = String(b.image || '').replace(/^data:[^,]*,/, '');
  if (!data || data.length > 8000000 || !/^[A-Za-z0-9+/=]+$/.test(data.slice(0, 200))) fail('写真を読み込めませんでした。もう一度撮ってください。');
  const type = ['image/jpeg', 'image/png', 'image/webp'].indexOf(b.type) >= 0 ? b.type : 'image/jpeg';
  return { type: 'image', source: { type: 'base64', media_type: type, data: data } };
}
function accountList(expense) {
  return expense.map(a => a.name + (a.help ? '（' + a.help + '）' : '')).join('、');
}

async function rcptList(env) {
  const now = jstStamp(Date.now());
  const ym = now.slice(0, 7);
  const rs = await env.DB.batch([
    env.DB.prepare("SELECT COUNT(*) AS n, COALESCE(SUM(amount), 0) AS total FROM receipts WHERE status IN ('ok','wait') AND substr(created_at, 1, 7) = ?").bind(ym),
    env.DB.prepare("SELECT * FROM receipts WHERE status IN ('ok','wait') ORDER BY created_at DESC LIMIT 12"),
    env.DB.prepare("SELECT MAX(created_at) AS last FROM receipts WHERE status IN ('ok','wait')"),
    env.DB.prepare("SELECT COUNT(*) AS n FROM receipts WHERE status = 'wait'")
  ]);
  const last = rs[2].results[0].last || '';
  const tx = await kvGet(env, 'mfTxCount');
  return {
    count: rs[0].results[0].n, total: rs[0].results[0].total, waiting: rs[3].results[0].n,
    last: last, idle: last ? diffDays(last.slice(0, 10), now.slice(0, 10)) : null,
    txCount: tx ? tx.n : 0,
    items: rs[1].results.map(r => ({ id: r.id, date: r.date, amount: r.amount, payee: r.payee, account: r.account, method: r.method, at: r.created_at, status: r.status,
      old: r.status === 'wait' && diffDays(r.created_at.slice(0, 10), now.slice(0, 10)) >= 7 }))
  };
}
async function adminRcptList(env) {
  if (!env.MF_API_KEY) return { connected: false };
  // 口座の明細が届くのを待っているレシートを、ついでに結びつける（10分に1回まで）
  const at = await kvGet(env, 'rcptMatchAt');
  if (!at || Date.now() - at.at > 600000) {
    await kvPut(env, 'rcptMatchAt', { at: Date.now() });
    try { await rcptMatchWaiting(env); } catch (e) { console.error('明細との結びつけ', e && e.message); }
  }
  return { connected: true, list: await rcptList(env) };
}

async function adminRcptRead(env, b) {
  const img = imageBlock(b);
  const m = await mfMaster(env);
  const expense = await expenseOptions(env, m);
  if (!expense.length) fail('マネーフォワードに経費の勘定科目が見つかりませんでした。');
  const hist = await accountHistory(env);
  const note = await ownerNote(env);
  const today = jstStamp(Date.now()).slice(0, 10);
  const out = await claude(env, {
    system: RECEIPT_SYSTEM, effort: 'low', maxTokens: 6000,
    content: [img, { type: 'text', text: '今日：' + today + '\n勘定科目の一覧：' + accountList(expense) + '\n過去に登録したお店と科目：' + (hist.join('、') || 'なし') + (note ? '\nお店からのメモ：' + note : '') }],
    schema: RECEIPT_SCHEMA
  });
  const acc = expense.find(a => a.name === out.account) || expense.find(a => FOOD.test(a.name)) || expense[0];
  const pays = payOptions(m);
  const remember = (await kvGet(env, 'rcptPay')) || {};
  const has = k => pays.some(p => p.kind === k);
  // 事業用のカードはデビットカード。現金は前に選んだもの
  const kind = remember[out.payment] && has(remember[out.payment]) ? remember[out.payment]
    : out.payment === 'card' || out.payment === 'qr' ? 'debit' : has('cash') ? 'cash' : 'own';
  const total = Math.max(0, Number(out.total) || 0);
  const rate = out.rate === 'unknown' ? (FOOD.test(acc.name) ? '8' : '10') : out.rate;
  const inv = String(out.invoice_no || '').replace(/[^T\d]/gi, '').toUpperCase();
  return {
    read: {
      readable: out.readable !== false && total > 0,
      date: isDate(out.date) && out.date <= today ? out.date : today,
      amount: total, payee: clean(out.payee, 40), memo: clean(out.items, 40), invoiceNo: /^T\d{13}$/.test(inv) ? inv : '',
      rate: rate, amount8: Number(out.amount8) || 0, amount10: Number(out.amount10) || 0,
      payment: out.payment, accountId: acc.id, pay: kind, reason: aiText(out.reason, 60),
      unsure: (out.unsure || []).concat(out.rate === 'unknown' ? ['rate'] : []).concat(isDate(out.date) ? [] : ['date']),
      note: clean(out.note, 60)
    },
    accounts: expense, pays: pays
  };
}

// 画面から届いたレシートの内容を確かめる
function rcptForm(m, expense, b) {
  const date = String(b.date || '');
  if (!isDate(date)) fail('日付を入れてください。');
  const amount = Math.round(Number(String(b.amount || '').replace(/[^\d]/g, '')));
  if (!(amount > 0 && amount < 100000000)) fail('金額を入れてください。');
  const acc = expense.find(a => a.id === b.accountId);
  if (!acc) fail('勘定科目を選んでください。');
  const pay = PAY_KINDS.find(p => p.kind === b.pay);
  if (!pay) fail('支払い方法を選んでください。');
  const rate = ['8', '10', 'mixed', 'none'].indexOf(b.rate) >= 0 ? b.rate : '10';
  const amount8 = Math.round(Number(String(b.amount8 || '').replace(/[^\d]/g, '')) || 0);
  if (rate === 'mixed' && !(amount8 > 0 && amount8 < amount)) fail('8%と10%の金額を確かめてください。');
  const payee = clean(b.payee, 40);
  const memo = clean(b.memo, 60);
  const inv = String(b.invoiceNo || '').replace(/[^T\d]/gi, '').toUpperCase();
  return {
    date: date, amount: amount, amount8: amount8, rate: rate, accountId: acc.id, accountName: acc.name, pay: pay.kind, payLabel: pay.label,
    payee: payee, memo: memo, invoice: /^T\d{13}$/.test(inv) ? inv : '',
    remark: clean([payee, memo].filter(Boolean).join(' '), 200),
    payment: ['cash', 'card', 'qr'].indexOf(b.payment) >= 0 ? b.payment : ''
  };
}
// 現金・自分のお金：新しい仕訳を作る
async function rcptJournal(env, m, f) {
  const payName = (PAY_KINDS.find(p => p.kind === f.pay) || {}).account;
  const pay = m.accounts.find(a => a.name === payName);
  if (!pay) fail('マネーフォワードに「' + payName + '」の科目が見つかりませんでした。');
  const parts = f.rate === 'mixed' ? [['8', f.amount8], ['10', f.amount - f.amount8]] : [[f.rate, f.amount]];
  const branches = parts.map(p => {
    const tax = pickTax(m.taxes, p[0]);
    const deb = { account_id: f.accountId, value: p[1] };
    if (tax) deb.tax_id = tax;
    if (f.invoice) deb.invoice_kind = 'INVOICE_KIND_QUALIFIED';
    return { debitor: deb, creditor: { account_id: pay.id, value: p[1] }, remark: f.remark };
  });
  const r = await mfApi(env, 'POST', '/journals', null, { journal: { transaction_date: f.date, journal_type: 'journal_entry', branches: branches, memo: 'épiiの予約管理から登録' + (f.invoice ? '・登録番号 ' + f.invoice : '') } });
  const jid = (r.journal && r.journal.id) || r.id || '';
  let check = '';
  if (jid && m.method !== 'TAX_EXCLUDED') {
    try {
      const g = await mfApi(env, 'GET', '/journals/' + encodeURIComponent(jid));
      const got = ((g.journal || {}).branches || []).reduce((a, br) => a + (br.debitor ? (Number(br.debitor.value) || 0) + (Number(br.debitor.tax_value) || 0) : 0), 0);
      if (got && got !== f.amount) check = 'マネーフォワード側の金額が¥' + got.toLocaleString() + 'になっています。マネーフォワードで確かめてください。';
    } catch (e) { /* 確認できなくても登録はできている */ }
  }
  return { jid: jid, check: check };
}
function rcptRow(id, f, status, jid, extra) {
  return ["INSERT OR REPLACE INTO receipts (id, created_at, date, amount, payee, account, tax, method, memo, journal_id, status, data) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    [id, jstStamp(Date.now()), f.date, f.amount, f.payee, f.accountName, f.rate, f.payLabel, f.memo, jid || '', status, JSON.stringify(Object.assign({ form: f }, extra || {}))]];
}

async function adminRcptSave(env, b) {
  const m = await mfMaster(env);
  const f = rcptForm(m, await expenseOptions(env, m), b);
  let res = { jid: '', check: '' };
  let waiting = false;
  let matched = '';
  let merged = false;
  if (f.pay !== 'debit' && !b.keepPay) {
    // 現金・自分のお金を選んだのに、同じ金額の口座の明細がある：デビットで払ったものかもしれないので聞く
    const tx = (await mfFindTx(env, f.amount, f.date)) || (await mfFindJournaled(env, f.amount, f.date));
    if (tx) return { askDebit: { date: tx.date || tx.transaction_date, amount: f.amount, content: clean(tx.content || ((tx.branches || [])[0] || {}).remark || '口座の明細', 40) } };
  }
  if (f.pay === 'debit') {
    const link = await mfLinkReceipt(env, m, f);
    if (link) { res = link; matched = link.matched; merged = !!link.merged; }
    else waiting = true;
  } else {
    res = await rcptJournal(env, m, f);
  }
  const id = newId('P');
  if (waiting) {
    // 口座の明細がまだ届いていない：写真といっしょに預かり、明細が届いたら登録する（登録したら写真は消す）
    const row = rcptRow(id, f, 'wait', '', {});
    await env.DB.batch([
      env.DB.prepare(row[0]).bind(...row[1]),
      env.DB.prepare('INSERT OR REPLACE INTO receipt_photos (id, img) VALUES (?, ?)').bind(id, String(b.image || '').replace(/^data:[^,]*,/, '').slice(0, 1900000))
    ]);
  } else {
    const attached = await mfAttach(env, res.jid, f.date, b.image);
    const row = rcptRow(id, f, 'ok', res.jid, { matched: matched, merged: merged });
    await env.DB.prepare(row[0]).bind(...row[1]).run();
    res.attached = attached;
  }
  if (f.payment) {
    const remember = (await kvGet(env, 'rcptPay')) || {};
    remember[f.payment] = f.pay;
    await kvPut(env, 'rcptPay', remember);
  }
  await mfTouched(env, f.date);
  return { check: res.check, attached: !!res.attached, waiting: waiting, matched: matched, merged: merged, list: await rcptList(env) };
}

// 明細を待っているレシートを、届いた明細と結びつけて登録する（画面を開いたとき・定期実行）
async function rcptMatchWaiting(env) {
  if (!env.MF_API_KEY) return 0;
  const rows = (await env.DB.prepare("SELECT * FROM receipts WHERE status = 'wait' OR (status = 'ok' AND data LIKE '%\"forced\":true%' AND created_at >= ?) ORDER BY created_at LIMIT 40").bind(addDays(jstStamp(Date.now()).slice(0, 10), -180)).all()).results;
  if (!rows.length) return 0;
  const m = await mfMaster(env);
  let n = 0;
  for (const r of rows.filter(x => x.status === 'wait')) {
    const d = JSON.parse(r.data || '{}');
    const f = d.form;
    if (!f) continue;
    const res = await mfLinkReceipt(env, m, f);
    if (!res) continue;
    const ph = await env.DB.prepare('SELECT img FROM receipt_photos WHERE id = ?').bind(r.id).first();
    await mfAttach(env, res.jid, f.date, ph ? ph.img : '');
    await env.DB.batch([
      env.DB.prepare("UPDATE receipts SET status = 'ok', journal_id = ?, data = ? WHERE id = ?").bind(res.jid, JSON.stringify(Object.assign(d, { matched: res.matched, merged: !!res.merged })), r.id),
      env.DB.prepare('DELETE FROM receipt_photos WHERE id = ?').bind(r.id)
    ]);
    await mfTouched(env, f.date);
    n++;
  }
  // 明細を待たずに登録したレシートに、あとから明細が届いた：明細から仕訳を作り直して、先に作った仕訳は消す
  for (const r of rows.filter(x => x.status === 'ok')) {
    const d = JSON.parse(r.data || '{}');
    const tx = d.form && await mfFindTx(env, d.form.amount, d.form.date);
    if (!tx) continue;
    const res = await mfFromTx(env, m, tx, d.form);
    if (!res.jid) continue;
    const ph = await env.DB.prepare('SELECT img FROM receipt_photos WHERE id = ?').bind(r.id).first();
    await mfAttach(env, res.jid, d.form.date, ph ? ph.img : '');
    if (r.journal_id) { try { await mfApi(env, 'DELETE', '/journals/' + encodeURIComponent(r.journal_id)); } catch (e) { console.error('先に作った仕訳を消せませんでした', e && e.message); } }
    await env.DB.batch([
      env.DB.prepare('UPDATE receipts SET journal_id = ?, data = ? WHERE id = ?').bind(res.jid, JSON.stringify(Object.assign(d, { forced: false, matched: clean(tx.content, 40) })), r.id),
      env.DB.prepare('DELETE FROM receipt_photos WHERE id = ?').bind(r.id)
    ]);
    await mfTouched(env, d.form.date);
    n++;
  }
  // 半年たっても明細が来ないものは、写真だけ片付ける（仕訳はそのまま）
  await env.DB.prepare("DELETE FROM receipt_photos WHERE id IN (SELECT id FROM receipts WHERE status = 'ok' AND created_at < ?)").bind(addDays(jstStamp(Date.now()).slice(0, 10), -180)).run();
  return n;
}
// 明細を待たずに登録する（口座の明細が来ないとき。普通預金で登録）
async function adminRcptForce(env, b) {
  const r = await env.DB.prepare("SELECT * FROM receipts WHERE id = ? AND status = 'wait'").bind(String(b.id || '')).first();
  if (!r) fail('レシートが見つかりません。画面を更新してください。');
  const m = await mfMaster(env);
  const d = JSON.parse(r.data || '{}');
  // 押す直前にもう一度、口座の明細（登録済みのものも）を探す。見つかれば新しい仕訳は作らない
  const link = await mfLinkReceipt(env, m, d.form);
  if (link) {
    const ph0 = await env.DB.prepare('SELECT img FROM receipt_photos WHERE id = ?').bind(r.id).first();
    await mfAttach(env, link.jid, d.form.date, ph0 ? ph0.img : '');
    await env.DB.batch([
      env.DB.prepare("UPDATE receipts SET status = 'ok', journal_id = ?, data = ? WHERE id = ?").bind(link.jid, JSON.stringify(Object.assign(d, { matched: link.matched, merged: !!link.merged })), r.id),
      env.DB.prepare('DELETE FROM receipt_photos WHERE id = ?').bind(r.id)
    ]);
    await mfTouched(env, d.form.date);
    return { matched: link.matched, list: await rcptList(env) };
  }
  const bank = m.accounts.find(a => a.name === '普通預金');
  if (!bank) fail('マネーフォワードに「普通預金」の科目が見つかりませんでした。');
  const parts = d.form.rate === 'mixed' ? [['8', d.form.amount8], ['10', d.form.amount - d.form.amount8]] : [[d.form.rate, d.form.amount]];
  const rr = await mfApi(env, 'POST', '/journals', null, { journal: { transaction_date: d.form.date, journal_type: 'journal_entry', memo: 'épiiの予約管理から登録', branches: parts.map(p => {
    const deb = { account_id: d.form.accountId, value: p[1] };
    const t = pickTax(m.taxes, p[0]);
    if (t) deb.tax_id = t;
    return { debitor: deb, creditor: { account_id: bank.id, value: p[1] }, remark: d.form.remark };
  }) } });
  const jid = (rr.journal && rr.journal.id) || rr.id || '';
  const ph = await env.DB.prepare('SELECT img FROM receipt_photos WHERE id = ?').bind(r.id).first();
  await mfAttach(env, jid, d.form.date, ph ? ph.img : '');
  // 写真は残しておく：あとから口座の明細が届いたら、明細から作った仕訳に付け替える（二重にしない）
  await env.DB.prepare("UPDATE receipts SET status = 'ok', journal_id = ?, data = ? WHERE id = ?").bind(jid, JSON.stringify(Object.assign(d, { forced: true })), r.id).run();
  await mfTouched(env, d.form.date);
  return { list: await rcptList(env) };
}

async function adminRcptUndo(env, b) {
  const r = await env.DB.prepare("SELECT * FROM receipts WHERE id = ? AND status IN ('ok','wait')").bind(String(b.id || '')).first();
  if (!r) fail('取り消すレシートが見つかりません。');
  const d = JSON.parse(r.data || '{}');
  if (r.status === 'ok' && r.journal_id) {
    // 口座の明細から作った仕訳は、消すと明細が「まだ登録していない」に戻る
    await mfApi(env, 'DELETE', '/journals/' + encodeURIComponent(r.journal_id));
  }
  await env.DB.batch([
    env.DB.prepare("UPDATE receipts SET status = 'deleted' WHERE id = ?").bind(r.id),
    env.DB.prepare('DELETE FROM receipt_photos WHERE id = ?').bind(r.id)
  ]);
  await mfTouched(env, r.date);
  void d;
  return { list: await rcptList(env) };
}

/* ---------- まだ登録していない口座の明細（引き落とし・デビットカード） ---------- */
const TX_SYSTEM = [
  'あなたは、小さな飲食店の経理を手伝っています。店主は会計に詳しくありません。',
  '銀行口座から出たお金の明細（デビットカードの支払い・引き落とし・振込）の内容から、経費の勘定科目を選びます。',
  '- account：必ず渡した一覧の中から1つ。過去の登録に同じ相手があれば合わせる。',
  '- rate：消費税。食材・飲み物なら "8"、ほとんどの経費は "10"、税のかからないもの（振込手数料以外の税金・保険料・家賃の一部など）は "none"。',
  '- reason：理由を会計の言葉を使わずに短く（25文字以内）。',
  '- unsure：明細の名前だけでは分からないとき true（例：個人名への振込、略称で分からない）。'
].join('\n');
async function adminMfTx(env, b) {
  if (!env.MF_API_KEY) return { connected: false };
  const today = jstStamp(Date.now()).slice(0, 10);
  const m = await mfMaster(env);
  // 確定申告の年の分はすべて見る（1〜3月は前の年の1月から）
  const y = Number(today.slice(0, 4)) - (Number(today.slice(5, 7)) <= 3 ? 1 : 0);
  const all = [];
  for (let page = 1; page <= 10; page++) {
    const j = await mfApi(env, 'GET', '/transactions', { start_date: y + '-01-01', end_date: today, side: 'EXPENSE', journalizing_statuses: 'none', order: 'desc', per_page: 200, page: page });
    all.push(...(j.transactions || []));
    const pages = j.metadata && Number(j.metadata.total_pages);
    if (!pages || page >= pages || !(j.transactions || []).length) break;
  }
  let list = all.filter(t => (!t.side || t.side === 'EXPENSE') && (!t.journalizing_status || t.journalizing_status === 'none'))
    .map(t => ({ id: String(t.id), date: t.date, amount: Number(t.value) || 0, content: clean(t.content, 60) }))
    .filter(t => t.amount > 0).sort((a, x) => x.date.localeCompare(a.date));
  await kvPut(env, 'mfTxCount', { n: list.length, at: Date.now() });
  // レシートを預かっている（明細を待っている）ものは、レシートの側で登録するので印を付ける
  // 明細を待たずに登録したものも、レシートの側で付け替えるので同じ扱い
  const waits = (await env.DB.prepare("SELECT date, amount FROM receipts WHERE status = 'wait' OR (status = 'ok' AND data LIKE '%\"forced\":true%')").all()).results;
  const total = list.length;
  list = list.slice(0, 50);
  list.forEach(t => { t.receipt = waits.some(w => w.amount === t.amount && diffDays(w.date, t.date) >= -2 && diffDays(w.date, t.date) <= 7); });
  // 現金・自分のお金で登録したレシートと同じ金額・近い日付の明細は、同じ支払いかもしれない（二重の登録に注意）
  const oks = (await env.DB.prepare("SELECT date, amount, payee, method, data FROM receipts WHERE status = 'ok' AND date >= ?").bind(addDays(today, -70)).all()).results
    .filter(r => { try { return JSON.parse(r.data || '{}').form.pay !== 'debit'; } catch (e) { return false; } });
  list.forEach(t => {
    const r = oks.find(x => x.amount === t.amount && diffDays(x.date, t.date) >= -2 && diffDays(x.date, t.date) <= 7);
    if (r) t.dupe = { date: r.date, payee: r.payee || '', method: r.method || '' };
  });
  const expense = await expenseOptions(env, m);
  // Claude の科目の提案（作ってあるものは使い回す）
  const keys = list.map(t => 'tx:' + t.id);
  const hits = {};
  if (keys.length) (await env.DB.prepare('SELECT k, v FROM ai_cache WHERE k IN (' + keys.map(() => '?').join(',') + ')').bind(...keys).all()).results
    .forEach(r => { try { hits[r.k.slice(3)] = JSON.parse(r.v); } catch (e) { /* 何もしない */ } });
  const need = list.filter(t => !hits[t.id] && !t.receipt);
  if (need.length && env.ANTHROPIC_API_KEY && b.suggest !== false) {
    try {
      const hist = await accountHistory(env);
      const out = await claude(env, {
        system: TX_SYSTEM, effort: 'low', maxTokens: 8000,
        content: [{ type: 'text', text: '勘定科目の一覧：' + accountList(expense) + '\n過去に登録した相手と科目：' + (hist.join('、') || 'なし') +
          '\n\n明細（id｜日付｜内容｜金額）：\n' + need.map(t => t.id + '｜' + t.date + '｜' + t.content + '｜¥' + t.amount).join('\n') }],
        schema: strSchema({ items: { type: 'array', items: strSchema({ id: { type: 'string' }, account: { type: 'string' }, rate: { type: 'string', enum: ['8', '10', 'none'] }, reason: { type: 'string' }, unsure: { type: 'boolean' } }) } })
      });
      for (const x of out.items || []) {
        const a = expense.find(e => e.name === x.account);
        if (!a || !need.some(t => t.id === x.id)) continue;
        hits[x.id] = { accountId: a.id, rate: x.rate, reason: aiText(x.reason, 60), unsure: !!x.unsure };
        await aiCachePut(env, 'tx:' + x.id, '', hits[x.id]);
      }
    } catch (e) { if (!e.userFacing) throw e; }
  }
  list.forEach(t => { t.ai = hits[t.id] || null; });
  return { connected: true, list: list, total: total, accounts: expense };
}
async function adminMfTxSave(env, b) {
  const m = await mfMaster(env);
  const expense = await expenseOptions(env, m);
  const acc = expense.find(a => a.id === b.accountId);
  if (!acc) fail('勘定科目を選んでください。');
  const tx = { id: String(b.id || ''), date: String(b.date || ''), content: clean(b.content, 60) };
  if (!tx.id || !isDate(tx.date)) fail('明細が見つかりません。画面を更新してください。');
  const rate = ['8', '10', 'none'].indexOf(b.rate) >= 0 ? b.rate : '10';
  await mfFromTx(env, m, tx, { accountId: acc.id, rate: rate, remark: clean(b.memo || tx.content, 200) });
  await mfTouched(env, tx.date);
  const left = await kvGet(env, 'mfTxCount');
  if (left && left.n) await kvPut(env, 'mfTxCount', { n: left.n - 1, at: left.at });
  return { ok: true };
}

/* ---------- Claudeに相談（勘定科目・支払い方法など） ---------- */
const ASK_SYSTEM = [
  'あなたは、会計に詳しくない飲食店の店主の相談相手です。マネーフォワードで確定申告をしています。事業用のカードはデビットカードです。',
  '- やさしい言葉で、3文以内で答える。会計の言葉を使うときは、ひとことで説明を添える。',
  '- 勘定科目を聞かれたら、渡した一覧の中から1つおすすめを account に入れる（なければ空）。',
  '- 迷うものは「どちらでも大きな問題はない」など安心できる言い方で。税金の最終的な判断が必要なときだけ、税理士や税務署への確認をすすめる。',
  '- ' + AI_BREAK_RULE
].join('\n');
async function adminAiAsk(env, b) {
  const q = clean(b.question, 300);
  if (!q) fail('聞きたいことを入れてください。');
  const m = env.MF_API_KEY ? await mfMaster(env) : { accounts: [] };
  const expense = env.MF_API_KEY ? await expenseOptions(env, m) : [];
  const note = await ownerNote(env);
  const ctx = b.context || {};
  const facts = [
    '勘定科目の一覧：' + (accountList(expense) || 'なし'),
    note ? 'お店からのメモ：' + note : '',
    '相談しているもの：' + [ctx.payee, ctx.content, ctx.items, ctx.amount ? '¥' + num0(ctx.amount) : '', ctx.date, ctx.account ? '今の科目：' + ctx.account : '', ctx.pay ? '支払い方法：' + ctx.pay : ''].filter(Boolean).map(x => clean(x, 80)).join('、')
  ].filter(Boolean).join('\n');
  const msgs = [];
  (Array.isArray(b.history) ? b.history : []).slice(-4).forEach(h => { msgs.push('店主：' + clean(h.q, 300)); msgs.push('あなた：' + plain(clean(h.a, 400))); });
  const out = await claude(env, {
    system: ASK_SYSTEM, effort: 'low', maxTokens: 4000,
    content: [{ type: 'text', text: facts + (msgs.length ? '\n\nここまでのやりとり：\n' + msgs.join('\n') : '') + '\n\n店主の質問：' + q }],
    schema: strSchema({ answer: { type: 'string' }, account: { type: 'string' } })
  });
  const a = expense.find(e => e.name === out.account);
  return { answer: aiText(out.answer, 400), accountId: a ? a.id : '', account: a ? a.name : '' };
}
function num0(v) { return (Number(String(v).replace(/[^\d]/g, '')) || 0).toLocaleString(); }

/* ---------- 売上・経費の数字 ---------- */
function moneyPeriod(key, today) {
  const cur = today.slice(0, 7);
  if (key === 'last') {
    const ym = addMonths(cur, -1);
    const pv = addMonths(cur, -2);
    return { key: key, from: ym + '-01', to: monthLast(ym), prevFrom: pv + '-01', prevTo: monthLast(pv), label: Number(ym.slice(5)) + '月', prevLabel: Number(pv.slice(5)) + '月' };
  }
  if (key === '3m') {
    const a = addMonths(cur, -3);
    const p = addMonths(cur, -6);
    return { key: key, from: a + '-01', to: monthLast(addMonths(cur, -1)), prevFrom: p + '-01', prevTo: monthLast(addMonths(cur, -4)), label: Number(a.slice(5)) + '〜' + Number(addMonths(cur, -1).slice(5)) + '月', prevLabel: 'その前の3か月' };
  }
  // 今月：先月の同じ日までと比べる
  const pv = addMonths(cur, -1);
  const day = Math.min(Number(today.slice(8)), Number(monthLast(pv).slice(8)));
  return { key: 'month', from: cur + '-01', to: today, prevFrom: pv + '-01', prevTo: pv + '-' + pad(day), label: '今月（' + Number(today.slice(8)) + '日まで）', prevLabel: '先月の同じ日まで' };
}
async function salesSums(env, from, to) {
  const r = await env.DB.prepare(
    "SELECT COALESCE(SUM(amount - refunded), 0) AS sales, COALESCE(SUM(CASE WHEN link IN ('auto','res') THEN amount - refunded ELSE 0 END), 0) AS res, " +
    "COUNT(*) AS n, COALESCE(SUM(CASE WHEN link IN ('auto','res') THEN 0 ELSE 1 END), 0) AS walkN, COUNT(DISTINCT CASE WHEN link IN ('auto','res') THEN res_id END) AS resGroups FROM sq_payments WHERE status = 'COMPLETED' AND amount > refunded AND date BETWEEN ? AND ?"
  ).bind(from, to).first();
  const g = await env.DB.prepare(
    "SELECT COALESCE(SUM(guests), 0) AS guests, COUNT(*) AS groups FROM reservations WHERE status = '確定' AND (arrived IS NULL OR arrived != 'no') AND date BETWEEN ? AND ? AND date <= ?"
  ).bind(from, to, jstStamp(Date.now()).slice(0, 10)).first();
  return { sales: r.sales, res: r.res, walk: r.sales - r.res, payments: r.n, walkN: r.walkN, resGroups: r.resGroups || 0, guests: g.guests, groups: g.groups };
}
function expenseSums(monthsData, from, to) {
  const by = {};
  const payees = {};
  let total = 0;
  let food = 0;
  monthsData.forEach(md => (md ? md.rows : []).forEach(x => {
    if (x[0] < from || x[0] > to) return;
    by[x[1]] = (by[x[1]] || 0) + x[2];
    total += x[2];
    if (FOOD.test(x[1])) food += x[2];
    const p = String(x[3] || '').split(/\s/)[0].slice(0, 14);
    if (p) payees[p] = (payees[p] || 0) + x[2];
  }));
  return {
    total: total, food: food,
    accounts: Object.keys(by).map(k => ({ name: k, value: by[k] })).filter(x => x.value).sort((a, b) => b.value - a.value),
    payees: Object.keys(payees).map(k => ({ name: k, value: payees[k] })).filter(x => x.value > 0).sort((a, b) => b.value - a.value).slice(0, 8)
  };
}
function mfAge(ym, cur, force) {
  return force && ym >= addMonths(cur, -1) ? 0 : ym === cur ? 600000 : ym === addMonths(cur, -1) ? 6 * 3600000 : 7 * 86400000;
}
async function loadMoneyData(env, months, force) {
  const f = features(env);
  const cur = jstStamp(Date.now()).slice(0, 7);
  let sqErr = '';
  let mfErr = '';
  if (f.square) { try { await sqEnsure(env, months, force ? 0 : 600000); } catch (e) { if (!e.userFacing) throw e; sqErr = e.message; } }
  const mfData = {};
  if (f.mf) {
    try { await eachLimit(months, 3, async ym => { mfData[ym] = await mfMonth(env, ym, mfAge(ym, cur, force)); }); }
    catch (e) { if (!e.userFacing) throw e; mfErr = e.message; }
  }
  return { sqErr: sqErr, mfErr: mfErr, mf: mfData, hasSales: f.square && !sqErr, hasExpense: f.mf && !mfErr };
}

async function adminMoney(env, b) {
  const f = features(env);
  const today = jstStamp(Date.now()).slice(0, 10);
  const cur = today.slice(0, 7);
  const P = moneyPeriod(String(b.period || 'month'), today);
  const chartMonths = [];
  for (let i = 5; i >= 0; i--) chartMonths.push(addMonths(cur, -i));
  const need = monthsBetween(P.prevFrom < chartMonths[0] + '-01' ? P.prevFrom : chartMonths[0] + '-01', today);
  const D = await loadMoneyData(env, need, b.force);
  const all = Object.values(D.mf);
  const [now, prev] = await Promise.all([salesSums(env, P.from, P.to), salesSums(env, P.prevFrom, P.prevTo)]);
  const ex = expenseSums(all, P.from, P.to);
  const exPrev = expenseSums(all, P.prevFrom, P.prevTo);
  const months = await Promise.all(chartMonths.map(async ym => {
    const s = await salesSums(env, ym + '-01', monthLast(ym));
    return { ym: ym, sales: s.sales, expense: D.mf[ym] ? expenseSums([D.mf[ym]], ym + '-01', monthLast(ym)).total : null };
  }));
  const st = (await kvGet(env, 'sqMonths')) || {};
  return {
    features: f, sqErr: D.sqErr, mfErr: D.mfErr, period: P,
    now: Object.assign(now, { expense: ex.total, food: ex.food }),
    prev: Object.assign(prev, { expense: exPrev.total, food: exPrev.food }),
    expenses: ex.accounts, payees: ex.payees, months: months,
    hasExpense: D.hasExpense, hasSales: D.hasSales,
    insight: await kvGet(env, 'ai:money'), syncedAt: st[cur] ? jstStamp(st[cur]) : ''
  };
}

/* ---------- 分析：まとめ（全体）と、予約・Instagram・売上経費ごとの気づき ----------
 * Claude は前のやりとりを覚えていないので、毎回「前回の気づきとやること」と「お店からのメモ」を添えて、続きとして考えてもらう
 */
async function factsHead(env) {
  const today = jstStamp(Date.now()).slice(0, 10);
  const s = await getSettings(env);
  const note = await ownerNote(env);
  return [
    '今日：' + jdLong(today),
    'お店：大阪・阿倍野の薬膳レストラン、' + s.seats + '席、店主ひとり。予約はLINEのリクエスト制（お店が承認して確定）。',
    'いつもの営業：' + WD.split('').map((w, i) => w + '曜 ' + ((s.weekly[String(i)] || []).map(k => sessionLabel(s, k)).join('・') || '休み')).join('、'),
    note ? 'お店からのメモ（覚えておいてほしいこと）：' + note : ''
  ].filter(Boolean).join('\n');
}
async function factsMoney(env) {
  const f = features(env);
  const today = jstStamp(Date.now()).slice(0, 10);
  const cur = today.slice(0, 7);
  const s = await getSettings(env);
  const months = [];
  for (let i = 5; i >= 0; i--) months.push(addMonths(cur, -i));
  const D = await loadMoneyData(env, months, false);
  const lines = ['【売上と経費】売上はSquareのレジ、経費はマネーフォワードの仕訳。'];
  if (D.sqErr) lines.push('Squareの取り込みエラー：' + D.sqErr);
  if (D.mfErr) lines.push('マネーフォワードの取り込みエラー：' + D.mfErr);
  if (!D.hasSales) lines.push('売上のデータはありません。');
  if (!D.hasExpense) lines.push('経費のデータはありません。');
  lines.push('月ごと（今月は今日まで）：');
  for (const ym of months) {
    const x = await salesSums(env, ym + '-01', ym === cur ? today : monthLast(ym));
    const e = D.mf[ym] ? expenseSums([D.mf[ym]], ym + '-01', monthLast(ym)) : null;
    const parts = [ym];
    if (D.hasSales) parts.push('売上 ¥' + x.sales.toLocaleString() + '（会計 ' + x.payments + '件、1会計あたり ¥' + (x.payments ? Math.round(x.sales / x.payments) : 0).toLocaleString() +
      '、予約の会計 ¥' + x.res.toLocaleString() + (x.resGroups ? '（' + x.resGroups + '組、1組あたり ¥' + Math.round(x.res / x.resGroups).toLocaleString() + '。割り勘など1組で複数の会計も1組として数える）' : '') + '、予約なしの会計 ' + x.walkN + '件 ¥' + x.walk.toLocaleString() + '）');
    parts.push('予約の来店 ' + x.groups + '組 ' + x.guests + '名' + (D.hasSales && x.guests ? '（予約の1人あたり ¥' + Math.round(x.res / x.guests).toLocaleString() + '）' : ''));
    if (e) parts.push('経費 ¥' + e.total.toLocaleString() + '（食材の仕入れ ¥' + e.food.toLocaleString() + (D.hasSales && x.sales ? '、食材費の割合 ' + Math.round(e.food / x.sales * 100) + '%' : '') + '）、科目別：' +
      e.accounts.slice(0, 8).map(a => a.name + ' ¥' + a.value.toLocaleString()).join('・'));
    if (D.hasSales && e) parts.push('残り（売上－経費）¥' + (x.sales - e.total).toLocaleString());
    lines.push('・' + parts.join('、'));
  }
  const P = moneyPeriod('month', today);
  const a = await salesSums(env, P.from, P.to);
  const b = await salesSums(env, P.prevFrom, P.prevTo);
  lines.push('今月（' + Number(P.to.slice(8)) + '日まで）と先月の同じ日まで：売上 ¥' + a.sales.toLocaleString() + ' / ¥' + b.sales.toLocaleString() + '、予約の来店 ' + a.guests + '名 / ' + b.guests + '名');
  if (D.hasExpense) {
    const all = Object.values(D.mf);
    const p3 = expenseSums(all, addMonths(cur, -3) + '-01', today);
    if (p3.payees.length) lines.push('直近3か月の主な支払先：' + p3.payees.map(x => x.name + ' ¥' + x.value.toLocaleString()).join('、'));
  }
  // 曜日・時間帯ごと（直近8週）
  const from8 = addDays(today, -56);
  const rs = await env.DB.batch([
    env.DB.prepare("SELECT date, ts, amount - refunded AS v, link FROM sq_payments WHERE status = 'COMPLETED' AND amount > refunded AND date BETWEEN ? AND ?").bind(from8, today),
    env.DB.prepare("SELECT date, session, guests, course_name FROM reservations WHERE date BETWEEN ? AND ? AND status = '確定' AND (arrived IS NULL OR arrived != 'no')").bind(from8, addDays(today, -1))
  ]);
  const sessOf = hm => {
    const m = toMin(hm);
    const keys = sessionKeys(s);
    return keys.find(k => toMin(s.sessions[k].open) - 30 <= m && m < toMin(s.sessions[k].close) + 90) || keys[keys.length - 1];
  };
  const ws = {};
  const cell = (d, k) => { const id = WD[weekday(d)] + '曜' + sessionLabel(s, k); return ws[id] || (ws[id] = { sales: 0, n: 0, walk: 0, walkN: 0, guests: 0, days: {} }); };
  if (D.hasSales) rs[0].results.forEach(p => { const c = cell(p.date, sessOf(p.ts.slice(11, 16))); c.sales += p.v; c.n++; c.days[p.date] = 1; if (!(p.link === 'auto' || p.link === 'res')) { c.walk += p.v; c.walkN++; } });
  const courses = {};
  rs[1].results.forEach(r => { const c = cell(r.date, r.session); c.guests += r.guests; courses[r.course_name] = (courses[r.course_name] || 0) + r.guests; });
  if (D.hasSales) {
    lines.push('直近8週の曜日・時間帯ごと（合計）：');
    Object.keys(ws).forEach(k => { const c = ws[k]; lines.push('・' + k + '：売上 ¥' + c.sales.toLocaleString() + '（営業 ' + Object.keys(c.days).length + '回、会計 ' + c.n + '件、予約なし ' + c.walkN + '件 ¥' + c.walk.toLocaleString() + '）、予約の来店 ' + c.guests + '名'); });
    const daily = {};
    rs[0].results.forEach(p => { if (p.date >= addDays(today, -13)) daily[p.date] = (daily[p.date] || 0) + p.v; });
    lines.push('直近2週間の日ごとの売上：' + Object.keys(daily).sort().map(d => jdShort(d) + ' ¥' + daily[d].toLocaleString()).join('、'));
  }
  lines.push('メニューごとの来店人数（直近8週）：' + (Object.keys(courses).map(k => k + ' ' + courses[k] + '名').join('、') || 'なし'));
  const menu = (await allCourses(env)).filter(c => c.visible).map(c => c.name + ' ¥' + Number(c.price).toLocaleString() + (c.price_type === 'from' ? '〜' : ''));
  lines.push('メニューと料金：' + menu.join('、'));
  return lines.join('\n');
}
async function factsBooking(env) {
  const today = jstStamp(Date.now()).slice(0, 10);
  const s = await getSettings(env);
  const lines = ['【予約と予約ページ】'];
  lines.push('締切：予約は' + s.cutoff.days + '日前、変更は' + s.changeCutoff.days + '日前、ネットでのキャンセルは' + s.cancelDays + '日前まで。受付は' + (s.openUntil ? jdLong(s.openUntil) + 'まで' : s.aheadDays + '日先まで'));
  const from8 = addDays(today, -56);
  const rs = await env.DB.batch([
    env.DB.prepare("SELECT date, session, guests, status, arrived, course_name, source, created_at FROM reservations WHERE date BETWEEN ? AND ? AND status IN ('確定','キャンセル','お断り')").bind(from8, addDays(today, -1)),
    env.DB.prepare('SELECT COUNT(*) AS n FROM change_requests WHERE created_at >= ?').bind(from8)
  ]);
  const ws = {};
  const cell = (d, k) => { const id = WD[weekday(d)] + '曜' + sessionLabel(s, k); return ws[id] || (ws[id] = { guests: 0, groups: 0, cancel: 0, noshow: 0, ng: 0 }); };
  const src = {};
  let lead = 0, leadN = 0;
  rs[0].results.forEach(r => {
    const c = cell(r.date, r.session);
    if (r.status === 'キャンセル') c.cancel++;
    else if (r.status === 'お断り') c.ng++;
    else if (r.arrived === 'no') c.noshow++;
    else { c.guests += r.guests; c.groups++; src[r.source || '不明'] = (src[r.source || '不明'] || 0) + 1; if (r.created_at) { lead += diffDays(r.created_at.slice(0, 10), r.date); leadN++; } }
  });
  lines.push('直近8週の曜日・時間帯ごと（合計）：');
  Object.keys(ws).forEach(k => { const c = ws[k]; lines.push('・' + k + '：来店 ' + c.groups + '組 ' + c.guests + '名、キャンセル ' + c.cancel + '件、来店なし ' + c.noshow + '件、満席でお断り ' + c.ng + '件'); });
  lines.push('予約の入り方：' + Object.keys(src).map(k => k + ' ' + src[k] + '件').join('、') + (leadN ? '、平均 ' + Math.round(lead / leadN) + '日前に予約' : '') + '、変更の申し込み ' + rs[1].results[0].n + '件');
  const w = await loadWindow(env, today, addDays(today, 13));
  const idx = buildIndex(w.holds, w.blocks, s);
  const end = bookingEnd(s, today);
  const nowStamp = jstStamp(Date.now());
  const open = [];
  for (let i = 0; i < 14; i++) {
    const d = addDays(today, i);
    if (d > end) break;
    const per = {};
    daySlots(d, w.rules, s).forEach(x => {
      if (nowStamp >= d + ' ' + x.time) return;
      const left = leftAt(idx, d, x.time, x.session, null, s);
      if (per[x.session] === undefined || per[x.session] < left) per[x.session] = left;
    });
    Object.keys(per).forEach(k => open.push(jdShort(d) + '（' + WD[weekday(d)] + '）' + sessionLabel(s, k) + ' 空き' + per[k] + '席'));
  }
  lines.push('これから2週間の空き（各時間帯のいちばん空いている時間）：' + (open.join('、') || '受付中の日がありません'));
  if (s.openUntil && diffDays(today, s.openUntil) <= 14) lines.push('受付の最終日が近い：' + jdLong(s.openUntil));
  try {
    const an = await adminAnalytics(env, { days: 30 });
    const f = an.funnel;
    lines.push('予約ページ（直近30日）：開かれた ' + an.totals.opens + '回、見た人 ' + an.totals.users + '人、日付を選んだ ' + f.date + '人、時間 ' + f.time + '人、メニュー ' + f.course + '人、リクエスト ' + f.request + '人');
    lines.push('満席・締切で選べなかった日：' + (an.blocked.map(x => jdShort(x.date) + (x.reason === '×' ? '満席' : x.reason) + ' ' + x.users + '人').join('、') || 'なし'));
    lines.push('どこから：' + (an.sources.slice(0, 6).map(x => x.src + ' ' + x.users + '人').join('、') || 'なし'));
    lines.push('メニューを見た人とリクエスト：' + (an.courses.map(x => x.name + ' ' + x.users + '人/' + x.requests + '件').join('、') || 'なし'));
    lines.push('何度も見ているのに予約していない人：' + an.lookers.length + '人');
  } catch (e) { /* なくても続ける */ }
  return lines.join('\n');
}
async function factsIg(env) {
  const today = jstStamp(Date.now()).slice(0, 10);
  const lines = ['【Instagram】'];
  try {
    const d = await adminIgStats(env, { days: 30 });
    if (!d.connected) return lines.concat('Instagramはつながっていません。').join('\n');
    const first = d.daily.find(x => x.opens > 0);
    lines.push('直近30日：フォロワー ' + (d.account ? d.account.followers : '不明') + '人、リーチ合計 ' + d.daily.reduce((a, x) => a + (x.reach || 0), 0) +
      '、プロフィール訪問 ' + d.daily.reduce((a, x) => a + (x.profileViews || 0), 0) + '、リンクのタップ ' + d.daily.reduce((a, x) => a + (x.linkTaps || 0), 0) +
      '、Instagramから予約ページ ' + d.daily.reduce((a, x) => a + (x.igOpens || 0), 0) + '回');
    lines.push('日ごと（日付｜リーチ｜予約ページを開いた回数｜ストーリー数｜投稿数）' + (first ? '。予約ページの記録は' + jdShort(first.date) + 'から' : '') + '：');
    lines.push(d.daily.map(x => jdShort(x.date) + '｜' + (x.reach ?? '-') + '｜' + x.opens + '｜' + x.stories + '｜' + x.posts).join('、'));
    lines.push('投稿ごと（新しい順、種類｜日時｜リーチ｜保存｜出したあと24時間の予約ページ）：');
    (d.media || []).slice(0, 15).forEach(m => lines.push('・' + ({ feed: '投稿', reel: 'リール', story: 'ストーリー' }[m.kind] || m.kind) + '｜' + m.ts + '｜' + (m.reach ?? '-') + '｜' + (m.saves ?? '-') + '｜' + m.visits + '｜' + clean(m.caption, 30)));
    lines.push('告知の候補（空き）：' + (d.openings.map(o => jdShort(o.date) + o.session + ' 空き' + o.left).join('、') || 'なし'));
  } catch (e) { lines.push('Instagramのデータを読めませんでした。'); }
  void today;
  return lines.join('\n');
}

const SECTION = {
  summary: { label: 'まとめ', focus: 'お店全体（売上・経費・予約・Instagram）を見て、今週いちばん大事なことを3つ選ぶ。できるだけ違う分野から選び、損益（売上を増やす・経費を減らす・空席を埋める）につながる順に並べる。' },
  money: { label: '売上・経費', focus: '売上と経費だけを見る（予約ページの閲覧やInstagramには触れない）。売上の増減と理由（曜日・時間帯・予約の会計と予約なしの会計・1人あたり・1会計あたり）、経費（食材費の割合・大きい科目・増えた科目・主な支払先）、残り（売上－経費）を、数字をはっきり示して書く。3〜4つ。' },
  booking: { label: '予約', focus: '予約と予約ページだけを見る（売上の金額やInstagramには触れない）。混む・空く曜日と時間帯、キャンセル・来店なし、満席で断った需要、予約ページのどこで離れているか、受付の期間や締切。3〜4つ。' },
  ig: { label: 'Instagram', focus: 'Instagramだけを見る。届いている人数の動き、どんな投稿・ストーリーが予約ページにつながったか、出す頻度や時間、空きの告知。3〜4つ。' }
};
const ANALYSIS_SYSTEM = [
  'あなたは、大阪・阿倍野の小さな薬膳レストラン「épii」（店主ひとりで営業）の経営を手伝う相談役です。店主は数字や会計の言葉が得意ではありません。',
  '渡す数字を読み、気づきと、それぞれに今週できる「やること」を1つずつ書きます。',
  '',
  '書き方：',
  '- title：何が起きているかを1文で（40文字以内）。数字を入れる。例「食材費の割合が31%から35%に上がっています」',
  '- body：そう言える根拠の数字を2文以内で（100文字以内）。データにないことは書かない。推測するときは「〜かもしれません」。',
  '- todo：今週できる具体的な行動を1つ（40文字以内）。管理画面でできることなら場所も書く（例：設定＞受付、予約＞受付を止める、設定＞分析＞Instagramの文案）。良い状態なら「今のまま」でもよい。',
  '- tone：good（良い変化）、warn（気をつけたいこと）、info（参考になること）。',
  '- 専門用語（原価率・客単価・CVR・KPIなど）は使わず、「食材費の割合」「1人あたり」「予約まで進んだ割合」のように書く。',
  '- 金額は「¥12,300」、割合は「35%」と書く。',
  '- 前回の気づきとやることが渡されたら、その後どうなったかに触れてよい（同じことのくり返しは避ける）。',
  '- データが少ない・つながっていない項目には触れない。',
  '- ' + AI_BREAK_RULE
].join('\n');
const ANALYSIS_SCHEMA = strSchema({
  items: { type: 'array', items: strSchema({ tone: { type: 'string', enum: ['good', 'warn', 'info'] }, title: { type: 'string' }, body: { type: 'string' }, todo: { type: 'string' } }) }
});

async function makeSection(env, sec, effort) {
  const head = await factsHead(env);
  const body = sec === 'money' ? await factsMoney(env) : sec === 'booking' ? await factsBooking(env) : sec === 'ig' ? await factsIg(env)
    : [await factsMoney(env), await factsBooking(env), await factsIg(env)].join('\n\n');
  const prev = await kvGet(env, 'ai:' + sec);
  const before = prev && prev.items && prev.items.length
    ? '\n\n前回（' + prev.at.slice(5, 10).replace('-', '/') + '）の気づきとやること：\n' + prev.items.map(x => '・' + plain(x.title) + ' → ' + plain(x.todo)).join('\n') : '';
  const out = await claude(env, {
    system: ANALYSIS_SYSTEM, effort: effort || 'medium', maxTokens: 32000, timeout: 240000,
    content: [{ type: 'text', text: 'この分析で見るもの：' + SECTION[sec].focus + '\n\n' + head + '\n\n' + body + before }],
    schema: ANALYSIS_SCHEMA
  });
  const items = (out.items || []).slice(0, sec === 'summary' ? 3 : 4).map(x => ({
    tone: ['good', 'warn', 'info'].indexOf(x.tone) >= 0 ? x.tone : 'info',
    title: aiText(x.title, 120), body: aiText(x.body, 260), todo: aiText(x.todo, 120)
  }));
  const v = { at: jstStamp(Date.now()), items: items };
  await kvPut(env, 'ai:' + sec, v);
  return v;
}
async function adminAnalysisAi(env, b) {
  const sec = SECTION[b.section] ? b.section : 'summary';
  return { section: sec, insight: await makeSection(env, sec) };
}
// 分析のまとめ：主な数字と、Claude の気づき（4つの分野ぶん）
async function adminDash(env) {
  const f = features(env);
  const today = jstStamp(Date.now()).slice(0, 10);
  const cur = today.slice(0, 7);
  const P = moneyPeriod('month', today);
  const out = { features: f, period: P };
  if (f.square || f.mf) {
    const D = await loadMoneyData(env, [addMonths(cur, -1), cur], false);
    const all = Object.values(D.mf);
    const [a, b] = await Promise.all([salesSums(env, P.from, P.to), salesSums(env, P.prevFrom, P.prevTo)]);
    const ea = expenseSums(all, P.from, P.to), eb = expenseSums(all, P.prevFrom, P.prevTo);
    out.money = { hasSales: D.hasSales, hasExpense: D.hasExpense, sales: a.sales, salesPrev: b.sales, expense: ea.total, expensePrev: eb.total, food: ea.food, err: D.sqErr || D.mfErr };
  }
  const rs = await env.DB.batch([
    env.DB.prepare("SELECT COUNT(*) AS groups, COALESCE(SUM(guests), 0) AS guests FROM reservations WHERE status = '確定' AND date BETWEEN ? AND ?").bind(P.from, monthLast(cur)),
    env.DB.prepare("SELECT COUNT(*) AS groups, COALESCE(SUM(guests), 0) AS guests FROM reservations WHERE status = '確定' AND date BETWEEN ? AND ?").bind(P.prevFrom, monthLast(addMonths(cur, -1))),
    env.DB.prepare("SELECT COUNT(*) AS opens, COUNT(DISTINCT user_id) AS users FROM events WHERE kind = 'open' AND date >= ?").bind(addDays(today, -29)),
    env.DB.prepare("SELECT COUNT(DISTINCT user_id) AS n FROM events WHERE kind = 'request' AND date >= ?").bind(addDays(today, -29)),
    env.DB.prepare('SELECT COALESCE(SUM(reach), 0) AS reach, COUNT(*) AS days FROM ig_daily WHERE date >= ?').bind(addDays(today, -29)),
    env.DB.prepare("SELECT v FROM kv WHERE k = 'igAccount'")
  ]);
  out.booking = { groups: rs[0].results[0].groups, guests: rs[0].results[0].guests, groupsPrev: rs[1].results[0].groups, opens: rs[2].results[0].opens, users: rs[2].results[0].users, requests: rs[3].results[0].n };
  const acc = rs[5].results[0] ? JSON.parse(rs[5].results[0].v) : null;
  out.ig = rs[4].results[0].days || acc ? { reach: rs[4].results[0].reach, followers: acc ? acc.followers : null } : null;
  out.ai = {};
  for (const sec of Object.keys(SECTION)) out.ai[sec] = await kvGet(env, 'ai:' + sec);
  const note = await kvGet(env, 'aiNote');
  out.note = note ? note.text : '';
  out.noteAt = note ? note.at : '';
  return out;
}
async function adminAiNote(env, b) {
  const text = clean(b.text, 1000);
  if (text) await kvPut(env, 'aiNote', { text: text, at: jstStamp(Date.now()) });
  else await env.DB.prepare("DELETE FROM kv WHERE k = 'aiNote'").run();
  await env.DB.prepare("DELETE FROM kv WHERE k = 'aiChatFacts'").run();
  return { at: text ? jstStamp(Date.now()) : '' };
}

/* ---------- 分析のところで Claude と話す ----------
 * お店の数字は30分ごとにまとめ直し、Claude側でも5分間とっておいてもらう（続けて聞くと速い）。やりとりは画面の中だけで覚える
 */
const CHAT_SYSTEM = [
  'あなたは、大阪・阿倍野の小さな薬膳レストラン「épii」（店主ひとりで営業）の経営の相談役です。店主は数字や会計の言葉が得意ではありません。',
  '次に渡す「お店の数字」をもとに、店主の質問に答えます。',
  '- やさしい言葉で、3〜5文。根拠の数字を入れる。専門用語は使わない。',
  '- データにないことは「この数字からは分かりません」と言う。推測するときは「〜かもしれません」。',
  '- できることがあれば1つすすめる（管理画面でできることなら場所も）。',
  '- 店主が、お店の方針や事情（仕入れ先、続けたい工夫、営業の都合など）を話したら、これからも覚えておくとよいことを remember に40文字以内で入れる。なければ空の文字列。',
  '- ' + AI_BREAK_RULE
].join('\n');
async function chatFacts(env) {
  const saved = await kvGet(env, 'aiChatFacts');
  if (saved && Date.now() - saved.at < 1800000) return saved.text;
  const parts = [await factsHead(env), await factsMoney(env), await factsBooking(env), await factsIg(env)];
  const secs = [];
  for (const sec of Object.keys(SECTION)) {
    const x = await kvGet(env, 'ai:' + sec);
    if (x && x.items && x.items.length) secs.push(SECTION[sec].label + '（' + x.at.slice(5, 10).replace('-', '/') + '）：' + x.items.map(i => plain(i.title) + ' → ' + plain(i.todo)).join('／'));
  }
  if (secs.length) parts.push('【これまでのClaudeの気づき】\n' + secs.join('\n'));
  const text = 'お店の数字：\n' + parts.join('\n\n');
  await kvPut(env, 'aiChatFacts', { at: Date.now(), text: text });
  return text;
}
async function adminAiChat(env, b) {
  const list = (Array.isArray(b.messages) ? b.messages : []).slice(-12)
    .map(m => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: m.role === 'assistant' ? plain(clean(m.text, 1200)) : clean(m.text, 500) }))
    .filter(m => m.content);
  while (list.length && list[0].role !== 'user') list.shift();
  if (!list.length || list[list.length - 1].role !== 'user') fail('聞きたいことを入れてください。');
  const facts = await chatFacts(env);
  const out = await claude(env, {
    system: [{ type: 'text', text: CHAT_SYSTEM }, { type: 'text', text: facts, cache_control: { type: 'ephemeral' } }],
    effort: 'medium', maxTokens: 16000, messages: list,
    schema: strSchema({ answer: { type: 'string' }, remember: { type: 'string' } })
  });
  return { answer: aiText(out.answer, 800), remember: plain(clean(out.remember, 80)) };
}

/* ---------- (2) 週1回のまとめ（月曜 9:00 にお店のLINEへ） ---------- */
async function weeklyReport(env, force) {
  const f = features(env);
  if (!f.ai && !f.square && !f.mf) return { skipped: 'off' };
  const now = jstStamp(Date.now());
  const today = now.slice(0, 10);
  const sent = await kvGet(env, 'weeklyAt');
  if (!force) {
    // WEEKLY_ANY_DAY はテスト用（曜日・時刻を問わず送る）
    if (!env.WEEKLY_ANY_DAY && (weekday(today) !== 1 || now.slice(11) < '09:00')) return { skipped: 'time' };
    if (sent && sent.date === today) return { skipped: 'sent' };
  }
  const from = addDays(today, -7);
  const to = addDays(today, -1);
  if (f.square) { try { await sqEnsure(env, monthsBetween(addDays(today, -14), today), 0); } catch (e) { console.error('週のまとめ：Square', e.message); } }
  const a = await salesSums(env, from, to);
  const b = await salesSums(env, addDays(today, -14), addDays(today, -8));
  const lines = ['【先週のまとめ ' + jdShort(from) + '〜' + jdShort(to) + '】'];
  if (f.square) {
    const ch = b.sales ? Math.round((a.sales - b.sales) / b.sales * 100) : null;
    lines.push('売上 ¥' + a.sales.toLocaleString() + (ch === null ? '' : '（前の週より ' + (ch >= 0 ? '+' : '') + ch + '%）'));
  }
  lines.push('予約 ' + a.groups + '組 ' + a.guests + '名' + (f.square ? '・予約なしの会計 ' + a.walkN + '件' : ''));
  if (f.mf && f.square) {
    try {
      const md = await mfMonth(env, today.slice(0, 7), 600000);
      const ex = expenseSums([md], today.slice(0, 7) + '-01', today);
      const sm = await salesSums(env, today.slice(0, 7) + '-01', today);
      if (sm.sales && ex.food) lines.push('食材費の割合 ' + Math.round(ex.food / sm.sales * 100) + '%（今月）');
    } catch (e) { /* 経費がなくても送る */ }
  }
  // 経費の登録のお知らせ（たまっていそうなときだけ）
  if (f.mf) {
    const exp = [];
    try {
      await rcptMatchWaiting(env);
      const L = await rcptList(env);
      if (L.idle === null || L.idle >= 7) exp.push(L.idle === null ? 'レシートの登録がまだありません。たまったレシートは今日の画面からまとめて撮れます' : '最後にレシートを登録してから' + L.idle + '日です。たまっていたら今日の画面からまとめて撮れます');
      const tx = await adminMfTx(env, { suggest: false });
      if (tx.list && tx.list.length) exp.push('口座から出たお金で、まだ登録していないものが' + tx.list.length + '件あります');
      if (L.items.some(x => x.old)) exp.push('口座の明細が見つからないレシートがあります（今日の画面＞レシートを登録）');
    } catch (e) { console.error('週のまとめ：経費', e.message); }
    if (exp.length) lines.push('', '【経費の登録】', ...exp.map(x => '・' + x));
  }
  let todos = [];
  if (f.ai) {
    try {
      const secs = await Promise.allSettled(['summary', 'money', 'booking', 'ig'].map(s => makeSection(env, s, 'high')));
      if (secs[0].status === 'fulfilled') todos = secs[0].value.items.map(x => plain(x.todo)).filter(Boolean).slice(0, 3);
    } catch (e) { console.error('週のまとめ：分析', e.message); }
  }
  if (todos.length) lines.push('', '【今週やること（Claudeの分析）】', ...todos.map((t, i) => (i + 1) + '. ' + t));
  const url = await adminUrl(env);
  if (url) lines.push('', 'くわしくは管理画面で', url);
  const res = await pushOwner(env, lines.join('\n'));
  if (res.ok) await kvPut(env, 'weeklyAt', { date: today, at: now });
  return { ok: res.ok, text: lines.join('\n') };
}

/* ---------- (3) Instagramの文案 ----------
 * ・これまでの投稿の文は1日1回だけInstagramから読み、手元に置いて使い回す
 * ・作るのは選んでいる種類（ストーリー・投稿・リール）の文だけ。書き方の特徴は一度読んだら使い回す
 * ・これまでの投稿の文は、Claude側でも5分間は読み直さずに済むようにしておく（書き直しが速くなる）
 */
const IG_KIND_NAME = { story: 'ストーリー', post: '投稿', reel: 'リール' };
const IG_KIND_RULE = {
  story: 'ストーリーに載せる短い文（3〜4行、全体で60文字くらい）。空いている日時を知らせ、「ご予約はリンクから」で締める。ハッシュタグは付けない。',
  post: 'フィード投稿の文（5〜8行）。季節や食材から書き出し、空きのお知らせとご予約の案内。最後にハッシュタグを3〜5個（これまでの投稿で使っているものを優先）。',
  reel: 'リールに付ける短い文（2〜3行）とハッシュタグ。'
};
const IG_SYSTEM = [
  'あなたは、大阪・阿倍野の小さな薬膳レストラン「épii」のInstagramの文を、店主の代わりに下書きします。',
  'これまでの投稿の文（次に渡す一覧）を読んで、書き出し・文の長さ・改行・絵文字やハッシュタグの使い方を、そのお店の書き方に合わせてください。',
  '- 頼まれた種類の文（text）だけを書く。',
  '- 料理の写真があれば、写っているものに合わせる。写っていない料理や食材は書かない。写真がなければ、メニューの説明にある範囲で書く。',
  '- 値段・席数の数字は書かない（「お席に余裕があります」くらい）。お店が言っていない特典は書かない。',
  '- style を頼まれたときだけ、これまでの投稿から読み取った書き方の特徴を3〜4項目（各25文字以内）。',
  '- 改行は「\\n」で入れる。' + AI_BREAK_RULE
].join('\n');

// これまでの投稿の文（1日1回だけInstagramから読み直す）
async function igCaptions(env) {
  const saved = await kvGet(env, 'igCaps');
  if (saved && Date.now() - saved.at < 86400000 && saved.list.length) return saved.list;
  let list = [];
  const tk = await igToken(env).catch(() => null);
  if (tk) {
    try {
      const m = await igGet(env, tk.token, '/me/media', { fields: 'caption,media_product_type,timestamp', limit: 30 });
      list = (m.data || []).map(x => clean(x.caption, 1200)).filter(Boolean).slice(0, 15);
    } catch (e) { /* 取り込み済みの文を使う */ }
  }
  if (!list.length) list = (await env.DB.prepare("SELECT caption FROM ig_media WHERE kind != 'story' AND caption IS NOT NULL AND caption != '' ORDER BY ts DESC LIMIT 15").all()).results.map(x => x.caption);
  await kvPut(env, 'igCaps', { at: Date.now(), list: list });
  return list;
}

// 告知の候補：これから1週間の空いている時間帯
async function upcomingOpenings(env) {
  const s = await getSettings(env);
  const today = jstStamp(Date.now()).slice(0, 10);
  const w = await loadWindow(env, today, addDays(today, 7));
  const idx = buildIndex(w.holds, w.blocks, s);
  const nowStamp = jstStamp(Date.now());
  const out = [];
  for (let i = 0; i <= 7; i++) {
    const d = addDays(today, i);
    if (d > bookingEnd(s, today)) break;
    const per = {};
    daySlots(d, w.rules, s).forEach(x => {
      if (nowStamp >= d + ' ' + x.time) return;
      const left = leftAt(idx, d, x.time, x.session, null, s);
      if (per[x.session] === undefined || per[x.session] < left) per[x.session] = left;
    });
    Object.keys(per).forEach(k => { if (per[k] >= Math.ceil(s.seats / 2)) out.push({ date: d, session: k, label: sessionLabel(s, k), left: per[k] }); });
  }
  return { list: out.slice(0, 8), s: s, courses: w.courses };
}
function igKey(b) { return b.date === 'free' ? 'ig:free' : 'ig:' + String(b.date || '') + ':' + String(b.session || ''); }
async function adminIgOpenings(env) {
  const o = await upcomingOpenings(env);
  const keys = o.list.map(x => 'ig:' + x.date + ':' + x.session).concat('ig:free', 'ig:style');
  const cached = {};
  let style = [];
  (await env.DB.prepare('SELECT k, v FROM ai_cache WHERE k IN (' + keys.map(() => '?').join(',') + ')').bind(...keys).all()).results.forEach(r => {
    try { if (r.k === 'ig:style') style = JSON.parse(r.v); else cached[r.k.slice(3)] = JSON.parse(r.v); } catch (e) { /* 何もしない */ }
  });
  return { openings: o.list, drafts: cached, style: style };
}

async function adminIgDraft(env, b) {
  const kind = IG_KIND_RULE[b.kind] ? b.kind : 'story';
  const o = await upcomingOpenings(env);
  const free = b.date === 'free';
  const op = free ? null : o.list.find(x => x.date === b.date && x.session === b.session) || (isDate(b.date) ? { date: b.date, session: String(b.session || ''), label: sessionLabel(o.s, String(b.session || '')), left: 0 } : null);
  if (!free && !op) fail('告知する日を選んでください。');
  const key = igKey(b);
  const caps = await igCaptions(env);
  const capsText = 'これまでの投稿の文（新しい順）：\n' + (caps.length ? caps.map((c, i) => '---' + (i + 1) + '\n' + c).join('\n') : 'なし（落ち着いた丁寧な文で書く）');
  const capsSrc = await hashOf(caps);
  const styleHit = await aiCacheGet(env, 'ig:style');
  const needStyle = !styleHit || styleHit.src !== capsSrc;
  const menu = o.courses.filter(c => c.visible && (free || c.sessions.indexOf(op.session) >= 0))
    .map(c => '・' + c.name + (c.description ? '（' + c.description + '）' : '')).join('\n');
  const today = jstStamp(Date.now()).slice(0, 10);
  const prev = await aiCacheGet(env, key);
  const draft = prev ? prev.v : {};
  const note = await ownerNote(env);
  const ask = [
    '今日：' + jdLong(today),
    free ? '告知：空きのお知らせではない、ふだんの投稿' : '告知する空き：' + jdLong(op.date) + ' ' + op.label + (op.date === today ? '（今日）' : op.date === addDays(today, 1) ? '（明日）' : ''),
    'メニュー：\n' + (menu || 'なし'),
    '書く文：' + IG_KIND_NAME[kind] + '。' + IG_KIND_RULE[kind],
    b.image ? '料理の写真：あり（1枚目）' : '',
    b.before ? '前の案とは違う書き出しにしてください：' + plain(clean(b.before, 600)) : '',
    needStyle ? 'style（書き方の特徴）も書いてください。' : 'style は空の配列でよい。',
    note ? 'お店からのメモ（投稿に関係することだけ参考に）：' + note : ''
  ].filter(Boolean).join('\n');
  const content = [];
  if (b.image) content.push(imageBlock(b));
  content.push({ type: 'text', text: ask });
  const out = await claude(env, {
    // 決まった指示とこれまでの投稿の文を先頭に置き、Claude側で5分間とっておいてもらう
    system: [{ type: 'text', text: IG_SYSTEM }, { type: 'text', text: capsText, cache_control: { type: 'ephemeral' } }],
    effort: 'low', maxTokens: 6000, content: content,
    schema: strSchema({ text: { type: 'string' }, style: { type: 'array', items: { type: 'string' } } })
  });
  draft[kind] = aiText(out.text, kind === 'story' ? 600 : 2200);
  draft.edited = Object.assign({}, draft.edited || {}, { [kind]: false });
  draft.at = jstStamp(Date.now());
  await aiCachePut(env, key, '', draft);
  let style = styleHit ? styleHit.v : [];
  if (needStyle && out.style && out.style.length) {
    style = out.style.slice(0, 4).map(x => aiText(x, 80));
    await aiCachePut(env, 'ig:style', capsSrc, style);
  }
  return { key: key.slice(3), draft: draft, style: style };
}
// 文案を手で直したとき・消したとき
async function adminIgSave(env, b) {
  const kind = IG_KIND_RULE[b.kind] ? b.kind : '';
  if (!kind) fail('種類を選んでください。');
  const key = igKey(b);
  const prev = await aiCacheGet(env, key);
  const draft = prev ? prev.v : {};
  if (b.remove) { delete draft[kind]; if (draft.edited) delete draft.edited[kind]; }
  else { draft[kind] = clean(b.text, 2200); draft.edited = Object.assign({}, draft.edited || {}, { [kind]: true }); }
  await aiCachePut(env, key, '', draft);
  return { key: key.slice(3), draft: draft };
}
