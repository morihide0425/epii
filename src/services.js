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
  return { ai: !!env.ANTHROPIC_API_KEY, square: !!env.SQUARE_ACCESS_TOKEN, mf: !!env.MF_API_KEY, google: !!(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET) };
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
  // 月の目標（設定＞その他でオンにしたとき）
  let goal = null;
  try { const gc = await goalCfg(env); if (gc.on && gc.amount) goal = await goalStatus(env, gc); } catch (e) { console.error('目標', e && e.message); }
  return {
    connected: true, error: error, today: today, day: day, goal: goal,
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
// 免税事業者の事業所には、インボイス区分（invoice_kind）を送れない。一度エラーになったら覚えて、以後は外して送る
function stripInvoice(v) {
  if (Array.isArray(v)) return v.map(stripInvoice);
  if (v && typeof v === 'object') { const o = {}; Object.keys(v).forEach(k => { if (k !== 'invoice_kind') o[k] = stripInvoice(v[k]); }); return o; }
  return v;
}
async function mfApi(env, method, path, query, body, retried) {
  if (body !== undefined && JSON.stringify(body).indexOf('invoice_kind') >= 0 && await kvGet(env, 'mfExempt')) body = stripInvoice(body);
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
    if (!retried && body !== undefined && /invoice_kind|インボイス区分/.test(text) && JSON.stringify(body).indexOf('invoice_kind') >= 0) {
      await kvPut(env, 'mfExempt', { at: Date.now() });
      return mfApi(env, method, path, query, stripInvoice(body), true);
    }
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
    firstStart: terms.length ? String(terms[terms.length - 1].start_date || '').slice(0, 10) : '',
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
// 口座から出たお金は、経費のほかに「事業主貸」（自分のために使ったお金）も選べる。経費には入らない
const PRIVATE_HELP = '自分のために使ったお金。生活費・家族の買い物・国民年金・国民健康保険・住民税・所得税など。経費にはなりません';
function txOptions(m, expense) {
  const own = m.accounts.find(a => a.name === '事業主貸');
  return own ? expense.concat([{ id: own.id, name: own.name, help: PRIVATE_HELP, n: 0, personal: true }]) : expense;
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
    const comp = [];
    const nm = side => (side && side.account_id && acc[side.account_id] ? acc[side.account_id].name : '');
    const amt = side => (side ? (Number(side.value) || 0) + (Number(side.tax_value) || 0) : 0);
    for (let page = 1; page <= 20; page++) {
      const j = await mfApi(env, 'GET', '/journals', { start_date: ym + '-01', end_date: monthLast(ym), per_page: 1000, page: page });
      // 帳簿のチェック用に、仕訳を小さくして手元に置く（科目名・金額・摘要だけ）
      (j.journals || []).forEach(jr => comp.push({ i: String(jr.id || ''), d: jr.transaction_date, t: jr.transaction_id ? 1 : 0, m: clean(jr.memo || '', 60),
        b: (jr.branches || []).map(br => [nm(br.debitor), amt(br.debitor), nm(br.creditor), amt(br.creditor), clean(br.remark || '', 60)]) }));
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
    const cj = JSON.stringify(comp);
    if (cj.length < 1500000) await env.DB.prepare("INSERT OR REPLACE INTO kv (k, v) VALUES (?, ?)").bind('mfj:' + ym, cj).run();
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
  const bk = await kvGet(env, 'bookCount');
  const su = await kvGet(env, 'sqUnentered');
  return {
    bookN: bk ? bk.n : 0, sqN: su ? su.n : 0,
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
  '- 店主が自分のために使ったお金（生活費・家族の買い物・国民年金・国民健康保険・住民税・所得税・個人の保険・個人のカードの引き落としなど）は「事業主貸」にして、rate は "none"。経費にはしない。',
  '- rate：消費税。食材・飲み物なら "8"、ほとんどの経費は "10"、税のかからないもの（振込手数料以外の税金・保険料・家賃の一部など）は "none"。',
  '- reason：何の支払いかを、ごく短く（15文字以内、体言止め）。例「Googleの利用料」「電気代」。',
  '- unsure：明細の名前だけでは分からないとき true（例：個人名への振込、略称で分からない）。',
  '- sure：次のどちらかのときだけ true。(1) 過去の登録に同じ相手があり、同じ科目にした。(2) 名前だけで何の支払いかがはっきり分かり、ほかの科目になることがまずない（電力会社・ガス会社・水道局・携帯電話や通信の会社・Googleなどのサービスの利用料・ソフトやアプリの月額料金・国民年金など）。振込（パソコン・ネット・ATMの振込）・個人名・略称・カードの支払いでお店の名前がないもの・ものによって科目が変わる相手（ネット通販・ホームセンター・コンビニなど）は false。迷ったら false。'
].join('\n');
// まとめて登録してよいほど確かか：前に同じ相手を同じ科目で登録している、または Claude が名前ではっきり分かると言ったもの。
// 振込・ATM など、中身によって科目が変わるものは入れない
const TX_GENERIC = /振込|振替|ﾌﾘｺﾐ|ﾌﾘｶｴ|フリコミ|フリカエ|ATM|ＡＴＭ|ｴｰﾃｲｴﾑ|引出|ﾋｷﾀﾞｼ|(PC|ＰＣ|ﾊﾟｿｺﾝ|パソコン|ﾈｯﾄ|ネット)\s*(ﾊﾞﾝｷﾝｸﾞ|バンキング)/i;
function txKey(v) { return String(v || '').normalize('NFKC').replace(/[\s\d\-－.,、。・()（）]/g, '').toUpperCase().slice(0, 16); }
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
  const hidden = await txHidden(env);
  let list = all.filter(t => (!t.side || t.side === 'EXPENSE') && (!t.journalizing_status || t.journalizing_status === 'none') && !SQ_TX.test(String(t.content || '')) && !hidden[String(t.id)])
    .map(t => ({ id: String(t.id), date: t.date, amount: Number(t.value) || 0, content: clean(t.content, 60) }))
    .filter(t => t.amount > 0).sort((a, x) => x.date.localeCompare(a.date));
  const income = await bankIncome(env, m, today, y, hidden);
  await kvPut(env, 'mfTxCount', { n: list.length + income.list.length, at: Date.now() });
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
  const expense = txOptions(m, await expenseOptions(env, m));
  // Claude の科目の提案（作ってあるものは使い回す）
  const keys = list.map(t => 'tx:' + t.id);
  const hits = {};
  if (keys.length) (await env.DB.prepare('SELECT k, v FROM ai_cache WHERE k IN (' + keys.map(() => '?').join(',') + ')').bind(...keys).all()).results
    .forEach(r => { try { hits[r.k.slice(3)] = JSON.parse(r.v); } catch (e) { /* 何もしない */ } });
  // 「確か」の印がない古い見立ては、もう一度 Claude に聞く
  const need = list.filter(t => (!hits[t.id] || hits[t.id].sure === undefined) && !t.receipt);
  if (need.length && env.ANTHROPIC_API_KEY && b.suggest !== false) {
    try {
      const hist = await accountHistory(env);
      const out = await claude(env, {
        system: TX_SYSTEM, effort: 'low', maxTokens: 8000,
        content: [{ type: 'text', text: '勘定科目の一覧：' + accountList(expense) + '\n過去に登録した相手と科目：' + (hist.join('、') || 'なし') +
          '\n\n明細（id｜日付｜内容｜金額）：\n' + need.map(t => t.id + '｜' + t.date + '｜' + t.content + '｜¥' + t.amount).join('\n') }],
        schema: strSchema({ items: { type: 'array', items: strSchema({ id: { type: 'string' }, account: { type: 'string' }, rate: { type: 'string', enum: ['8', '10', 'none'] }, reason: { type: 'string' }, unsure: { type: 'boolean' }, sure: { type: 'boolean' } }) } })
      });
      for (const x of out.items || []) {
        const a = expense.find(e => e.name === x.account);
        if (!a || !need.some(t => t.id === x.id)) continue;
        hits[x.id] = { accountId: a.id, rate: x.rate, reason: aiText(x.reason, 60), unsure: !!x.unsure, sure: !!x.sure && !x.unsure };
        await aiCachePut(env, 'tx:' + x.id, '', hits[x.id]);
      }
    } catch (e) { if (!e.userFacing) throw e; }
  }
  list.forEach(t => { t.ai = hits[t.id] || null; });
  // 前に同じ相手を登録した科目（口座の明細から作った仕訳の摘要は、明細の内容）
  const past = {};
  try {
    (await env.DB.prepare("SELECT remark, account FROM mf_lines WHERE remark != '' AND date >= ?").bind(addDays(today, -400)).all()).results.forEach(r => {
      const k = txKey(r.remark);
      if (!k) return;
      past[k] = past[k] === undefined || past[k] === r.account ? r.account : null; // 科目が分かれていたら null
    });
  } catch (e) { /* まだ表がないとき */ }
  list.forEach(t => {
    if (!t.ai) return;
    const acc = expense.find(a => a.id === t.ai.accountId);
    const was = past[txKey(t.content)];
    t.same = !!(acc && was && was === acc.name);
    t.sure = !t.ai.unsure && !TX_GENERIC.test(t.content) && (t.same || !!t.ai.sure);
  });
  return { connected: true, list: list, total: total, accounts: expense, income: income.list, incomeAccounts: income.accounts, hiddenN: Object.keys(hidden).length };
}
// 銀行への入金（Squareの明細はのぞく）。おすすめ：Squareの入金と同じお金なら対象外（二重になるので）、Square・利息・前と同じ相手は科目
const INCOME_ACCOUNTS = [
  ['売上高', '振込でもらった売上'], ['未収金', 'Square・カードの売上が入ってきた'], ['売掛金', '請求書の売上が入ってきた'],
  ['雑収入', '売上以外の収入（補助金など）'], ['事業主借', '自分のお金を入れた・預金の利息']
];
function incomeOptions(m) { return INCOME_ACCOUNTS.map(x => { const a = m.accounts.find(o => o.name === x[0]); return a ? { id: a.id, name: a.name, help: x[1] } : null; }).filter(Boolean); }
async function bankIncome(env, m, today, y, hidden) {
  const all = [];
  for (let page = 1; page <= 10; page++) {
    const j = await mfApi(env, 'GET', '/transactions', { start_date: y + '-01-01', end_date: today, side: 'INCOME', journalizing_statuses: 'none', order: 'desc', per_page: 200, page: page });
    all.push(...(j.transactions || []));
    const pages = j.metadata && Number(j.metadata.total_pages);
    if (!pages || page >= pages || !(j.transactions || []).length) break;
  }
  const accounts = incomeOptions(m);
  const none = all.filter(t => (!t.side || t.side === 'INCOME') && (!t.journalizing_status || t.journalizing_status === 'none'));
  // Squareの入金の明細（金額は、入金額か、手数料を引く前の額のことがある）
  const po = [];
  for (const x of none.filter(t => /入金\s*po_/.test(String(t.content || '')))) {
    const vals = [Number(x.value) || 0];
    const pid = (String(x.content).match(/入金\s*(po_[\w-]+)/) || [])[1];
    if (pid && env.SQUARE_ACCESS_TOKEN) { try { const pp = await sqPayout(env, pid); vals.push(pp.net, pp.gross); } catch (e) { /* 読めなければ明細の金額だけで */ } }
    po.push({ date: x.date, vals: vals });
  }
  const lines = none.filter(t => !SQ_TX.test(String(t.content || '')) && !/お取引/.test(String(t.content || '')) && !hidden[String(t.id)])
    .map(t => ({ id: String(t.id), date: t.date, amount: Number(t.value) || 0, content: clean(t.content, 60) })).filter(t => t.amount > 0).sort((a, x) => x.date.localeCompare(a.date)).slice(0, 30);
  if (!lines.length) return { list: [], accounts: accounts };
  let js = [];
  try { js = await bookJournals(env, bookMonths(today), false); } catch (e) { console.error('入金のおすすめ', e && e.message); }
  const byName = n => accounts.find(a => a.name === n);
  lines.forEach(t => {
    const near = (d, n) => Math.abs(diffDays(d, t.date)) <= n;
    const p = po.find(x => x.vals.indexOf(t.amount) >= 0 && near(x.date, 4));
    const bj = !p && js.find(j => near(j.d, 4) && j.b.some(br => br[0] === '普通預金' && br[1] === t.amount && br[2] === '未収金'));
    if (p) { t.tip = { act: 'exclude', why: jdShort(p.date) + 'のSquareの入金の明細と同じお金です。両方登録すると二重になるので、こちらは対象外に' }; return; }
    if (bj) { t.tip = { act: 'exclude', why: jdShort(bj.d) + 'に同じ金額のSquareの入金が、もう帳簿に入っています。二重になるので対象外に' }; return; }
    let name = '', why = '';
    if (/ｽｸｴｱ|スクエア|SQUARE/i.test(t.content)) { name = '未収金'; why = 'Squareからの入金（カードの売上が入ってきたもの）'; }
    else if (/利息|ﾘｿｸ|リソク/.test(t.content)) { name = '事業主借'; why = '預金の利息は、お店の収入にしません'; }
    else {
      const k = txKey(t.content);
      const seen = {};
      if (k) js.forEach(j => j.b.forEach(br => { if (br[0] === '普通預金' && br[2] && txKey(br[4] || j.m || '') === k) seen[br[2]] = (seen[br[2]] || 0) + 1; }));
      const top = Object.keys(seen).sort((a, b) => seen[b] - seen[a])[0];
      if (top && byName(top)) { name = top; why = '前と同じ科目'; }
    }
    const a = byName(name);
    t.tip = a ? { act: 'save', accountId: a.id, why: why } : { act: 'save', accountId: '', why: '' };
  });
  return { list: lines, accounts: accounts };
}

/* ---------- マネーフォワードに届いた明細を「対象外」にする（帳簿に入れない） ----------
 * 公開されている手順が見つからないので、ありそうな形を順に試し、本当に対象外になったかを読み直して確かめる（うまくいった形を覚える）。
 * どれもだめなら、この画面でだけ隠す（マネーフォワードでは未登録のまま残るが、帳簿には入らない） */
const MF_EXCLUDE_WAYS = [
  { m: 'PUT', p: id => '/transactions/' + id, b: () => ({ journalizing_status: 'excluded' }) },
  { m: 'PUT', p: id => '/transactions/' + id, b: () => ({ transaction: { journalizing_status: 'excluded' } }) },
  { m: 'POST', p: () => '/transactions/exclude', b: id => ({ transaction_id: id }) },
  { m: 'POST', p: id => '/transactions/' + id + '/exclude', b: () => ({}) }
];
async function mfExclude(env, id, date) {
  const known = await kvGet(env, 'mfExcludeWay');
  if (known && known.none && Date.now() - known.at < 7 * 86400000) return false;
  const order = known && known.i !== undefined ? [known.i] : MF_EXCLUDE_WAYS.map((w, i) => i);
  for (const i of order) {
    const w = MF_EXCLUDE_WAYS[i];
    try { await mfApi(env, w.m, w.p(encodeURIComponent(id)), null, w.b(id)); }
    catch (e) { if (e.code === 'MF_NET') throw e; continue; }
    if (known && known.i === i) return true;
    const chk = await mfApi(env, 'GET', '/transactions', { start_date: date, end_date: date, journalizing_statuses: 'excluded', per_page: 500 });
    if ((chk.transactions || []).some(t => String(t.id) === String(id))) { await kvPut(env, 'mfExcludeWay', { i: i, at: Date.now() }); return true; }
  }
  await kvPut(env, 'mfExcludeWay', { none: true, at: Date.now() });
  return false;
}
async function txHidden(env) { return (await kvGet(env, 'txHidden')) || {}; }
async function adminTxExclude(env, b) {
  const id = String(b.id || ''), date = String(b.date || '');
  if (!id || !isDate(date)) fail('明細が見つかりません。画面を更新してください。');
  const mf = await mfExclude(env, id, date);
  if (!mf) {
    const h = await txHidden(env);
    h[id] = { at: jstStamp(Date.now()), date: date, amount: Number(b.amount) || 0, content: clean(b.content, 60) };
    await kvPut(env, 'txHidden', h);
  }
  const left = await kvGet(env, 'mfTxCount');
  if (left && left.n && b.kind !== 'sq') await kvPut(env, 'mfTxCount', { n: left.n - 1, at: left.at });
  return { mf: mf };
}
// この画面で隠したものを、もう一度出す
async function adminTxUnhide(env) { await env.DB.prepare("DELETE FROM kv WHERE k = 'txHidden'").run(); return { ok: true }; }
// Claude のおすすめのまま、まとめて登録する（迷うもの・二重の注意があるものは画面で外してから送る）
async function adminMfTxSaveAll(env, b) {
  const items = (Array.isArray(b.items) ? b.items : []).slice(0, 50);
  if (!items.length) fail('登録するものがありません。');
  const done = [];
  const failed = [];
  for (const it of items) {
    try { await adminMfTxSave(env, it); done.push(String(it.id)); }
    catch (e) { if (!e.userFacing) console.error('まとめて登録', e && e.message); failed.push({ id: String(it.id), message: e.message }); }
  }
  return { done: done, failed: failed };
}
async function adminMfTxSave(env, b) {
  const m = await mfMaster(env);
  if (b.income) return await saveIncome(env, m, b);
  const expense = txOptions(m, await expenseOptions(env, m));
  const acc = expense.find(a => a.id === b.accountId);
  if (!acc) fail('勘定科目を選んでください。');
  const tx = { id: String(b.id || ''), date: String(b.date || ''), content: clean(b.content, 60) };
  if (!tx.id || !isDate(tx.date)) fail('明細が見つかりません。画面を更新してください。');
  const rate = acc.personal ? 'none' : ['8', '10', 'none'].indexOf(b.rate) >= 0 ? b.rate : '10';
  await mfFromTx(env, m, tx, { accountId: acc.id, rate: rate, remark: clean(b.memo || tx.content, 200) });
  await mfTouched(env, tx.date);
  const left = await kvGet(env, 'mfTxCount');
  if (left && left.n) await kvPut(env, 'mfTxCount', { n: left.n - 1, at: left.at });
  return { ok: true };
}

// 銀行への入金を登録：普通預金／選んだ科目（税なし）
async function saveIncome(env, m, b) {
  const acc = incomeOptions(m).find(a => a.id === b.accountId);
  if (!acc) fail('科目を選んでください。');
  const bank = m.accounts.find(a => a.name === '普通預金');
  if (!bank) fail('マネーフォワードに「普通預金」の科目が見つかりませんでした。');
  const tx = { id: String(b.id || ''), date: String(b.date || ''), content: clean(b.content, 60) };
  if (!tx.id || !isDate(tx.date)) fail('明細が見つかりません。画面を更新してください。');
  const amount = Math.round(Number(b.amount) || 0);
  const r = await mfFromTx(env, m, tx, { accountId: acc.id, rate: 'none', remark: clean(b.memo || tx.content, 200) });
  // 入金の形（借方：普通預金、貸方：選んだ科目）になっていなければ、そろえる
  if (r.jid) {
    const g = await mfApi(env, 'GET', '/journals/' + encodeURIComponent(r.jid));
    const jr = g.journal || {};
    const brs = jr.branches || [];
    const okShape = brs.length === 1 && brs[0].debitor && brs[0].debitor.account_id === bank.id && brs[0].creditor && brs[0].creditor.account_id === acc.id;
    if (!okShape) {
      const v = amount || brs.reduce((a, br) => a + (Number(br.debitor && br.debitor.value) || 0) + (Number(br.debitor && br.debitor.tax_value) || 0), 0);
      const none = pickTax(m.taxes, 'none');
      const side = id => Object.assign({ account_id: id, value: v }, none ? { tax_id: none } : {});
      await mfApi(env, 'PUT', '/journals/' + encodeURIComponent(r.jid), null, { journal: { transaction_date: jr.transaction_date || tx.date, journal_type: jr.journal_type || 'journal_entry', memo: jr.memo || '', branches: [{ debitor: side(bank.id), creditor: side(acc.id), remark: clean(b.memo || tx.content, 200) }] } });
    }
  }
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
  const ctx = b.context || {};
  const base = env.MF_API_KEY ? await expenseOptions(env, m) : [];
  const expense = env.MF_API_KEY && ctx.kind === 'tx' ? txOptions(m, base) : base;
  const note = await ownerNote(env);
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
    insight: await kvGet(env, 'ai:money'), syncedAt: st[cur] ? jstStamp(st[cur]) : '',
    goal: await goalStatus(env).catch(() => null)
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
    await factsSettings(env, today, addDays(today, 13)),
    note ? 'お店からのメモ（覚えておいてほしいこと）：' + note : ''
  ].filter(Boolean).join('\n');
}
// 設定タブの内容（受付のルール・時間帯・営業日・メニュー・予約タブで変えた日）を Claude に渡す形にする
async function factsSettings(env, from, to) {
  const s = await getSettings(env);
  const [courses, rr, bl] = await Promise.all([
    allCourses(env),
    env.DB.prepare('SELECT date, kind, sessions FROM day_rules WHERE date BETWEEN ? AND ? ORDER BY date').bind(from, to).all(),
    env.DB.prepare("SELECT date, start, end, memo FROM blocks WHERE type = 'off' AND date BETWEEN ? AND ? ORDER BY date, start").bind(from, to).all()
  ]);
  const keys = sessionKeys(s);
  const lines = ['【お店の設定（管理画面の設定タブ）】'];
  lines.push('受付：予約の締切はふだん' + ruleText(s.cutoff) + '（メニューごとに変えられる）、お客様が変更できるのは' + ruleText(s.changeCutoff) + '、ネットでのキャンセルは' + s.cancelDays + '日前まで。' +
    'ネット予約は1組' + s.maxGuests + '名まで。受付は' + (s.openUntil ? jdLong(s.openUntil) + 'まで' : s.aheadDays + '日先まで') + '。');
  lines.push('時間帯：' + keys.map(k => { const c = s.sessions[k]; return sessionLabel(s, k) + ' 営業' + c.open + '〜' + c.close + '・予約は' + c.first + '〜' + c.last + '（' + c.interval + '分ごと、1組' + c.stay + '分）'; }).join('、'));
  lines.push('いつもの営業：' + WD.split('').map((w, i) => w + '曜 ' + ((s.weekly[String(i)] || []).map(k => sessionLabel(s, k)).join('・') || '定休日')).join('、'));
  const rl = rr.results.map(r => jdShort(r.date) + '（' + WD[weekday(r.date)] + '）' + (r.kind === 'off' ? '休み' : r.kind === 'private' ? '貸切' : String(r.sessions || '').split(',').filter(Boolean).map(k => sessionLabel(s, k)).join('・') + 'だけ営業'));
  if (rl.length) lines.push('予約タブで変えた日（' + jdShort(from) + '〜' + jdShort(to) + '）：' + rl.join('、'));
  const bs = bl.results.map(b => jdShort(b.date) + ' ' + b.start + '〜' + b.end + (b.memo ? '（' + clean(b.memo, 20) + '）' : ''));
  if (bs.length) lines.push('受付を止めている時間：' + bs.join('、'));
  lines.push('メニュー（予約ページに出ているもの）：');
  courses.filter(c => c.visible).forEach(c => {
    const wd = c.weekdays.length === 7 ? '毎日' : c.weekdays.map(i => WD[i]).join('') + '曜';
    lines.push('・' + c.name + '：¥' + Number(c.price).toLocaleString() + (c.price_type === 'from' ? '〜' : '') + '、' + (periodText(c) ? periodText(c) + 'の期間限定、' + (c.date_to && c.date_to < from ? '（終わっている）、' : '') : '') + wd + 'の' + c.sessions.map(k => sessionLabel(s, k)).join('・') +
      '、予約の締切 ' + ruleText(cutoffRule(c, s)) + '、' + (Number(c.min_guests) > 1 ? c.min_guests + '名から、' : '') + (c.cap ? '同じ時間に' + c.cap + '名まで' : '席数まで'));
  });
  const hidden = courses.filter(c => !c.visible).map(c => c.name);
  if (hidden.length) lines.push('予約ページに出していないメニュー：' + hidden.join('、'));
  return lines.join('\n');
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
    if (D.hasSales && e) parts.push('利益（売上－経費）¥' + (x.sales - e.total).toLocaleString());
    lines.push('・' + parts.join('、'));
  }
  const P = moneyPeriod('month', today);
  const a = await salesSums(env, P.from, P.to);
  const b = await salesSums(env, P.prevFrom, P.prevTo);
  lines.push('今月（' + Number(P.to.slice(8)) + '日まで）と先月の同じ日まで：売上 ¥' + a.sales.toLocaleString() + ' / ¥' + b.sales.toLocaleString() + '、予約の来店 ' + a.guests + '名 / ' + b.guests + '名');
  try {
    const t = await moneyTrend(env);
    if (trendText(t)) lines.push('経費の傾向：' + trendText(t) + '。食材費は売上に合わせて増え、それ以外（家賃・光熱費・通信費など）は毎月だいたい同じとして計算。');
    const g = await goalStatus(env);
    if (g.on) lines.push(goalText(g));
    if (g.pace && g.paceProfit !== undefined) lines.push('このままのペースだと、今月の利益は約¥' + g.paceProfit.toLocaleString() + '（営業日 ' + g.openDays + '日のうち ' + g.doneDays + '日営業済み）');
  } catch (e) { /* 目標がなくても続ける */ }
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
  summary: { label: 'まとめ', focus: 'お店全体を「見つけてもらう（Googleマップ・検索、Instagram）→ 予約ページを見る → 予約する → 来店する → 売上 → 利益（売上－経費）」の1本の流れとして見る。分野ごとに数字を並べるのではなく、分野をまたいだ数字を組み合わせて、どこで詰まっているか・何が効いているかを示す（例：Googleの表示やルート検索は増えたのに予約ページの閲覧が増えていない→プロフィールの予約リンクやメニューの見せ方／Instagramのリーチは減ったが予約は増えた→Google経由が支えている／空いている曜日と検索された言葉を合わせた打ち手）。今週いちばん大事なこと（いちばん効く行動）を3つ、利益につながる順に。それぞれ根拠の数字を2つ以上の分野から挙げ、やることは具体的に（どこで・何を・いつ）。月の目標があれば、その進み具合も考える。' },
  money: { label: '売上・経費', focus: '売上と経費だけを見る（予約ページの閲覧やInstagramには触れない）。いちばん大事なのは利益（売上－経費）。売上の増減と理由（曜日・時間帯・予約の会計と予約なしの会計・1人あたり・1会計あたり）、経費（食材費の割合・大きい科目・増えた科目・主な支払先）を数字ではっきり示し、そのうえで「利益をどう増やすか」（売上を増やす・食材費の割合を下げる・毎月の経費を見直す・値付け）を少なくとも1つ、具体的な金額の目安つきで書く。月の目標があれば、届きそうかと、残りの営業日で何をするかにも触れる。ひとりで回せる範囲（席数・仕込みの量）を前提にする。3〜4つ。' },
  booking: { label: '予約', focus: '予約と予約ページだけを見る（売上の金額やInstagramには触れない）。混む・空く曜日と時間帯、キャンセル・来店なし、満席で断った需要、予約ページのどこで離れているか、受付の期間や締切。Googleマップ・検索のデータがあれば、表示回数・ルート検索・電話の動きと検索された言葉、返信していない口コミにも触れる。3〜4つ。' },
  google: { label: 'Google', focus: 'Googleマップ・Google検索（ビジネスプロフィール）を中心に見る。表示回数の増減（マップ・検索）、表示からルート検索・電話・ウェブサイトへ動いた割合、検索された言葉（薬膳・ランチ・地名など、どんな言葉で探されているか、出ていない言葉）、口コミ（評価、返信していないもの、内容から分かる良い点・直す点）。予約ページへのGoogleからの流入や予約の数字があれば、つながりも見る。ビジネスプロフィールでできること（写真の追加、投稿、メニュー、営業時間、説明文に検索語句を入れる、口コミへの返信）を具体的に。3〜4つ。' },
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
  const body = sec === 'money' ? await factsMoney(env) : sec === 'booking' ? [await factsBooking(env), await factsGoogle(env)].filter(Boolean).join('\n\n') : sec === 'ig' ? await factsIg(env)
    : sec === 'google' ? [await factsGoogle(env), await factsBooking(env)].filter(Boolean).join('\n\n')
    : [await factsMoney(env), await factsBooking(env), await factsGoogle(env), await factsIg(env)].filter(Boolean).join('\n\n');
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
  if (sec === 'google' && !(gOn(env) && await kvGet(env, 'google'))) fail('Googleとつながっていません。');
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
    try { const gc = await goalCfg(env); if (gc.on && gc.amount) out.goal = await goalStatus(env, gc); } catch (e) { /* 目標がなくても出す */ }
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
  const parts = [await factsHead(env), await factsMoney(env), await factsBooking(env), await factsGoogle(env), await factsIg(env)].filter(Boolean);
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
      const bk = await adminBook(env, {}).catch(() => null);
      const bn = bk && bk.issues ? bk.issues.filter(x => x.fix).length + (bk.sales || []).filter(x => x.diffN).length : 0;
      if (bn) exp.push('帳簿で直したほうがよいところが' + bn + '件あります（今日の画面＞経費を登録で直せます）');
      const su = await sqUnentered(env).catch(() => null);
      if (su && su.items && su.items.length) exp.push('Squareの売上・入金で、マネーフォワードにまだ入れていないものが' + su.items.length + '件あります（今日の画面＞経費を登録でまとめて登録できます）');
    } catch (e) { console.error('週のまとめ：経費', e.message); }
    if (exp.length) lines.push('', '【経費の登録】', ...exp.map(x => '・' + x));
  }
  let todos = [];
  if (f.ai) {
    try {
      const list = ['summary', 'money', 'booking', 'ig'].concat(gOn(env) && await kvGet(env, 'google') ? ['google'] : []);
      const secs = await Promise.allSettled(list.map(s => makeSection(env, s, 'high')));
      if (secs[0].status === 'fulfilled') todos = secs[0].value.items.map(x => plain(x.todo)).filter(Boolean).slice(0, 3);
    } catch (e) { console.error('週のまとめ：分析', e.message); }
  }
  if (todos.length) lines.push('', '【今週やること（Claudeの分析）】', ...todos.map((t, i) => (i + 1) + '. ' + t));
  try { const g = await goalStatus(env); if (g.on && g.need) lines.push('', '【今月の目標】', goalText(g).replace(/^今月の目標：/, '')); } catch (e) { /* 目標がなくても送る */ }
  // 店主へのひとこと（Claude）
  if (f.ai) {
    try {
      const out = await claude(env, {
        system: '小さな飲食店をひとりで切り盛りしている店主に、週のはじめに送るLINEの最後に添える「ひとこと」を書きます。先週のがんばりをねぎらう言葉にします。' + CHEER_RULE,
        effort: 'low', maxTokens: 2000, content: [{ type: 'text', text: '先週のまとめ：' + lines.slice(1, 4).join('、') + '\n\n' + await cheerFacts(env, null) }], schema: strSchema({ cheer: { type: 'string' } })
      });
      if (out.cheer) lines.push('', plain(clean(out.cheer, 120)));
    } catch (e) { console.error('週のまとめ：ひとこと', e && e.message); }
  }
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

/* ---------- (5) ワンオペを助ける：月の目標・利益の見通し・仕込みメモ ---------- */
// 期間内の営業日（設定の曜日と、予約タブで変えた日）
async function openDaysBetween(env, s, from, to) {
  const rules = rulesMap((await env.DB.prepare('SELECT date, kind, sessions FROM day_rules WHERE date BETWEEN ? AND ?').bind(from, to).all()).results);
  const out = [];
  for (let d = from; d <= to; d = addDays(d, 1)) {
    const p = dayPlan(d, rules, s);
    if (p.kind === 'open' && p.sessions.length) out.push({ date: d, sessions: p.sessions });
  }
  return out;
}
// その日の営業がもう終わったか（いちばん遅い時間帯の閉店を過ぎたか）
function dayDone(s, day, nowHM) {
  const close = day.sessions.map(k => (s.sessions[k] ? s.sessions[k].close : '00:00')).sort().pop() || '00:00';
  return nowHM >= close;
}

// これまでの経費の傾向（直近3か月の平均）：食材費は売上に比例、それ以外はだいたい毎月かかる
async function moneyTrend(env, force) {
  const hit = await kvGet(env, 'moneyTrend');
  if (!force && hit && Date.now() - hit.t < 6 * 3600000) return hit.v;
  const f = features(env);
  const today = jstStamp(Date.now()).slice(0, 10);
  const cur = today.slice(0, 7);
  const months = [addMonths(cur, -3), addMonths(cur, -2), addMonths(cur, -1)];
  const D = await loadMoneyData(env, months, false);
  let sales = 0, res = 0, guests = 0, expense = 0, food = 0, n = 0;
  for (const ym of months) {
    const x = await salesSums(env, ym + '-01', monthLast(ym));
    const e = D.mf[ym] ? expenseSums([D.mf[ym]], ym + '-01', monthLast(ym)) : null;
    if (!x.sales && !(e && e.total)) continue;
    n++; sales += x.sales; res += x.res; guests += x.guests;
    if (e) { expense += e.total; food += e.food; }
  }
  const v = {
    months: n, hasSales: D.hasSales, hasExpense: D.hasExpense && expense > 0,
    sales: n ? Math.round(sales / n) : 0, expense: n ? Math.round(expense / n) : 0, food: n ? Math.round(food / n) : 0,
    fixed: n ? Math.round((expense - food) / n) : 0,
    ratio: sales ? food / sales : 0,
    perGuest: guests ? Math.round(res / guests) : 0
  };
  await kvPut(env, 'moneyTrend', { t: Date.now(), v: v });
  void f;
  return v;
}
// 利益の目標から、必要な売上を出す（食材費は売上の◯%、それ以外の経費は月に¥◯かかる、として）
function salesForProfit(profit, t) {
  const r = Math.min(0.9, t.ratio || 0);
  return Math.ceil((profit + (t.fixed || 0)) / (1 - r) / 1000) * 1000;
}
async function goalCfg(env) {
  return Object.assign({ on: false, kind: 'sales', amount: 0 }, (await kvGet(env, 'goalCfg')) || {});
}
// 今月の目標の進み具合（残りの営業日で1日あたりいくら必要か）と、このままのペースでの利益の見込み
async function goalStatus(env, cfgIn) {
  const cfg = cfgIn || await goalCfg(env);
  const s = await getSettings(env);
  const now = jstStamp(Date.now());
  const today = now.slice(0, 10);
  const ym = today.slice(0, 7);
  const days = await openDaysBetween(env, s, ym + '-01', monthLast(ym));
  const todayOpen = days.find(d => d.date === today);
  const todayLeft = todayOpen && !dayDone(s, todayOpen, now.slice(11, 16));
  const left = days.filter(d => d.date > today).length + (todayLeft ? 1 : 0);
  const done = days.length - left;
  const t = await moneyTrend(env);
  const sofar = await salesSums(env, ym + '-01', today);
  const booked = await env.DB.prepare("SELECT COALESCE(SUM(guests), 0) AS g, COUNT(*) AS n FROM reservations WHERE status = '確定' AND date BETWEEN ? AND ? AND date >= ?").bind(ym + '-01', monthLast(ym), todayLeft ? today : addDays(today, 1)).first();
  const out = {
    on: !!cfg.on, kind: cfg.kind, amount: Number(cfg.amount) || 0, month: ym,
    openDays: days.length, leftDays: left, doneDays: done,
    sales: sofar.sales, guests: sofar.guests, trend: t,
    bookedGuests: booked.g, bookedGroups: booked.n,
    bookedSales: t.perGuest ? booked.g * t.perGuest : 0
  };
  out.need = cfg.kind === 'profit' ? salesForProfit(out.amount, t) : out.amount;
  out.remain = Math.max(0, out.need - out.sales);
  out.perDay = left ? Math.ceil(out.remain / left / 100) * 100 : 0;
  out.perDayGuests = t.perGuest && out.perDay ? Math.ceil(out.perDay / t.perGuest) : 0;
  out.rate = out.need ? Math.round(out.sales / out.need * 100) : 0;
  // このままのペース（営業した日の平均 × 今月の営業日）
  if (done > 0 && sofar.sales) {
    out.pace = Math.round(sofar.sales / done * days.length / 1000) * 1000;
    if (t.hasExpense) out.paceProfit = Math.round((out.pace * (1 - t.ratio) - t.fixed) / 1000) * 1000;
  }
  if (t.hasExpense) out.breakEven = salesForProfit(0, t);
  return out;
}
function goalText(g) {
  if (!g || !g.on || !g.need) return '';
  return '今月の目標：' + (g.kind === 'profit' ? '利益 ¥' + g.amount.toLocaleString() + '（そのために必要な売上 ¥' + g.need.toLocaleString() + '）' : '売上 ¥' + g.need.toLocaleString()) +
    '、今日までの売上 ¥' + g.sales.toLocaleString() + '（' + g.rate + '%）、残り' + g.leftDays + '営業日' + (g.leftDays ? 'で1日あたり ¥' + g.perDay.toLocaleString() + (g.perDayGuests ? '（予約なら約' + g.perDayGuests + '名）' : '') : '') +
    (g.bookedGuests ? '、これからの予約 ' + g.bookedGuests + '名（約¥' + g.bookedSales.toLocaleString() + '）' : '') + (g.pace ? '、このままのペースだと今月の売上は約¥' + g.pace.toLocaleString() : '');
}
function trendText(t) {
  if (!t || !t.months) return '';
  const parts = ['直近' + t.months + 'か月の平均：売上 ¥' + t.sales.toLocaleString()];
  if (t.hasExpense) {
    parts.push('経費 ¥' + t.expense.toLocaleString() + '（食材費 ¥' + t.food.toLocaleString() + '・売上の' + Math.round(t.ratio * 100) + '%、食材以外 ¥' + t.fixed.toLocaleString() + '）');
    parts.push('利益 ¥' + (t.sales - t.expense).toLocaleString());
    parts.push('利益が出はじめる売上の目安 月¥' + salesForProfit(0, t).toLocaleString());
  }
  if (t.perGuest) parts.push('予約の1人あたり ¥' + t.perGuest.toLocaleString());
  return parts.join('、');
}
async function adminGoal(env, b) {
  const cfg = b.save ? { on: !!b.on, kind: b.kind === 'profit' ? 'profit' : 'sales', amount: Math.max(0, Math.min(100000000, Math.round(Number(String(b.amount || '').replace(/[^\d]/g, '')) || 0))) } : await goalCfg(env);
  if (b.save) {
    await kvPut(env, 'goalCfg', cfg);
    await env.DB.prepare("DELETE FROM kv WHERE k = 'aiChatFacts'").run();
  }
  return { cfg: cfg, status: await goalStatus(env, cfg) };
}
const GOAL_SYSTEM = [
  'あなたは、大阪・阿倍野の小さな薬膳レストラン「épii」（店主ひとりで営業）の経営を手伝う相談役です。店主は数字や会計の言葉が得意ではありません。',
  '月の目標をどのくらいにするとよいか、これまでの数字から目安を出します。',
  '- profit：無理なく届きそうな「利益（売上−経費）」の月の目標（円、1万円単位）。sales：そのために必要な月の売上（円）。',
  '- text：その目安にした理由と、届かせるための具体的なやり方を3文以内で。ひとりで回せる範囲（席数・営業日・仕込みの量）を前提にする。',
  '- 専門用語は使わない。データにないことは書かない。',
  '- ' + AI_BREAK_RULE
].join('\n');
async function adminGoalAdvice(env) {
  const g = await goalStatus(env);
  const head = await factsHead(env);
  const out = await claude(env, {
    system: GOAL_SYSTEM, effort: 'medium', maxTokens: 12000, timeout: 120000,
    content: [{ type: 'text', text: head + '\n\n' + await factsMoney(env) + '\n\n今月の営業日：' + g.openDays + '日（残り' + g.leftDays + '日）\n' + (goalText(g) || '目標はまだ決めていません') }],
    schema: strSchema({ profit: { type: 'integer' }, sales: { type: 'integer' }, text: { type: 'string' } })
  });
  return { profit: Math.max(0, Math.round(out.profit || 0)), sales: Math.max(0, Math.round(out.sales || 0)), text: aiText(out.text, 400) };
}

/* 仕込みメモ：次の営業日の予約を、前の晩にお店のLINEへまとめて送る（予約がなければ送らない） */
const PREP_PARTS = [
  ['list', '時間ごとの予約'], ['course', 'コースごとの人数'], ['caution', '気をつけること（アレルギー・苦手・ご要望）'], ['celebrate', 'お祝い・記念日'],
  ['forecast', 'これから入りそうな予約（見込み）'], ['guests', 'お客様のこと（Claude）'], ['prep', '仕込みのポイント（Claude）'], ['pending', '返事待ちのリクエスト'], ['cheer', 'ひとこと（Claude）']
];
// これから入りそうな予約の見込み：メモを送ったあとも締切が来ていないメニュー（当日の朝まで受け付けるランチなど）は、
// 過去の同じ曜日に「同じタイミングより後に入った予約」の人数から見込む。予約なしのお客様（Square）も同じ曜日の平均を出す
async function prepForecast(env, s, date, sendAt, rows) {
  const today = jstStamp(Date.now()).slice(0, 10);
  const back = [];
  for (let i = 1; i <= 12; i++) { const d = addDays(date, -7 * i); if (d < today) back.push(d); }
  const rules = rulesMap((await env.DB.prepare('SELECT date, kind, sessions FROM day_rules WHERE date BETWEEN ? AND ?').bind(back.length ? back[back.length - 1] : date, date).all()).results);
  const plan = dayPlan(date, rules, s);
  const courses = (await allCourses(env)).filter(c => c.visible && c.weekdays.indexOf(weekday(date)) >= 0 && c.sessions.some(k => plan.sessions.indexOf(k) >= 0));
  const late = courses.map(c => ({ c: c, deadline: deadlineOf(date, cutoffRule(c, s)) })).filter(x => x.deadline > sendAt);
  const past = back.filter(d => dayPlan(d, rules, s).kind === 'open');
  const out = { date: date, days: past.length, weekday: WD[weekday(date)], items: [], walk: [] };
  if (!late.length && !past.length) return out;
  const hist = past.length ? (await env.DB.prepare("SELECT date, course_id, course_name, guests, created_at FROM reservations WHERE status = '確定' AND (arrived IS NULL OR arrived != 'no') AND date IN (" + past.map(() => '?').join(',') + ')').bind(...past).all()).results : [];
  const lead = diffDays(sendAt.slice(0, 10), date);
  const hm = sendAt.slice(11, 16);
  late.forEach(x => {
    const mine = r => r.course_id === x.c.id || (!r.course_id && r.course_name === x.c.name);
    const per = past.map(d => hist.filter(r => r.date === d && mine(r) && String(r.created_at || '') > addDays(d, -lead) + ' ' + hm).reduce((a, r) => a + (Number(r.guests) || 0), 0));
    const booked = rows.filter(r => r.course_id ? r.course_id === x.c.id : r.course_name === x.c.name).reduce((a, r) => a + (Number(r.guests) || 0), 0);
    const avg = per.length ? per.reduce((a, v) => a + v, 0) / per.length : null;
    const max = per.length ? Math.max(...per) : null;
    const cap = Math.min(x.c.cap || s.seats, s.seats);
    out.items.push({ name: x.c.name, deadline: x.deadline, booked: booked, avg: avg, max: max, cap: cap,
      suggest: avg === null ? null : Math.min(cap, booked + Math.round(avg)), high: max === null ? null : Math.min(cap, booked + max) });
  });
  // 予約なしのお客様（Squareの会計で、予約に結びついていないもの）
  if (past.length && features(env).square) {
    const pays = (await env.DB.prepare("SELECT date, ts FROM sq_payments WHERE status = 'COMPLETED' AND amount > refunded AND link NOT IN ('auto','res') AND date IN (" + past.map(() => '?').join(',') + ')').bind(...past).all()).results;
    plan.sessions.forEach(k => {
      const c = s.sessions[k];
      if (!c) return;
      const n = pays.filter(p => { const m = toMin(p.ts.slice(11, 16)); return m >= toMin(c.open) - 30 && m < toMin(c.close) + 60; }).length;
      out.walk.push({ session: sessionLabel(s, k), avg: n / past.length });
    });
  }
  return out;
}
function forecastLines(fc) {
  if (!fc) return [];
  const lines = [];
  fc.items.forEach(x => {
    const dl = (x.deadline.slice(0, 10) === fc.date ? '当日' : jdShort(x.deadline.slice(0, 10))) + Number(x.deadline.slice(11, 13)) + ':' + x.deadline.slice(14, 16) + 'まで受付';
    const head = '・' + x.name + '（' + dl + '）いま' + x.booked + '名';
    if (x.avg === null) lines.push(head + '。記録が少なく、見込みは出せません');
    else if (!x.max) lines.push(head + '。これまで、この時間からは増えていません');
    else lines.push(head + '。まだ増えそうなので ' + (x.suggest === x.high ? x.suggest : (x.suggest === x.booked ? x.booked + '〜' + x.high : x.suggest + '〜' + x.high)) + '名分の用意を');
  });
  fc.walk.filter(w => w.avg >= 0.5).forEach(w => lines.push('・予約なしのお客様（' + w.session + '）：いつも約' + Math.round(w.avg) + '組'));
  if (lines.length) lines.push('（過去' + fc.days + '回の' + fc.weekday + '曜の予約の入り方から）');
  return lines;
}
// 店主が足した項目：kind 'ai' は Claude へのお願い（予約を読んでまとめてもらう）、'text' は毎回そのまま入れる文
function prepCustom(list) {
  return (Array.isArray(list) ? list : []).slice(0, 8).map((x, i) => ({
    id: /^c[a-z0-9]{1,12}$/.test(String(x && x.id)) ? x.id : 'c' + i,
    title: clean(x && x.title, 20), kind: x && x.kind === 'text' ? 'text' : 'ai', body: clean(x && x.body, 300), on: !(x && x.on === false)
  })).filter(x => x.title && x.body);
}
async function prepCfg(env) {
  const v = (await kvGet(env, 'prepCfg')) || {};
  const parts = {};
  PREP_PARTS.forEach(p => { parts[p[0]] = !v.parts || v.parts[p[0]] !== false; });
  return { on: !!v.on, time: /^\d{2}:\d{2}$/.test(v.time || '') ? v.time : '21:00', parts: parts, note: String(v.note || ''), custom: prepCustom(v.custom), empty: !!v.empty };
}
const CHEER_RULE = 'ひとことの書き方：お店の数字（下の「ひとことのための数字」）から、前向きになれる事実を1つ選んで、具体的な数字を入れてねぎらう（例「先週は予約0組でしたが、明日は1組。最初のお客様を楽しみに」「今月はもう目標の76%。あと少しです」）。少ない時期は責めずに、次につながる見方をする。体も気づかう。1〜2文、70文字以内。数字はデータにあるものだけ。大げさにせず、絵文字は使わない。毎回同じ言い回しにしない。';
// ひとことのための数字：先週と今週の来店、これからの予約、今月の売上と目標
async function cheerFacts(env, next) {
  const today = jstStamp(Date.now()).slice(0, 10);
  const q = (a, b) => env.DB.prepare("SELECT COUNT(*) AS g, COALESCE(SUM(guests), 0) AS n FROM reservations WHERE status = '確定' AND (arrived IS NULL OR arrived != 'no') AND date BETWEEN ? AND ?").bind(a, b).first();
  const [w1, w0, ahead] = await Promise.all([q(addDays(today, -7), addDays(today, -1)), q(addDays(today, -14), addDays(today, -8)), q(today, addDays(today, 6))]);
  const lines = ['直近7日の予約の来店 ' + w1.g + '組' + w1.n + '名（その前の7日は ' + w0.g + '組' + w0.n + '名）', '今日から7日間の予約 ' + ahead.g + '組' + ahead.n + '名'];
  if (next) { const n = await q(next, next); lines.push(jdShort(next) + '（' + WD[weekday(next)] + '）の予約 ' + n.g + '組' + n.n + '名'); }
  try {
    const g = await goalStatus(env);
    if (features(env).square) lines.push('今月の売上 ¥' + g.sales.toLocaleString() + (g.on && g.need ? '（目標の' + g.rate + '%、残り' + g.leftDays + '営業日）' : ''));
  } catch (e) { /* 売上がなくても書ける */ }
  return '【ひとことのための数字】\n' + lines.join('\n');
}
const PREP_SYSTEM = [
  'あなたは、大阪・阿倍野の小さな薬膳レストラン「épii」の店主（ひとりで仕込みから接客まで切り盛りしています）のために、次の営業日の「仕込みメモ」を作ります。店主は前の晩にLINEで読みます。',
  '予約ごとに記号（A、B…）を付けて渡します。お客様の名前は渡しません。記号で答えてください。',
  'お店の設定（時間帯・営業日・メニューごとの予約の締切）も渡します。メモを送ったあとでも締切が来ていないメニュー（当日の朝まで受け付けるランチなど）は、まだ予約が増えることを前提に考えてください。',
  '- cautions：アレルギー・苦手な食材・体調・食べ方の配慮など、料理で気をつけること。ref は記号、text は25文字以内。なければ空。',
  '- celebrations：誕生日・記念日・お祝い・プレートの希望など。ref と text（25文字以内）。なければ空。',
  '- guests：これまでの来店やお店のメモから、どんなお客様か（何回目・前回のこと・好み）。初めての方は書かない。ref と text（40文字以内）。',
  '- prep：仕込みで前もって用意するとよいことを、具体的に短く（各25文字以内、3つまで）。例「くるみを使わない皿を1名分」「ランチは見込みで5名分」。「これから入りそうな予約の見込み」があれば、締切までに増えそうな人数も考えて、何名分用意するとよいかを入れる。データから言えることだけ。',
  '- custom：「店主が足した項目」があるときだけ。項目ごとに id と lines（店主のお願いに沿って、予約から言えることを短い行で。各40文字以内、5行まで。お客様に触れるときは記号を「A：」のように行の頭に付ける。言えることがなければ空）。',
  '- cheer：店主へのひとこと。メモの日が明日でないときは「明日」と書かない（曜日で書く）。お客様のことは書かない。' + CHEER_RULE,
  '- データにないことは書かない。推測しない。'
].join('\n');
const PREP_SCHEMA = strSchema({
  cautions: { type: 'array', items: strSchema({ ref: { type: 'string' }, text: { type: 'string' } }) },
  celebrations: { type: 'array', items: strSchema({ ref: { type: 'string' }, text: { type: 'string' } }) },
  guests: { type: 'array', items: strSchema({ ref: { type: 'string' }, text: { type: 'string' } }) },
  prep: { type: 'array', items: { type: 'string' } },
  custom: { type: 'array', items: strSchema({ id: { type: 'string' }, lines: { type: 'array', items: { type: 'string' } } }) },
  cheer: { type: 'string' }
});
const CHEER_PLAIN = ['明日もおつかれさまです。今夜はゆっくり休んでくださいね。', '仕込みは無理のない範囲で。いつもおつかれさまです。', '明日もいい一日になりますように。早めに休んでくださいね。'];
function shortName(n) { return String(n || '').trim().split(/\s+/)[0] || 'お客'; }
// 見本用のお客様（予約がひとつもないとき）
async function prepSampleRows(env, date) {
  const s = await getSettings(env);
  const courses = (await allCourses(env)).filter(c => c.visible);
  const keys = sessionKeys(s);
  const k1 = keys.indexOf('lunch') >= 0 ? 'lunch' : keys[0];
  const k2 = keys.indexOf('dinner') >= 0 ? 'dinner' : keys[keys.length - 1];
  const pick = k => { const c = courses.find(x => (x.sessions || []).indexOf(k) >= 0) || courses[0]; return c ? c.name : 'おまかせコース'; };
  const at = k => (s.sessions[k] && s.sessions[k].first) || '12:00';
  return [
    { id: 'sample1', date: date, time: at(k1), session: k1, guests: 2, name: '見本花子', course_name: pick(k1), note: 'くるみのアレルギーがあります', memo: '' },
    { id: 'sample2', date: date, time: at(k2), session: k2, guests: 3, name: '見本太郎', course_name: pick(k2), note: '母の誕生日のお祝いです。デザートにひとことお願いできますか', memo: '' }
  ];
}
async function prepMemo(env, date, cfg, sample) {
  const s = await getSettings(env);
  const today = jstStamp(Date.now()).slice(0, 10);
  const rows = sample ? await prepSampleRows(env, date) : (await env.DB.prepare("SELECT * FROM reservations WHERE date = ? AND status = '確定' ORDER BY time, created_at").bind(date).all()).results;
  // 予約が0件の日：設定で「見込みがあれば送る」にしていて、締切までに入りそうなときだけ作る
  if (!rows.length) {
    if (!cfg.empty) return null;
    const at0 = jstStamp(Date.now());
    const sa0 = at0 > addDays(date, -1) + ' ' + (cfg.time || '21:00') ? at0 : addDays(date, -1) + ' ' + (cfg.time || '21:00');
    const f0 = await prepForecast(env, s, date, sa0, []).catch(() => null);
    if (!f0 || !(f0.items.some(x => x.avg >= 0.5) || f0.walk.some(w => w.avg >= 0.5))) return null;
  }
  const pend = sample ? 0 : (await env.DB.prepare("SELECT COUNT(*) AS n FROM reservations WHERE date = ? AND status IN ('返事待ち','提案中')").bind(date).first()).n;
  const custom = (cfg.custom || []).filter(x => x.on);
  const aiCustom = custom.filter(x => x.kind === 'ai');
  const hash = await hashOf(JSON.stringify(rows.map(r => [r.id, r.time, r.guests, r.course_name, r.note, r.memo])));
  const [crows, info] = await Promise.all([allCustomerRows(env), customerInfo(env)]);
  const grouped = groupCustomers(crows, info);
  const P = cfg.parts;
  // 送るとき（見本は、設定した時刻に送ったとして）より後に締切があるメニューの見込み
  const nowStamp = jstStamp(Date.now());
  const sendAt = nowStamp > addDays(date, -1) + ' ' + (cfg.time || '21:00') ? nowStamp : addDays(date, -1) + ' ' + (cfg.time || '21:00');
  let fc = null;
  if (P.forecast || P.prep) { try { fc = await prepForecast(env, s, date, sendAt, rows); } catch (e) { console.error('見込み', e && e.message); } }
  const fcl = forecastLines(fc);
  const refs = rows.map((r, i) => ({ r: r, ref: String.fromCharCode(65 + (i % 26)) + (i >= 26 ? Math.floor(i / 26) : ''), f: guestFacts(r, grouped, info, today) }));
  const who = x => x.r.time + ' ' + shortName(x.r.name) + '様';
  const guests = rows.reduce((a, r) => a + (Number(r.guests) || 0), 0);
  const bySess = {};
  rows.forEach(r => { const k = sessionLabel(s, r.session); bySess[k] = bySess[k] || [0, 0]; bySess[k][0]++; bySess[k][1] += Number(r.guests) || 0; });
  const lines = ['【仕込みメモ ' + jd(date) + '】', !rows.length ? 'ご予約 まだありません（見込みだけ）' : 'ご予約 ' + rows.length + '組 ' + guests + '名' + (Object.keys(bySess).length > 1 ? '（' + Object.keys(bySess).map(k => k + ' ' + bySess[k][0] + '組' + bySess[k][1] + '名').join('・') + '）' : '')];
  if (P.list && rows.length) {
    lines.push('', '■ 時間ごと');
    refs.forEach(x => lines.push(x.r.time + ' ' + x.r.name + '様 ' + x.r.guests + '名 ' + (x.r.course_name || 'コース未定') + '（' + (x.f && x.f.visits ? (x.f.visits + 1) + '回目' : '初めて') + '）'));
  }
  if (P.course && rows.length) {
    const c = {};
    rows.forEach(r => { const k = r.course_name || 'コース未定'; c[k] = (c[k] || 0) + (Number(r.guests) || 0); });
    lines.push('', '■ コースごとの人数', ...Object.keys(c).map(k => k + ' ' + c[k] + '名'));
  }
  // Claude にまとめてもらう（名前・電話番号は送らない）
  let ai = null;
  const wantAi = env.ANTHROPIC_API_KEY && (P.caution || P.celebrate || P.guests || P.prep || P.cheer || aiCustom.length);
  if (wantAi) {
    const input = await factsSettings(env, today, date) + '\n\n今日：' + jdLong(today) + '\nメモを送る時刻：' + sendAt + '\nメモの日（次の営業日）：' + jdLong(date) + (addDays(today, 1) === date ? '（明日）' : '（' + diffDays(today, date) + '日後。明日ではありません）') + '、' + rows.length + '組 ' + guests + '名、' + s.seats + '席\n' + refs.map(x => [
      x.ref, x.r.time, x.r.guests + '名', x.r.course_name || 'コース未定',
      '来店：' + (x.f && x.f.visits ? (x.f.visits + 1) + '回目' : '初めて'),
      'ご要望：' + (noPrivate(x.r.note, 200) || 'なし'),
      x.r.memo ? 'この予約のメモ：' + noPrivate(x.r.memo, 200) : '',
      x.f && x.f.memo ? 'お客様メモ：' + x.f.memo : '',
      x.f && x.f.past.length ? 'これまで：' + x.f.past.slice(0, 3).map(p => p.date + ' ' + p.course + (p.note ? '（' + p.note + '）' : '')).join('／') : ''
    ].filter(Boolean).join('｜')).join('\n') +
      (fcl.length ? '\n\nこれから入りそうな予約の見込み（締切がまだのメニュー・予約なしのお客様）：\n' + fcl.join('\n') : '') +
      (P.cheer ? '\n\n' + await cheerFacts(env, date) : '') +
      (aiCustom.length ? '\n\n店主が足した項目（id｜項目の名前｜お願い）：\n' + aiCustom.map(x => x.id + '｜' + x.title + '｜' + x.body).join('\n') : '');
    const src = await hashOf(input);
    const ckey = 'prep:' + (sample ? 'sample' : date);
    const hit = await aiCacheGet(env, ckey);
    if (hit && hit.src === src) ai = hit.v;
    else {
      try {
        const out = await claude(env, { system: PREP_SYSTEM, effort: 'low', maxTokens: 8000, content: [{ type: 'text', text: input }], schema: PREP_SCHEMA });
        const pick = list => (list || []).map(x => ({ ref: String(x.ref || '').trim(), text: plain(clean(x.text, 80)) })).filter(x => x.text);
        const cus = {};
        (out.custom || []).forEach(x => { cus[String(x.id)] = (x.lines || []).map(l => plain(clean(l, 80))).filter(Boolean).slice(0, 5); });
        ai = { cautions: pick(out.cautions), celebrations: pick(out.celebrations), guests: pick(out.guests), prep: (out.prep || []).map(x => plain(clean(x, 60))).filter(Boolean).slice(0, 3), custom: cus, cheer: plain(clean(out.cheer, 120)) };
        await aiCachePut(env, ckey, src, ai);
      } catch (e) { console.error('仕込みメモ', e && e.message); }
    }
  }
  const byRef = {};
  refs.forEach(x => { byRef[x.ref] = x; });
  const refLines = list => (list || []).map(x => '・' + (byRef[x.ref] ? who(byRef[x.ref]) + '：' : '') + x.text);
  if (P.caution) {
    let l = ai ? refLines(ai.cautions) : refs.filter(x => /アレルギ|苦手|抜き|食べられ|控え|妊娠|ベジ|ヴィーガン/.test(x.r.note || '')).map(x => '・' + who(x) + '：' + noPrivate(x.r.note, 60));
    if (l.length) lines.push('', '■ 気をつけること', ...l);
  }
  if (P.celebrate) {
    const l = ai ? refLines(ai.celebrations) : refs.filter(x => /誕生|記念|お祝|結婚|プレート|サプライズ/.test(x.r.note || '')).map(x => '・' + who(x) + '：' + noPrivate(x.r.note, 60));
    if (l.length) lines.push('', '■ お祝い・記念日', ...l);
  }
  if (P.forecast && fcl.length) lines.push('', '■ これから入りそうな予約（見込み）', ...fcl);
  if (P.guests && ai && ai.guests.length) lines.push('', '■ お客様のこと（Claude）', ...refLines(ai.guests));
  if (P.prep && ai && ai.prep.length) lines.push('', '■ 仕込みのポイント（Claude）', ...ai.prep.map(x => '・' + x));
  // 店主が足した項目（Claude にまとめてもらうもの・毎回同じ文）
  custom.forEach(x => {
    if (x.kind === 'text') { lines.push('', '■ ' + x.title, x.body); return; }
    const got = ai && ai.custom ? ai.custom[x.id] || [] : null;
    if (!got) return;
    const l = got.map(t => { const m = t.match(/^([A-Z]\d*)[：:]\s*/); return '・' + (m && byRef[m[1]] ? who(byRef[m[1]]) + '：' + t.slice(m[0].length) : t); });
    if (l.length) lines.push('', '■ ' + x.title + '（Claude）', ...l);
  });
  if (P.pending && pend) lines.push('', '■ 返事待ちのリクエスト', 'この日にまだ返事をしていないリクエストが' + pend + '件あります');
  if (cfg.note && cfg.note.trim()) lines.push('', '■ いつものメモ', cfg.note.trim());
  if (P.cheer) lines.push('', (ai && ai.cheer) || CHEER_PLAIN[Number(date.slice(8)) % CHEER_PLAIN.length]);
  return { date: date, text: lines.join('\n').slice(0, 4800), hash: hash, groups: rows.length, guests: guests };
}
// 定期実行から：設定した時刻を過ぎたら、次の営業日のメモを送る。前の日に変更があれば、もう一度だけ送る
async function prepNotify(env, force) {
  const cfg = await prepCfg(env);
  if (!cfg.on && !force) return { skipped: 'off' };
  const now = jstStamp(Date.now());
  const today = now.slice(0, 10);
  if (!force) {
    if (now.slice(11, 16) < cfg.time) return { skipped: 'time' };
    const chk = await kvGet(env, 'prepChecked');
    if (chk && chk.date === today) return { skipped: 'checked' };
    await kvPut(env, 'prepChecked', { date: today });
  }
  const s = await getSettings(env);
  const next = (await openDaysBetween(env, s, addDays(today, 1), addDays(today, 45)))[0];
  if (!next) return { skipped: 'noday' };
  const memo = await prepMemo(env, next.date, cfg);
  if (!memo) return { skipped: 'empty', date: next.date };
  const sent = (await kvGet(env, 'prepSent')) || {};
  const prev = sent[next.date];
  if (prev && !force) {
    if (prev.hash === memo.hash || addDays(next.date, -1) !== today || prev.day === today) return { skipped: 'same', date: next.date };
    memo.text = memo.text.replace('】\n', '】\n（前に送ったあとで予約が変わりました）\n');
  }
  const res = await pushOwner(env, memo.text);
  if (res.ok) {
    Object.keys(sent).forEach(d => { if (d < today) delete sent[d]; });
    sent[next.date] = { hash: memo.hash, day: today, at: now };
    await kvPut(env, 'prepSent', sent);
  }
  return { ok: res.ok, message: res.message || '', date: next.date, text: memo.text };
}
async function adminPrep(env, b) {
  if (b.save) {
    const parts = {};
    PREP_PARTS.forEach(p => { parts[p[0]] = !(b.parts && b.parts[p[0]] === false); });
    await kvPut(env, 'prepCfg', { on: !!b.on, time: /^\d{2}:\d{2}$/.test(b.time || '') ? b.time : '21:00', parts: parts, note: clean(b.note, 300), custom: prepCustom(b.custom), empty: !!b.empty });
  }
  const cfg = await prepCfg(env);
  if (b.preview || b.send) {
    const s = await getSettings(env);
    const today = jstStamp(Date.now()).slice(0, 10);
    const use = Object.assign({}, cfg, b.parts ? { parts: Object.assign({}, cfg.parts, b.parts), note: clean(b.note, 300), custom: prepCustom(b.custom) } : {});
    const next = (await openDaysBetween(env, s, addDays(today, 1), addDays(today, 45)))[0];
    let memo = next ? await prepMemo(env, next.date, use) : null;
    let why = '';
    if (!memo) {
      // 次の営業日に予約がないときは、いちばん近い予約のある日。それもなければ見本のお客様で
      const r = await env.DB.prepare("SELECT date FROM reservations WHERE status = '確定' AND date > ? ORDER BY date LIMIT 1").bind(today).first();
      if (r) { memo = await prepMemo(env, r.date, use); why = '次の営業日は予約がないので、' + jd(r.date) + 'の分で見本を作りました'; }
      else { memo = await prepMemo(env, next ? next.date : addDays(today, 1), use, true); memo.sample = true; why = '予約がないので、見本のお客様で作りました'; }
    }
    const text = memo.sample ? memo.text.replace('【仕込みメモ ', '【仕込みメモ（見本） ') : memo.text;
    if (b.send) {
      const res = await pushOwner(env, text);
      if (!res.ok) fail('LINEに送れませんでした（' + (res.message || 'エラー') + '）。');
    }
    return { cfg: cfg, preview: { date: memo.date, next: next ? next.date : '', text: text, sent: !!b.send, sample: !!memo.sample, note: why } };
  }
  return { cfg: cfg, parts: PREP_PARTS };
}

/* ---------- (6) 帳簿のチェック：登録がおかしい仕訳を見つけて、この画面から直す ----------
 * 確定申告の年の仕訳（1〜3月は前の年の分も）を対象に、決まったルールで見つける。直すのは店主が押したときだけ。
 * Square の売上とマネーフォワードの売上も、月ごと・日ごとに照らし合わせる */
function bookMonths(today) {
  const y = Number(today.slice(0, 4)) - (Number(today.slice(5, 7)) <= 3 ? 1 : 0);
  return monthsBetween(y + '-01-01', today);
}
async function bookJournals(env, months, force) {
  const cur = jstStamp(Date.now()).slice(0, 7);
  await eachLimit(months, 3, async ym => { await mfMonth(env, ym, mfAge(ym, cur, force)); });
  const out = [];
  for (const ym of months) {
    const r = await env.DB.prepare('SELECT v FROM kv WHERE k = ?').bind('mfj:' + ym).first();
    if (!r) { await env.DB.prepare('DELETE FROM kv WHERE k = ?').bind('mfs:' + ym).run(); continue; }
    try { JSON.parse(r.v).forEach(j => out.push(j)); } catch (e) { /* 読めない月は飛ばす */ }
  }
  return out.sort((a, b) => (a.d + a.i).localeCompare(b.d + b.i));
}
const BOOK_EXPENSE = /仕入|費|料|家賃|賃|税|手当|給|消耗|雑損/;
function bookRemark(j, bi) {
  const own = j.b[bi] && j.b[bi][4];
  return own || j.b.map(x => x[4]).find(Boolean) || j.m || '';
}
// 振込の相手（個人名）は Claude に送らない
function maskRemark(v) {
  return noPrivate(String(v || ''), 80).replace(/(振込|ﾌﾘｺﾐ|フリコミ)\s*[ｦ-ﾟァ-ヶー･・ 　]+/g, '$1（相手）');
}
async function bookIssues(env, force) {
  const today = jstStamp(Date.now()).slice(0, 10);
  const months = bookMonths(today);
  const js = await bookJournals(env, months, force);
  const ign = (await kvGet(env, 'bookIgnore')) || {};
  const issues = [];
  const add = x => { if (!ign[x.key]) issues.push(x); };
  const SAGAKU = /V\s*(ｻｶﾞｸ|サガク)\s*(\d{5,})/i;
  // 前に登録した摘要と科目（科目の提案の根拠に使う）
  const past = {};
  js.forEach(j => j.b.forEach(br => { if (br[0] && BOOK_EXPENSE.test(br[0]) && br[4]) { const k = txKey(br[4]); (past[k] = past[k] || []).push({ acc: br[0], d: j.d, v: br[1], r: br[4] }); } }));
  const pastOf = rm => { const l = past[txKey(rm)] || []; if (!l.length) return null; const c = {}; l.forEach(x => { c[x.acc] = (c[x.acc] || 0) + 1; }); const acc = Object.keys(c).sort((a, b) => c[b] - c[a])[0]; return c[acc] === l.length ? { acc: acc, n: l.length, last: l[l.length - 1] } : null; };
  js.forEach(j => {
    // (0) 貸借が合わない仕訳
    const dsum = j.b.reduce((a, br) => a + (br[0] ? br[1] : 0), 0), csum = j.b.reduce((a, br) => a + (br[2] ? br[3] : 0), 0);
    if (dsum !== csum) add({ key: 'bal:' + j.i, kind: 'bal', id: j.i, date: j.d, amount: Math.abs(dsum - csum), remark: bookRemark(j, 0), title: '貸借が合っていない', detail: '借方 ' + dsum.toLocaleString() + '円／貸方 ' + csum.toLocaleString() + '円', why: 'マネーフォワードで金額を確かめてください', fix: false });
    // (1) 借方と貸方が同じ科目：何も記録されていないのと同じ
    j.b.forEach((br, bi) => {
      if (!br[0] || br[0] !== br[2]) return;
      const rm = bookRemark(j, bi);
      const p = pastOf(rm);
      let to = '', why = '';
      if (/生計|生活|家族|個人|私用/.test(rm)) { to = '事業主貸'; why = '摘要に「' + rm.match(/生計|生活|家族|個人|私用/)[0] + '」とあるので、自分のために使ったお金'; }
      else if (p) { to = p.acc; why = '同じ相手をいつも' + p.acc + 'で登録（' + p.n + '件、前回 ' + jdShort(p.last.d) + ' ' + p.last.v.toLocaleString() + '円）'; }
      add({ key: 'same:' + j.i + ':' + bi, kind: 'same', id: j.i, bi: bi, date: j.d, amount: br[1], remark: rm, title: '中身が空の仕訳', detail: br[0] + '／' + br[2], why: why, side: 'debit', to: to, fix: true });
    });
    // (2) 事業主貸と事業主借だけの仕訳：意味がない（消してよい）
    if (j.b.length && j.b.every(br => (br[0] === '事業主貸' || !br[0]) && (br[2] === '事業主借' || !br[2]))) {
      add({ key: 'pair:' + j.i, kind: 'pair', id: j.i, date: j.d, amount: dsum, remark: bookRemark(j, 0), title: '意味のない仕訳', detail: '事業主貸／事業主借', why: '借方も貸方も自分のお金なので、帳簿に影響しません', fix: true });
    }
    // (3) デビットの差額（Vサガク）：番号と金額が元の支払いと合うときだけ、元の科目にする
    j.b.forEach((br, bi) => {
      const rm = bookRemark(j, bi);
      const m = String(rm).normalize('NFKC').match(/Vサガク\s*(\d{5,})/i) || String(rm).match(SAGAKU);
      if (!m) return;
      const code = m[m.length - 1];
      const refund = br[2] === '雑収入' ? br[3] : 0;
      const extra = br[0] && BOOK_EXPENSE.test(br[0]) ? br[1] : 0;
      if (!refund && !extra) return;
      const origs = [];
      js.forEach(o => o.b.forEach(x => { const r = String(x[4] || o.m).normalize('NFKC'); if (o !== j && x[0] && BOOK_EXPENSE.test(x[0]) && r.indexOf('V' + code) >= 0 && !/サガク/.test(r)) origs.push({ o: o, x: x, r: r }); }));
      const amt = refund || extra;
      const hit = origs.find(o => o.x[1] === amt) || null;
      if (refund) {
        if (hit) add({ key: 'vs:' + j.i + ':' + bi, kind: 'vs', id: j.i, bi: bi, date: j.d, amount: refund, remark: rm, title: 'デビットの返金が雑収入', detail: hit.x[0] + 'の返金にできます', why: jdShort(hit.o.d) + '「' + clean(hit.r, 30) + '」' + amt.toLocaleString() + '円と、番号と金額が同じ', side: 'credit', to: hit.x[0], fix: true });
        else if (origs.length) add({ key: 'vsx:' + j.i + ':' + bi, kind: 'info', id: j.i, date: j.d, amount: refund, remark: rm, title: 'デビットの返金', detail: '金額が元の支払いと違う', why: '番号が同じ ' + jdShort(origs[0].o.d) + ' ' + origs[0].x[1].toLocaleString() + '円（' + origs[0].x[0] + '）の一部の返金かもしれません', fix: false });
      } else if (hit && hit.x[0] !== br[0]) {
        add({ key: 'vs2:' + j.i + ':' + bi, kind: 'acct', id: j.i, bi: bi, date: j.d, amount: extra, remark: rm, title: 'デビットの差額の科目', detail: br[0] + ' → ' + hit.x[0], why: jdShort(hit.o.d) + '「' + clean(hit.r, 30) + '」と番号が同じ（元は' + hit.x[0] + '）', side: 'debit', from: br[0], to: hit.x[0], fix: true });
      }
    });
  });
  // (4) 買掛金・未払金が14日以上残っている（払ったのに記録がないかも）
  ['買掛金', '未払金'].forEach(an => {
    const open = [];
    js.forEach(j => j.b.forEach((br, bi) => {
      if (br[2] === an) open.push({ j: j, bi: bi, v: br[3] });
      if (br[0] === an) { let v = br[1]; while (v > 0 && open.length) { const o = open[0]; const use = Math.min(v, o.v); o.v -= use; v -= use; if (o.v <= 0) open.shift(); } }
    }));
    open.filter(o => o.v > 0 && diffDays(o.j.d, today) >= 14).forEach(o => add({ key: 'ap:' + o.j.i + ':' + o.bi, kind: 'ap', id: o.j.i, bi: o.bi, date: o.j.d, amount: o.v, remark: bookRemark(o.j, o.bi), title: 'まだ払っていないことに', detail: an + 'のまま', why: diffDays(o.j.d, today) + '日たっても、払った記録（' + an + 'の借方）がありません', side: 'credit', from: an, fix: true }));
  });
  // (5) 未収金（Squareのカード売上）：入金で売上より多く消えていないか、入金が来ていないものはないか
  let ar = 0, arSince = '';
  js.forEach(j => {
    j.b.forEach(br => { if (br[0] === '未収金') { if (!ar) arSince = j.d; ar += br[1]; } });
    j.b.forEach(br => {
      if (br[2] !== '未収金') return;
      ar -= br[3];
      if (ar < 0) { add({ key: 'arneg:' + j.i, kind: 'info', id: j.i, date: j.d, amount: -ar, remark: bookRemark(j, 0), title: '入金が売上より多い', detail: '未収金がマイナス ' + (-ar).toLocaleString() + '円', why: '入金が二重に登録されているか、カードの売上' + (-ar).toLocaleString() + '円分の登録漏れかも', fix: false }); ar = 0; }
      if (ar === 0) arSince = '';
    });
  });
  if (ar > 0 && arSince && diffDays(arSince, today) >= 10) add({ key: 'ar:' + arSince, kind: 'info', date: arSince, amount: ar, remark: '', title: 'Squareの入金が来ていないかも', detail: '未収金が' + jdShort(arSince) + 'から残っています', why: 'Squareはふつう数日で入金されます。入金の明細が登録されていないかも', fix: false });
  // (6) 10万円以上の消耗品：まとめて経費にできないことがある
  js.forEach(j => j.b.forEach((br, bi) => { if (br[0] === '消耗品費' && br[1] >= 100000) add({ key: 'big:' + j.i + ':' + bi, kind: 'info', id: j.i, date: j.d, amount: br[1], remark: bookRemark(j, bi), title: '10万円以上の消耗品', detail: '固定資産になることがあります', why: '10万円以上の道具や機械は、何年かに分けて経費にすることがあります', fix: false }); }));
  // Claude に見てもらった結果（押したときだけ作る）
  const ai = await kvGet(env, 'bookAi');
  if (ai && ai.items) ai.items.forEach(x => { const j = js.find(o => o.i === x.id); if (j && j.b[x.bi] && j.b[x.bi][0] === x.from) add({ key: 'ai:' + x.id + ':' + x.bi + ':' + x.to, kind: 'acct', id: x.id, bi: x.bi, date: j.d, amount: j.b[x.bi][1], remark: bookRemark(j, x.bi), title: x.title, detail: x.from + ' → ' + x.to, why: x.why, side: 'debit', from: x.from, to: x.to, fix: true, ai: true }); });
  // 科目の見当がつかない「中身が空の仕訳」は Claude にすすめてもらう（摘要だけ送る）
  const unknown = issues.filter(x => x.kind === 'same' && !x.to);
  if (unknown.length && env.ANTHROPIC_API_KEY) {
    try {
      const m = await mfMaster(env);
      const opts = txOptions(m, await expenseOptions(env, m));
      const text = unknown.map((x, i) => i + '｜' + x.date + '｜' + maskRemark(x.remark) + '｜¥' + x.amount).join('\n');
      const src = await hashOf(text);
      const hit = await aiCacheGet(env, 'booksame');
      let got = hit && hit.src === src ? hit.v : null;
      if (!got) {
        const out = await claude(env, { system: TX_SYSTEM, effort: 'low', maxTokens: 4000,
          content: [{ type: 'text', text: '勘定科目の一覧：' + accountList(opts) + '\n\n現金で払ったものの摘要（番号｜日付｜摘要｜金額）：\n' + text }],
          schema: strSchema({ items: { type: 'array', items: strSchema({ id: { type: 'string' }, account: { type: 'string' }, rate: { type: 'string', enum: ['8', '10', 'none'] }, reason: { type: 'string' }, unsure: { type: 'boolean' }, sure: { type: 'boolean' } }) } }) });
        got = {};
        (out.items || []).forEach(o => { if (opts.some(a => a.name === o.account) && !o.unsure) got[String(o.id)] = { acc: o.account, why: plain(clean(o.reason, 40)) }; });
        await aiCachePut(env, 'booksame', src, got);
      }
      unknown.forEach((x, i) => { const g = got[String(i)]; if (g && g.acc) { x.to = g.acc; x.why = 'Claudeの推測：' + (g.why || g.acc); x.ai = true; } });
    } catch (e) { console.error('帳簿のチェック：科目', e && e.message); }
  }
  issues.sort((a, b) => (b.fix ? 1 : 0) - (a.fix ? 1 : 0) || String(a.date).localeCompare(String(b.date)));
  const bal = js.filter(j => j.b.reduce((a, br) => a + (br[0] ? br[1] : 0), 0) === j.b.reduce((a, br) => a + (br[2] ? br[3] : 0), 0)).length;
  return { issues: issues, js: js, months: months, balanced: bal, total: js.length };
}
// Square の売上と、マネーフォワードの売上（Square連携の仕訳）を、会計ひとつずつ照らし合わせる
async function bookSales(env, js, months) {
  if (!features(env).square) return [];
  try { await sqEnsure(env, months, 6 * 3600000); } catch (e) { return []; }
  const today = jstStamp(Date.now()).slice(0, 10);
  // マネーフォワードのSquare連携は1日ほど遅れて届くので、おとといまでで比べる
  const until = addDays(today, -2);
  const mf = [], other = {};
  js.forEach(j => {
    if (j.d > until) return;
    let v = 0;
    j.b.forEach(br => { if (br[2] === '売上高') v += br[3]; if (br[0] === '売上高' || br[0] === '売上値引・返品') v -= br[1]; });
    if (!v) return;
    const text = j.b.map(br => br[4]).join(' ') + ' ' + j.m;
    const sq = /お取引/.test(text);
    if (!sq) { other[j.d.slice(0, 7)] = (other[j.d.slice(0, 7)] || 0) + v; return; }
    const tm = text.match(/(\d{4})\/(\d{2})\/(\d{2}) (\d{2}):(\d{2})/);
    const no = (text.match(/お取引\s*No\.\s*(\S+)/) || [])[1] || '';
    mf.push({ d: j.d, t: tm ? tm[4] + ':' + tm[5] : '', v: v, no: no, used: false });
  });
  const pays = (await env.DB.prepare("SELECT date, ts, amount - refunded AS v, refunded FROM sq_payments WHERE status = 'COMPLETED' AND amount > refunded AND date BETWEEN ? AND ? ORDER BY ts").bind(months[0] + '-01', until).all()).results;
  const miss = [];
  pays.forEach(p => {
    const t = p.ts.slice(11, 16);
    const cand = mf.filter(x => !x.used && x.d === p.date && x.v === p.v && (!x.t || Math.abs(toMin(x.t) - toMin(t)) <= 3));
    if (cand.length) cand[0].used = true; else miss.push({ d: p.date, t: t, v: p.v, refunded: p.refunded });
  });
  // 同じ時刻の会計が、マネーフォワードでは1つにまとまっていることがある（その逆も）。合計が同じなら合っているとみなす
  const near = (a, b) => a.d === b.d && (!a.t || !b.t || Math.abs(toMin(a.t) - toMin(b.t)) <= 3);
  const subset = (list, target) => {
    const c = list.slice(0, 8);
    for (let m = 1; m < (1 << c.length); m++) {
      let v = 0; const pick = [];
      c.forEach((x, i) => { if (m & (1 << i)) { v += x.v; pick.push(x); } });
      if (pick.length >= 2 && v === target) return pick;
    }
    return null;
  };
  mf.filter(x => !x.used).forEach(x => {
    const g = subset(miss.filter(p => !p.used && near(x, p)), x.v);
    if (g) { x.used = true; g.forEach(p => { p.used = true; }); }
  });
  miss.filter(p => !p.used).forEach(p => {
    const g = subset(mf.filter(x => !x.used && near(x, p)), p.v);
    if (g) { p.used = true; g.forEach(x => { x.used = true; }); }
  });
  miss.splice(0, miss.length, ...miss.filter(p => !p.used));
  const extra = mf.filter(x => !x.used);
  const dupNo = {};
  mf.forEach(x => { if (x.no) dupNo[x.d + x.no] = (dupNo[x.d + x.no] || 0) + 1; });
  return months.map(ym => {
    const sq = pays.filter(p => p.date.slice(0, 7) === ym).reduce((a, p) => a + p.v, 0);
    const mfv = mf.filter(x => x.d.slice(0, 7) === ym).reduce((a, x) => a + x.v, 0);
    const causes = [];
    miss.filter(x => x.d.slice(0, 7) === ym).forEach(x => causes.push({ date: x.d, text: x.t + ' の会計 ' + x.v.toLocaleString() + '円が、マネーフォワードにありません' + (x.refunded ? '（一部返金あり）' : '') }));
    extra.filter(x => x.d.slice(0, 7) === ym).forEach(x => causes.push({ date: x.d, text: (x.t ? x.t + ' の' : '') + '売上 ' + x.v.toLocaleString() + '円が、Squareにありません' + (x.no && dupNo[x.d + x.no] > 1 ? '（同じ取引番号が2回＝二重登録かも）' : '（Squareで取り消し・返金したかも）') }));
    causes.sort((a, b) => a.date.localeCompare(b.date));
    // 月の合計が同じなら、ずれは打ち消し合っているだけなので「一致」とする
    if (sq === mfv) causes.length = 0;
    return { ym: ym, sq: sq, mf: mfv, other: other[ym] || 0, diff: causes.slice(0, 30), diffN: causes.length };
  }).filter(x => x.sq || x.mf);
}
// 口座（普通預金）：帳簿の動きと、銀行の明細を1件ずつ照らし合わせる
async function bookBank(env, js, months) {
  const today = jstStamp(Date.now()).slice(0, 10);
  const from = months[0] + '-01';
  const all = [];
  for (let page = 1; page <= 20; page++) {
    const j = await mfApi(env, 'GET', '/transactions', { start_date: from, end_date: today, per_page: 500, page: page });
    all.push(...(j.transactions || []));
    const pages = j.metadata && Number(j.metadata.total_pages);
    if (!pages || page >= pages || !(j.transactions || []).length) break;
  }
  // Squareの明細（お取引）はのぞき、銀行の明細だけにする
  const bank = all.filter(t => !SQ_TX.test(String(t.content || '')) && !/お取引/.test(String(t.content || ''))).map(t => ({ id: String(t.id), d: t.date, v: Number(t.value) || 0, in: t.side === 'INCOME', c: clean(t.content, 40), st: t.journalizing_status || '', used: false }));
  // 1つの仕訳の中で普通預金が何行かに分かれていても、銀行の明細は1回分なので、仕訳ごとに合計して比べる
  const book = [];
  js.forEach(j => {
    let inV = 0, outV = 0;
    j.b.forEach(br => { if (br[0] === '普通預金') inV += br[1]; if (br[2] === '普通預金') outV += br[3]; });
    const net = inV - outV;
    if (net) book.push({ j: j, d: j.d, v: Math.abs(net), in: net > 0, r: bookRemark(j, 0) });
  });
  // まず前後4日で、見つからなければ前後31日で（請求書の売上のように、登録した日と入金の日がずれるもの）
  const only = [];
  const pick = (b, days) => {
    const c = bank.filter(t => !t.used && t.in === b.in && t.v === b.v && Math.abs(diffDays(t.d, b.d)) <= days).sort((x, y) => Math.abs(diffDays(x.d, b.d)) - Math.abs(diffDays(y.d, b.d)));
    if (c.length) { c[0].used = true; return true; }
    return false;
  };
  const rest = book.filter(b => !pick(b, 4));
  rest.forEach(b => { if (!pick(b, 31)) only.push(b); });
  // まとめて入金・出金されたもの（帳簿の2〜4件＝銀行の1件、またはその逆）も合っているとみなす
  const subset = (list, target) => {
    const c = list.slice(0, 10);
    for (let m = 1; m < (1 << c.length); m++) {
      let v = 0, n = 0;
      for (let i = 0; i < c.length; i++) if (m & (1 << i)) { v += c[i].v; n++; }
      if (n >= 2 && n <= 4 && v === target) return c.filter((x, i) => m & (1 << i));
    }
    return null;
  };
  bank.filter(t => !t.used).forEach(t => {
    const g = subset(only.filter(b => !b.done && b.in === t.in && Math.abs(diffDays(t.d, b.d)) <= 40), t.v);
    if (g) { t.used = true; g.forEach(b => { b.done = true; }); }
  });
  only.filter(b => !b.done).forEach(b => {
    const g = subset(bank.filter(t => !t.used && t.in === b.in && Math.abs(diffDays(t.d, b.d)) <= 31), b.v);
    if (g) { b.done = true; g.forEach(t => { t.used = true; }); }
  });
  only.splice(0, only.length, ...only.filter(b => !b.done));
  // 振込手数料を引かれて入金されたもの（銀行の入金＝帳簿－1,000円以内）
  only.forEach(b => {
    if (!b.in) return;
    const c = bank.filter(t => !t.used && t.in && t.v < b.v && b.v - t.v <= 1000 && Math.abs(diffDays(t.d, b.d)) <= 31).sort((x, y) => Math.abs(diffDays(x.d, b.d)) - Math.abs(diffDays(y.d, b.d)));
    if (c.length) { b.fee = { v: b.v - c[0].v, d: c[0].d, net: c[0].v }; c[0].used = true; }
  });
  const sum = list => list.reduce((a, x) => a + (x.in ? x.v : -x.v), 0);
  // 銀行の明細が登録済みの分まで返ってこないとき（半分も合わない）は、照らし合わせない（まちがった知らせを出さない）
  if (book.length >= 4 && only.length > book.length / 2) return { unreliable: true, bankNet: 0, bookNet: sum(book), bookOnly: [], notYet: [], notYetAll: [], po: all.filter(t => /入金\s*po_/.test(String(t.content || ''))).map(t => ({ d: t.date, v: Number(t.value) || 0 })) };
  const hid = await txHidden(env);
  const notYet = bank.filter(t => !t.used && (!t.st || t.st === 'none') && !hid[t.id]);
  return {
    bankNet: sum(bank.filter(t => t.used || !t.st || t.st === 'none')), bookNet: sum(book),
    bookOnly: only.map(b => {
      const twin = book.find(o => o !== b && o.d === b.d && o.v === b.v && o.in === b.in);
      // 相手の科目（入金なら貸方、出金なら借方）と、近い日の銀行の明細（Claudeに相談するとき用）
      const other = []; b.j.b.forEach(br => { const a = b.in ? br[2] : br[0]; if (a && a !== '普通預金' && other.indexOf(a) < 0) other.push(a); });
      const near = bank.filter(t => !t.used && t.in === b.in && Math.abs(diffDays(t.d, b.d)) <= 45).slice(0, 10).map(t => ({ d: t.d, v: t.v, c: t.c }));
      return { id: b.j.i, date: b.d, amount: b.v, in: b.in, remark: b.r, twin: !!twin, other: other, fee: b.fee || null, near: near };
    }),
    notYet: notYet.filter(t => t.in).map(t => ({ date: t.d, amount: t.v, content: t.c })),
    notYetAll: notYet.map(t => ({ date: t.d, amount: t.v, in: t.in })),
    po: all.filter(t => /入金\s*po_/.test(String(t.content || ''))).map(t => ({ d: t.date, v: Number(t.value) || 0 }))
  };
}
// 口座の動きで通帳にないもの：どうしたかの選び方（入金と出金で違う）
function bankOpts(x) {
  const o = [];
  if (x.in) {
    if (x.fee) o.push({ v: 'fee', label: '手数料' + x.fee.v.toLocaleString() + '円を引かれて入金' });
    o.push({ v: '売掛金', label: 'まだ入金されていない' }, { v: '現金', label: '現金で受け取った' }, { v: '事業主貸', label: '個人の口座に入った' });
  } else {
    o.push({ v: '現金', label: '現金で払った' });
    o.push(x.other.indexOf('事業主貸') >= 0 ? { v: 'del', label: '個人のお金で払った（消す）' } : { v: '事業主借', label: '個人のお金で払った' });
  }
  o.push({ v: 'del', label: '二重・まちがいなので消す' });
  return o.filter((a, i) => o.findIndex(b => b.v === a.v) === i);
}
// 知らせだけのもの（今日の画面には出さず、設定＞会計の「締めの確認」に、どうすればよいかを添えて出す）
const NOTE_TODO = {
  ar: 'Squareの入金予定を確かめてください。入金が届いて口座の明細を登録すると消えます',
  arneg: 'Squareの会計の登録漏れかも。経費を登録の「Squareの未入力」から登録できます',
  big: '10万円以上の物は、ふつうは「工具器具備品」。青色申告なら30万円未満は消耗品のままで大丈夫です'
};
async function adminBook(env, b) {
  if (!env.MF_API_KEY) return { connected: false };
  const r = await bookIssues(env, b && b.force);
  const sales = await bookSales(env, r.js, r.months).catch(e => { console.error('売上の照らし合わせ', e && e.message); return []; });
  const bank = await bookBank(env, r.js, r.months).catch(e => { console.error('口座の照らし合わせ', e && e.message); return null; });
  const ign = (await kvGet(env, 'bookIgnore')) || {};
  const asked = (await kvGet(env, 'bookAsk')) || {};
  const issues = r.issues.filter(x => x.kind !== 'info');
  const notes = r.issues.filter(x => x.kind === 'info' && NOTE_TODO[x.key.split(':')[0]]).map(x => Object.assign({}, x, { todo: NOTE_TODO[x.key.split(':')[0]] }));
  const good = bank && !bank.unreliable;
  // Squareの入金：同じ入金が2回（Squareの明細と銀行の明細の両方から）／入金を売上にしている（売上が二重）
  const sq = bookSqDeposit(r.js, bank ? bank.po : []);
  sq.issues.forEach(x => { if (!ign[x.key]) issues.push(x); });
  if (good) {
    bank.bookOnly.forEach(x => { const k = 'bk:' + x.id + ':' + x.amount; if (!ign[k] && !sq.ids[x.id]) issues.push(x.twin
      ? { key: k, kind: 'pair', id: x.id, date: x.date, amount: x.amount, remark: x.remark, title: '二重に登録されているかも', detail: '同じ日・同じ金額の口座の仕訳が2つ', why: '銀行の明細には1回分しかありません', fix: true, dupBank: true }
      : { key: k, kind: 'bank', id: x.id, date: x.date, amount: x.amount, remark: x.remark, in: x.in, title: '銀行の明細にない' + (x.in ? '入金' : '出金'), detail: x.other.join('・'),
        why: x.fee ? jdShort(x.fee.d) + 'に' + x.fee.net.toLocaleString() + '円の入金があります（差' + x.fee.v.toLocaleString() + '円は振込手数料かも）' : '同じ金額の銀行の' + (x.in ? '入金' : '出金') + 'が前後1か月にありません。どうしたか選んでください',
        fix: true, opts: bankOpts(x), near: x.near, other: x.other, fee: x.fee }); });
  }
  issues.forEach(x => { if (x.kind === 'ap') x.opts = [{ v: '現金', label: '現金で払った' }, { v: '普通預金', label: '口座から払った' }]; if (asked[x.key]) x.ask = asked[x.key]; });
  const close = await bookClose(env, r, bank && good ? bank : null, sales);
  const n = issues.length;
  await kvPut(env, 'bookCount', { n: n, at: Date.now() });
  return { connected: true, issues: issues, notes: notes, sales: sales, close: close, bankOk: !!good, sqFlow: await sqFlow(env, r, sq.issues.length),
    balanced: r.balanced, total: r.total, from: r.months[0], aiAt: ((await kvGet(env, 'bookAi')) || {}).at || '', hidden: Object.keys(ign).length };
}
// Squareの売上と入金：売上は会計ごとに「未収金／売上高」で1回だけ。入金は「普通預金＋支払手数料／未収金」でお金が移るだけ。
// 二重になるのは、①同じ入金を Squareの明細と銀行の明細の両方から登録したとき、②銀行の入金を「売上高」で登録したとき
function bookSqDeposit(js, po) {
  const dep = [];
  js.forEach(j => {
    let inV = 0, fromAr = 0, sales = 0, fee = false;
    j.b.forEach(br => { if (br[0] === '普通預金') inV += br[1]; if (br[2] === '未収金') fromAr += br[3]; if (br[0] === '普通預金' && br[2] === '売上高') sales += br[3]; if (br[0] === '支払手数料') fee = true; });
    if (!inV || !(fromAr || sales)) return;
    const text = j.b.map(br => br[4]).join(' ') + ' ' + j.m;
    dep.push({ j: j, d: j.d, v: inV, ar: fromAr > 0, sales: sales > 0 && !fromAr, fee: fee, po: /po_/.test(text), pid: (text.match(/po_[\w-]+/) || [''])[0], word: /ｽｸｴｱ|スクエア|SQUARE|po_/i.test(text), r: bookRemark(j, 0) });
  });
  const near = (a, b) => Math.abs(diffDays(a, b)) <= 4;
  const issues = [], ids = {};
  // ① 同じ金額・前後4日の入金が2つ以上（どちらも未収金から、または片方が売上）。手数料の行やSquareの入金番号があるほうを残す
  dep.forEach(x => {
    if (x.done) return;
    // 入金番号がちがえば、同じ金額でも別の入金
    const g = dep.filter(o => !o.done && o.v === x.v && near(o.d, x.d) && (o.ar || o.word) && (x.ar || x.word) && !(o.pid && x.pid && o.pid !== x.pid));
    if (g.length < 2 || !g.some(o => o.ar)) return;
    g.sort((a, b) => (b.ar * 4 + b.fee * 2 + b.po) - (a.ar * 4 + a.fee * 2 + a.po));
    const keep = g[0];
    g.forEach(o => { o.done = true; ids[o.j.i] = true; });
    g.slice(1).forEach(o => issues.push({ key: 'sqdup:' + o.j.i, kind: 'pair', id: o.j.i, date: o.d, amount: o.v, remark: o.r, title: 'Squareの入金が二重', detail: '同じ入金が' + jdShort(keep.d) + 'にも入っています',
      why: 'Squareの明細と銀行の明細の両方から登録すると、同じお金が2回入ります。' + (keep.fee ? '手数料の行がある' : '') + jdShort(keep.d) + 'の方を残して、こちらを消します', fix: true, sqDup: true }));
  });
  // ② 銀行の入金を売上にしている：Squareの売上は会計ごとに入っているので、売上が二重になる
  dep.filter(x => !x.done && x.sales && (x.word || po.some(p => p.v === x.v && near(p.d, x.d)))).forEach(x => {
    ids[x.j.i] = true;
    issues.push({ key: 'sqsale:' + x.j.i, kind: 'sqsale', id: x.j.i, date: x.d, amount: x.v, remark: x.r, title: 'Squareの入金を売上にしている', detail: '普通預金／売上高',
      why: 'Squareの売上は会計ごとに入っているので、入金も売上にすると売上が二重になります', fix: true,
      opts: [{ v: '未収金', label: '未収金にする（売上の二重をなくす）' }, { v: 'del', label: '消す（同じ入金が別に入っているとき）' }] });
  });
  return { issues: issues, ids: ids };
}
// 月ごとの流れ：カードの売上（未収金に入る）→ 入金（未収金から銀行へ）→ 月末の入金待ち。マイナスなら入金が二重、増え続けるなら入金の登録漏れ
async function sqFlow(env, r, dupN) {
  let open = 0;
  try { const a = await openAuto(env, r.months[0]); if (a && a.ar !== undefined && a.ar !== null) open = a.ar; } catch (e) { /* 0から */ }
  let bal = open;
  const out = r.months.map(ym => {
    let sales = 0, dep = 0, fee = 0;
    r.js.filter(j => j.d.slice(0, 7) === ym).forEach(j => j.b.forEach(br => {
      if (br[0] === '未収金') { sales += br[1]; bal += br[1]; }
      if (br[2] === '未収金') { bal -= br[3]; if (br[0] === '支払手数料') fee += br[3]; else dep += br[3]; }
    }));
    return { ym: ym, sales: sales, dep: dep, fee: fee, left: bal };
  }).filter(m => m.sales || m.dep || m.fee);
  return { months: out, dupN: dupN };
}
// 締めの確認：選んだ日（月末・6月30日・12月31日など）の時点で、現金と口座の残高が、数えた現金・通帳と合っているか
function bookBal(js, acct, open, upto) {
  let v = open, low = null;
  const days = {};
  js.forEach(j => { if (j.d > upto) return; let d = 0; j.b.forEach(br => { if (br[0] === acct) d += br[1]; if (br[2] === acct) d -= br[3]; }); if (d) days[j.d] = (days[j.d] || 0) + d; });
  Object.keys(days).sort().forEach(d => { v += days[d]; if (v < 0 && (low === null || v < low.v)) low = { d: d, v: v }; });
  return { v: v, low: low };
}
function closeDates(from, today) {
  const out = [];
  const lastEnd = addDays(today.slice(0, 7) + '-01', -1);
  if (lastEnd >= from) out.push({ d: lastEnd, label: '先月末' });
  [today.slice(0, 4) + '-06-30', (Number(today.slice(0, 4)) - 1) + '-12-31', (Number(today.slice(0, 4)) - 1) + '-06-30'].forEach(d => { if (d >= from && d <= today && !out.some(x => x.d === d)) out.push({ d: d, label: d.slice(5) === '12-31' ? '12月31日（確定申告）' : '6月30日（半年）' }); });
  return out.sort((a, b) => b.d.localeCompare(a.d));
}
async function bookClose(env, r, bank, sales) {
  const today = jstStamp(Date.now()).slice(0, 10);
  const from = r.months[0] + '-01';
  const saved = (await kvGet(env, 'bookClose')) || {};
  const own = (await kvGet(env, 'bookOpen')) || {};
  const presets = closeDates(from, today);
  const date = saved.date && saved.date >= from && saved.date <= today ? saved.date : presets.length ? presets[0].d : today;
  let auto = null;
  try { auto = await openAuto(env, r.months[0]); } catch (e) { console.error('期首の残高', e && e.message); }
  const has = v => v !== undefined && v !== null;
  const one = (key, acct) => {
    const open = has(own[key]) ? Number(own[key]) : auto && has(auto[key]) ? auto[key] : null;
    const src = has(own[key]) ? 'input' : open !== null ? auto.src : '';
    const bal = open === null ? null : bookBal(r.js, acct, open, date);
    const counted = saved.date === date && has(saved[key]) ? Number(saved[key]) : null;
    return { open: open, openSrc: src, book: bal ? bal.v : null, low: bal ? bal.low : null, counted: counted, diff: bal && counted !== null ? counted - bal.v : null };
  };
  const cash = one('cash', '現金');
  const bk = one('bank', '普通預金');
  // 通帳との差の理由になりそうなもの：銀行にあって帳簿にない（未登録の明細）、帳簿にあって銀行にない（通帳にない動き）
  bk.cands = [];
  if (bank) {
    bank.notYetAll.filter(t => t.date <= date).forEach(t => bk.cands.push({ date: t.date, amount: t.amount, v: t.in ? t.amount : -t.amount, text: '口座の明細で、まだ登録していない' + (t.in ? '入金' : '出金'), kind: 'notyet' }));
    bank.bookOnly.filter(x => x.date <= date && !x.twin).forEach(x => bk.cands.push({ date: x.date, amount: x.amount, v: x.in ? -x.amount : x.amount, text: '帳簿にあって銀行の明細にない' + (x.in ? '入金' : '出金') + '（' + clean(x.remark || '摘要なし', 20) + '）', kind: 'bookonly' }));
  }
  bk.candSum = bk.cands.reduce((a, x) => a + x.v, 0);
  // 未収金（Squareの入金待ち）
  const ar = bookBal(r.js, '未収金', auto && has(auto.ar) ? auto.ar : 0, date).v;
  const js = await bookJournals(env, [date.slice(0, 7)], false);
  const done = k => js.some(j => j.d === date && j.b.some(br => k.test(br[4] || '')));
  return { date: date, from: from, presets: presets, monthEnd: monthLast(date.slice(0, 7)) === date, yearEnd: /-12-31$/.test(date), cash: cash, bank: bk, bankOk: !!bank, ar: ar,
    salesDiff: sales.filter(m => m.ym <= date.slice(0, 7) && m.diffN).length,
    adjusted: { cash: done(/現金の帳尻合わせ/), bank: done(/口座の帳尻合わせ/) } };
}
// 1月1日の残高＝前年からの繰り越し。マネーフォワードの残高試算表の「前期残高」を使う。取れないときは、前年までの仕訳を足して出す
async function openAuto(env, firstMonth) {
  const hit = await kvGet(env, 'openAuto');
  if (hit && hit.month === firstMonth && Date.now() - hit.t < 21600000) return hit.src ? hit : null;
  let out = null;
  try {
    const tb = await mfApi(env, 'GET', '/reports/trial_balance_bs', { start_date: firstMonth + '-01', end_date: monthLast(firstMonth) });
    const c = tbOpening(tb, '現金', firstMonth + '-01'), k = tbOpening(tb, '普通預金', firstMonth + '-01');
    if (c !== null || k !== null) out = { cash: c, bank: k, ar: tbOpening(tb, '未収金', firstMonth + '-01'), src: 'mf' };
  } catch (e) { console.error('残高試算表', e && e.message); }
  if (!out) {
    const m = await mfMaster(env);
    const first = (m.firstStart || '').slice(0, 7);
    if (first && first < firstMonth && monthsBetween(first, addMonths(firstMonth, -1)).length <= 36) {
      const js = await bookJournals(env, monthsBetween(first, addMonths(firstMonth, -1)), false);
      const end = addDays(firstMonth + '-01', -1);
      out = { cash: bookBal(js, '現金', 0, end).v, bank: bookBal(js, '普通預金', 0, end).v, ar: bookBal(js, '未収金', 0, end).v, src: 'books' };
    }
  }
  const rec = Object.assign({ month: firstMonth, t: Date.now(), src: '' }, out || {});
  await kvPut(env, 'openAuto', rec);
  return out ? rec : null;
}
// 残高試算表（科目の木）から、科目の「前期残高」を探す
function tbOpening(tb, name, start) {
  if (!tb || typeof tb !== 'object') return null;
  if (tb.start_date && String(tb.start_date).slice(0, 10) !== start) return null;
  const cols = (tb.columns || []).map(c => (typeof c === 'string' ? c : (c && (c.key || c.name || c.type)) || ''));
  let hit = null;
  const walk = n => {
    if (hit || !n || typeof n !== 'object') return;
    if (Array.isArray(n)) { n.forEach(walk); return; }
    if (n.name === name || n.account_name === name) { hit = n; return; }
    Object.keys(n).forEach(k => { if (n[k] && typeof n[k] === 'object') walk(n[k]); });
  };
  walk(tb.rows);
  if (!hit) return null;
  let v = hit.opening_balance;
  if (v === undefined && Array.isArray(hit.values) && cols.indexOf('opening_balance') >= 0) v = hit.values[cols.indexOf('opening_balance')];
  if (v && typeof v === 'object') v = v.value !== undefined ? v.value : v.amount;
  if (v === undefined || v === null || v === '' || !isFinite(Number(v))) return null;
  return Math.round(Number(v));
}
// 締めの日・数えた現金・通帳の残高・1月1日の額（自分で入れたとき）を覚える
async function adminBookClose(env, b) {
  const today = jstStamp(Date.now()).slice(0, 10);
  const from = bookMonths(today)[0] + '-01';
  const n = v => (v === '' || v === null || v === undefined ? null : Math.round(Number(String(v).replace(/[^\d-]/g, '')) || 0));
  const cur = (await kvGet(env, 'bookClose')) || {};
  if (b.date !== undefined) {
    const d = String(b.date);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d) || d > today || d < from) fail('締めの日は、' + jdShort(from) + 'から今日までの日にしてください。');
    if (d !== cur.date) { cur.date = d; delete cur.cash; delete cur.bank; }
  }
  if (b.cash !== undefined) cur.cash = n(b.cash);
  if (b.bank !== undefined) cur.bank = n(b.bank);
  await kvPut(env, 'bookClose', cur);
  if (b.open !== undefined) {
    const o = (await kvGet(env, 'bookOpen')) || {};
    Object.keys(b.open || {}).forEach(k => { if (k === 'cash' || k === 'bank') o[k] = n(b.open[k]); });
    await kvPut(env, 'bookOpen', o);
  }
  return await adminBook(env, {});
}
// 締めの帳尻合わせ：月末の時点で、数えた現金（通帳の残高）と帳簿の差を仕訳でうめる（雑損失・雑収入、または事業主貸・事業主借）
// まちがって押さないように、選んだ科目と、差の金額を打ってもらったときだけ。同じ日に2回は入れない。口座は、差の理由になりそうなものを直してから
async function adminBookAdjust(env, b) {
  const r = await adminBook(env, {});
  const C = r.close;
  const acct = b.acct === 'bank' ? 'bank' : 'cash';
  const X = C[acct];
  const label = acct === 'bank' ? '口座' : '現金';
  if (X.book === null || X.counted === null) fail(acct === 'bank' ? '銀行の残高を入れてから押してください。' : '数えた現金を入れてから押してください。');
  if (!C.monthEnd) fail('帳尻合わせは、月末の日（6月30日・12月31日など）を締めの日にしたときだけできます。');
  const d = X.diff;
  if (!d) fail('差はありません。');
  if (acct === 'bank' && X.cands.length) fail('先に、差の理由になりそうなもの' + X.cands.length + '件を直してください。');
  if (b.how !== 'misc' && b.how !== 'owner') fail('どちらで合わせるか選んでください。');
  if (Number(String(b.amount === undefined ? '' : b.amount).replace(/[^\d]/g, '') || -1) !== Math.abs(d)) fail('入れた金額が差（' + Math.abs(d).toLocaleString() + '円）と合いません。');
  if (C.adjusted[acct]) fail(jdShort(C.date) + 'の' + label + 'の帳尻合わせは、もう登録してあります。直すときはマネーフォワードで直してください。');
  const m = await mfMaster(env);
  const owner = b.how === 'owner';
  const name = d < 0 ? (owner ? '事業主貸' : '雑損失') : (owner ? '事業主借' : '雑収入');
  const a = m.accounts.find(x => x.name === name);
  const self = m.accounts.find(x => x.name === (acct === 'bank' ? '普通預金' : '現金'));
  if (!a || !self) fail('マネーフォワードに「' + (a ? (acct === 'bank' ? '普通預金' : '現金') : name) + '」の科目が見つかりませんでした。');
  const v = Math.abs(d);
  const deb = d < 0 ? { account_id: a.id, value: v } : { account_id: self.id, value: v };
  const cre = d < 0 ? { account_id: self.id, value: v } : { account_id: a.id, value: v };
  const t = pickTax(m.taxes, 'none');
  if (t) { deb.tax_id = t; cre.tax_id = t; }
  await mfApi(env, 'POST', '/journals', null, { journal: { transaction_date: C.date, journal_type: 'journal_entry', memo: 'épiiの予約管理から登録', branches: [{ debitor: deb, creditor: cre, remark: label + 'の帳尻合わせ（' + (acct === 'bank' ? '銀行の残高' : '数えた現金') + 'との差）' }] } });
  await mfTouched(env, C.date);
  return await adminBook(env, {});
}
// 直す（店主が押したときだけ）：マネーフォワードの仕訳を書き換える／消す
async function adminBookFix(env, b) {
  const id = String(b.id || '');
  if (!id) fail('仕訳が見つかりません。');
  const m = await mfMaster(env);
  const byName = n => m.accounts.find(a => a.name === n);
  const pickSd = sd => { if (!sd) return sd; const o = { account_id: sd.account_id, value: (Number(sd.value) || 0) + (Number(sd.tax_value) || 0) }; if (sd.sub_account_id) o.sub_account_id = sd.sub_account_id; if (sd.tax_id) o.tax_id = sd.tax_id; if (sd.invoice_kind && sd.invoice_kind !== 'INVOICE_KIND_NOT_TARGET') o.invoice_kind = sd.invoice_kind; return o; };
  if (b.kind === 'sqsale' && b.to !== 'del') {
    // 銀行の入金を売上にしているもの：貸方の売上高を未収金に
    const g = await mfApi(env, 'GET', '/journals/' + encodeURIComponent(id));
    const jr = g.journal || {};
    const sales = byName('売上高'), ar = byName('未収金');
    if (!jr.branches || !sales || !ar) fail('仕訳が見つかりません。マネーフォワードで変わったかもしれません。画面を更新してください。');
    const none = pickTax(m.taxes, 'none');
    const branches = jr.branches.map(br => {
      const nb = { debitor: pickSd(br.debitor), creditor: pickSd(br.creditor), remark: br.remark || '' };
      if (nb.creditor && nb.creditor.account_id === sales.id) { nb.creditor = Object.assign({}, nb.creditor, { account_id: ar.id }); delete nb.creditor.sub_account_id; if (none) nb.creditor.tax_id = none; else delete nb.creditor.tax_id; }
      return nb;
    });
    await mfApi(env, 'PUT', '/journals/' + encodeURIComponent(id), null, { journal: { transaction_date: jr.transaction_date, journal_type: jr.journal_type || 'journal_entry', memo: jr.memo || '', branches: branches } });
  } else if (b.kind === 'pair' || ((b.kind === 'bank' || b.kind === 'sqsale') && b.to === 'del')) {
    await mfApi(env, 'DELETE', '/journals/' + encodeURIComponent(id));
  } else if (b.kind === 'bank') {
    // 通帳にない口座の動き：普通預金を、選んだ科目に置きかえる（手数料を引かれた入金なら、支払手数料の行を足す）
    const g = await mfApi(env, 'GET', '/journals/' + encodeURIComponent(id));
    const jr = g.journal || {};
    const bankAcc = byName('普通預金');
    if (!jr.branches || !jr.branches.length || !bankAcc) fail('仕訳が見つかりません。マネーフォワードで変わったかもしれません。画面を更新してください。');
    let branches = jr.branches.map(br => ({ debitor: pickSd(br.debitor), creditor: pickSd(br.creditor), remark: br.remark || '' }));
    const isBank = sd => sd && sd.account_id === bankAcc.id;
    const inV = branches.reduce((a, br) => a + (isBank(br.debitor) ? br.debitor.value : 0), 0), outV = branches.reduce((a, br) => a + (isBank(br.creditor) ? br.creditor.value : 0), 0);
    const side = inV >= outV ? 'debitor' : 'creditor';
    if (b.to === 'fee') {
      const fee = Math.round(Number(b.fee) || 0);
      const feeAcc = byName('支払手数料');
      const i = branches.findIndex(br => isBank(br.debitor) && br.debitor.value > fee);
      if (!feeAcc) fail('マネーフォワードに「支払手数料」の科目が見つかりませんでした。');
      if (!(fee > 0 && fee <= 1000) || i < 0) fail('手数料の金額が合いません。画面を更新してください。');
      const br = branches[i];
      br.debitor.value -= fee;
      const cr = Object.assign({}, br.creditor, { value: fee });
      if (br.creditor) br.creditor.value -= fee;
      const fd = { account_id: feeAcc.id, value: fee };
      const t10 = pickTax(m.taxes, '10'); if (t10) fd.tax_id = t10;
      branches.splice(i + 1, 0, { debitor: fd, creditor: cr, remark: '振込手数料（' + (br.remark || '入金') + '）' });
    } else {
      const to = byName(String(b.to || ''));
      if (!to) fail('どうしたかを選んでください。');
      const none = pickTax(m.taxes, 'none');
      branches.forEach(br => { if (isBank(br[side])) { br[side] = Object.assign({}, br[side], { account_id: to.id }); delete br[side].sub_account_id; if (none) br[side].tax_id = none; else delete br[side].tax_id; } });
    }
    // 事業主貸／事業主借だけになったら、意味がないので消す
    const nm = sd => { const a = sd && m.accounts.find(x => x.id === sd.account_id); return a ? a.name : ''; };
    if (branches.every(br => /^事業主(貸|借)$/.test(nm(br.debitor)) && /^事業主(貸|借)$/.test(nm(br.creditor)))) await mfApi(env, 'DELETE', '/journals/' + encodeURIComponent(id));
    else await mfApi(env, 'PUT', '/journals/' + encodeURIComponent(id), null, { journal: { transaction_date: jr.transaction_date, journal_type: jr.journal_type || 'journal_entry', memo: jr.memo || '', branches: branches } });
  } else {
    const g = await mfApi(env, 'GET', '/journals/' + encodeURIComponent(id));
    const jr = g.journal || {};
    const bi = Number(b.bi) || 0;
    if (!jr.branches || !jr.branches[bi]) fail('仕訳が見つかりません。マネーフォワードで変わったかもしれません。画面を更新してください。');
    const to = byName(String(b.to || ''));
    if (!to) fail('科目を選んでください。');
    const side = b.kind === 'ap' || b.kind === 'vs' ? 'creditor' : 'debitor';
    const branches = jr.branches.map((br, i) => {
      const nb = { debitor: pickSd(br.debitor), creditor: pickSd(br.creditor), remark: br.remark || '' };
      if (i === bi) {
        nb[side] = Object.assign({}, nb[side], { account_id: to.id });
        delete nb[side].sub_account_id;
        // 自分のために使ったお金・現金・預金は消費税なし
        if (to.name === '事業主貸' || to.group === 'ASSET' || to.group === 'LIABILITY') { const t = pickTax(m.taxes, 'none'); if (t) nb[side].tax_id = t; else delete nb[side].tax_id; }
      }
      return nb;
    });
    await mfApi(env, 'PUT', '/journals/' + encodeURIComponent(id), null, { journal: { transaction_date: jr.transaction_date, journal_type: jr.journal_type || 'journal_entry', memo: jr.memo || '', branches: branches } });
  }
  const d = String(b.date || '');
  if (d) await mfTouched(env, d);
  return await adminBook(env, {});
}
async function adminBookIgnore(env, b) {
  if (b.reset) { await env.DB.prepare("DELETE FROM kv WHERE k = 'bookIgnore'").run(); return await adminBook(env, {}); }
  const ign = (await kvGet(env, 'bookIgnore')) || {};
  ign[String(b.key || '').slice(0, 120)] = jstStamp(Date.now());
  await kvPut(env, 'bookIgnore', ign);
  return await adminBook(env, {});
}
// 1件ずつ Claude に相談：選べる直し方の中から、根拠つきで1つすすめてもらう（根拠がなければ、何を確かめればよいか）
const BOOK_ASK_SYSTEM = [
  'あなたは、小さな飲食店（薬膳レストラン）の帳簿を手伝っています。店主は会計に詳しくありません。',
  '帳簿の気になる仕訳1件について、渡した「選べる直し方」から、いちばん合うものを1つ選びます。',
  '- 店主の説明（何に使ったか・どんなときに買ったか）があれば、それをいちばんの根拠にして、勘定科目の一覧の説明と照らして最適な科目を選ぶ（例：お店で着る服・エプロン → 消耗品費、自分の普段着 → 事業主貸）。説明と今の科目が合っていれば keep。',
  '- ほかに根拠にしてよいもの：近い日の銀行の明細の金額・日付／同じ摘要の前の仕訳／摘要の言葉。',
  '- 根拠がはっきりしないときは choice を空にし、why に、店主が何を確かめればよいかを書く（例「6/10の銀行の明細に10,480円の入金がないか見てください」）。',
  '- choice は、選べる直し方の記号（｜の左）をそのまま返す。',
  '- why：50文字以内。店主の説明があれば、なぜその科目かを説明に結びつけて書く。なければ日付と金額を入れて具体的に。推測を事実のように書かない。'
].join('\n');
async function adminBookAsk(env, b) {
  const r = await adminBook(env, {});
  const x = r.issues.find(i => i.key === b.key);
  if (!x) fail('この知らせは、もうありません。画面を更新してください。');
  // 選べる直し方（直すところの種類ごと）。どれも「このままでいい」を選べる
  let opts = x.opts;
  const note = clean(b.note || '', 200);
  // 科目を選ぶもの（中身が空・科目のまちがい・返金）は、科目の一覧から何でも選べる（説明つき）
  let accts = '';
  if (!opts && (x.kind === 'same' || x.kind === 'acct' || x.kind === 'vs')) {
    const m = await mfMaster(env);
    const list = txOptions(m, await expenseOptions(env, m));
    accts = accountList(list);
    opts = list.map(a => ({ v: a.name, label: a.name + 'にする' }));
    if (x.from || x.detail) opts = opts.filter(o => o.v !== x.from);
  }
  if (!opts && x.kind === 'pair') opts = [{ v: 'del', label: '消す' }];
  if (!opts && x.to) opts = [{ v: x.to, label: x.to + 'にする' }];
  opts = (opts || []).concat([{ v: 'keep', label: 'このままでいい' }]);
  const today = jstStamp(Date.now()).slice(0, 10);
  const js = await bookJournals(env, bookMonths(today), false);
  const k = txKey(x.remark || '');
  const hist = k ? js.filter(j => j.i !== x.id && txKey(bookRemark(j, 0)) === k).slice(-5).map(j => j.d + ' ' + j.b.map(br => (br[0] || '') + '／' + (br[2] || '') + ' ¥' + (br[1] || br[3])).join('、')) : [];
  const lines = [
    '仕訳：' + x.date + '　' + (x.kind === 'bank' ? (x.in ? '口座への入金' : '口座からの出金') : x.title) + '　¥' + x.amount + '　摘要「' + maskRemark(x.remark || 'なし') + '」' + (x.other ? '　相手の科目：' + x.other.join('・') : ''),
    '気になる点：' + x.title + '。' + (x.why || ''),
    x.kind === 'bank' ? '近い日の、まだ帳簿と結びついていない銀行の明細（同じ向き）：' + ((x.near || []).map(t => t.d + ' ¥' + t.v + ' ' + maskRemark(t.c)).join('／') || 'なし') : '',
    x.fee ? '手数料の候補：' + x.fee.d + 'に ¥' + x.fee.net + ' の入金（差 ¥' + x.fee.v + '）' : '',
    '同じ摘要の前の仕訳：' + (hist.join('／') || 'なし'),
    accts ? '勘定科目の一覧（説明つき）：' + accts : '',
    note ? '店主の説明：' + noPrivate(note, 200) : '',
    '選べる直し方：\n' + opts.map(o => o.v + '｜' + o.label).join('\n')
  ].filter(Boolean);
  const out = await claude(env, { system: BOOK_ASK_SYSTEM, effort: 'medium', maxTokens: 4000, timeout: 90000, content: [{ type: 'text', text: lines.join('\n') }],
    schema: strSchema({ choice: { type: 'string' }, why: { type: 'string' } }) });
  const hit = opts.find(o => o.v === out.choice);
  const asked = (await kvGet(env, 'bookAsk')) || {};
  asked[x.key] = { to: hit ? hit.v : '', label: hit ? hit.label : '', why: plain(clean(out.why || '', 80)), note: note, at: jstStamp(Date.now()) };
  await kvPut(env, 'bookAsk', asked);
  return await adminBook(env, {});
}
// Claude に、経費の科目がおかしいものがないか見てもらう（押したときだけ。結果はとっておく）
const BOOK_SYSTEM = [
  'あなたは、小さな飲食店（薬膳レストラン）の帳簿を確定申告の前に見直す手伝いをしています。店主は会計に詳しくありません。',
  '経費の仕訳の一覧（摘要・科目・金額と、同じ相手を前にどの科目で登録したか）から、科目がまちがっていそうなものだけを選びます。',
  '- 根拠がはっきりしたものだけ。推測で科目を当てはめない。迷ったら選ばない。少なくてよい。',
  '- 根拠にしてよいもの：摘要のお店や会社の名前からはっきり分かる中身／同じ相手をいつも別の科目で登録している／金額と番号がほかの仕訳と一致する。',
  '- 「V」で始まる番号（デビットカード）や「サガク」（差額）は、番号が同じ元の支払いと同じ科目にする。元の支払いが一覧にないときは選ばない。',
  '- id と bi は、渡したものをそのまま返す。from は今の科目、to は直したほうがよい科目（必ず渡した一覧の中から）。',
  '- title：何がおかしいかを、ごく短く（15文字以内）。例「食材なので仕入高」。',
  '- why：根拠を具体的に（40文字以内）。例「アベノセイカは青果店。前の5件も仕入高」。'
].join('\n');
async function adminBookAi(env) {
  const today = jstStamp(Date.now()).slice(0, 10);
  const js = await bookJournals(env, bookMonths(today), false);
  const m = await mfMaster(env);
  const opts = txOptions(m, await expenseOptions(env, m));
  const lines = [];
  const hist = {};
  js.forEach(j => j.b.forEach(br => { if (br[0] && br[4]) { const k = txKey(br[4]); hist[k] = hist[k] || {}; hist[k][br[0]] = (hist[k][br[0]] || 0) + 1; } }));
  js.forEach(j => j.b.forEach((br, bi) => {
    if (!br[0] || !(BOOK_EXPENSE.test(br[0]) || br[0] === '事業主貸') || lines.length >= 400) return;
    const h = hist[txKey(bookRemark(j, bi))] || {};
    lines.push(j.i + '｜' + bi + '｜' + j.d + '｜' + br[0] + '｜' + maskRemark(bookRemark(j, bi)) + '｜¥' + br[1] + '｜' + (Object.keys(h).map(a => a + '×' + h[a]).join('・') || 'なし'));
  }));
  if (!lines.length) return await adminBook(env, {});
  const out = await claude(env, { system: BOOK_SYSTEM, effort: 'medium', maxTokens: 16000, timeout: 180000,
    content: [{ type: 'text', text: '勘定科目の一覧：' + accountList(opts) + '\n\n経費の仕訳（id｜bi｜日付｜科目｜摘要｜金額｜同じ相手を前に登録した科目×件数）：\n' + lines.join('\n') }],
    schema: strSchema({ items: { type: 'array', items: strSchema({ id: { type: 'string' }, bi: { type: 'integer' }, from: { type: 'string' }, to: { type: 'string' }, title: { type: 'string' }, why: { type: 'string' } }) } }) });
  const items = (out.items || []).filter(x => opts.some(a => a.name === x.to) && x.to !== x.from && String(x.why || '').trim()).slice(0, 40)
    .map(x => ({ id: String(x.id), bi: Number(x.bi) || 0, from: String(x.from), to: String(x.to), title: plain(clean(x.title || '科目がちがうかも', 30)), why: plain(clean(x.why, 60)) }));
  await kvPut(env, 'bookAi', { at: jstStamp(Date.now()), items: items });
  return await adminBook(env, {});
}

/* ---------- (7) Squareの「未入力」の明細を、ここから登録する ----------
 * マネーフォワードのSquare連携で届いて、まだ仕訳していない明細（会計・入金）を、Squareのデータと1件ずつ結びつけて登録する。
 * 免税事業者なので、売上は税率で分けず合計の金額だけ。今までの「入力済み」と同じ形：
 *   現金の会計：現金／売上高　カード・QRの会計：未収金／売上高　入金：普通預金＋支払手数料／未収金 */
const SQ_TX = /お取引\s*No\.|入金\s*po_/;
async function sqGet(env, path) {
  let res;
  try { res = await fetch(sqBase(env) + path, { headers: { authorization: 'Bearer ' + env.SQUARE_ACCESS_TOKEN, 'square-version': SQ_VERSION, accept: 'application/json' } }); }
  catch (e) { fail('Squareにつながりませんでした（通信エラー）。', 502, 'SQ_NET'); }
  let j = {};
  try { j = await res.json(); } catch (e) { /* 何もしない */ }
  if (!res.ok) fail('Squareの入金の記録を読めませんでした（' + (res.status === 403 ? 'トークンに入金を読む権限がありません' : 'エラーコード ' + res.status) + '）。', 502, 'SQ_ERROR');
  return j;
}
// 入金（payout）の手数料：入金額＝売上の合計－手数料（一度読んだら手元に置く）
async function sqPayout(env, id) {
  const k = 'sqpo:' + id;
  const hit = await kvGet(env, k);
  if (hit) return hit;
  const po = (await sqGet(env, '/v2/payouts/' + encodeURIComponent(id))).payout || {};
  const net = po.amount_money ? Number(po.amount_money.amount) || 0 : 0;
  let fee = 0, cursor = '';
  for (let page = 0; page < 20; page++) {
    const j = await sqGet(env, '/v2/payouts/' + encodeURIComponent(id) + '/payout-entries?limit=100' + (cursor ? '&cursor=' + encodeURIComponent(cursor) : ''));
    (j.payout_entries || []).forEach(e => { fee += Math.abs(e.fee_amount_money ? Number(e.fee_amount_money.amount) || 0 : 0); });
    cursor = j.cursor || '';
    if (!cursor) break;
  }
  const v = { net: net, fee: fee, gross: net + fee };
  await kvPut(env, k, v);
  return v;
}
async function sqUnentered(env) {
  if (!env.MF_API_KEY || !env.SQUARE_ACCESS_TOKEN) return { connected: false, items: [] };
  const today = jstStamp(Date.now()).slice(0, 10);
  const months = bookMonths(today);
  const all = [];
  for (let page = 1; page <= 20; page++) {
    const j = await mfApi(env, 'GET', '/transactions', { start_date: months[0] + '-01', end_date: today, journalizing_statuses: 'none', per_page: 500, page: page });
    all.push(...(j.transactions || []));
    const pages = j.metadata && Number(j.metadata.total_pages);
    if (!pages || page >= pages || !(j.transactions || []).length) break;
  }
  const hidden = await txHidden(env);
  const txs = all.filter(t => SQ_TX.test(String(t.content || '')) && (!t.journalizing_status || t.journalizing_status === 'none') && !hidden[String(t.id)]);
  if (!txs.length) { await kvPut(env, 'sqUnentered', { n: 0, at: Date.now() }); return { connected: true, items: [] }; }
  try { await sqEnsure(env, monthsBetween(txs.map(t => t.date).sort()[0], today), 6 * 3600000); } catch (e) { if (!e.userFacing) throw e; }
  const pays = (await env.DB.prepare("SELECT id, ts, date, amount, refunded, method FROM sq_payments WHERE status = 'COMPLETED' AND date BETWEEN ? AND ?").bind(txs.map(t => t.date).sort()[0], today).all()).results;
  const used = {};
  const items = [];
  for (const t of txs.sort((a, b) => String(a.date).localeCompare(String(b.date)))) {
    const c = String(t.content || '');
    const v = Number(t.value) || 0;
    const it = { id: String(t.id), date: t.date, content: clean(c, 80), amount: v, ok: false, why: '' };
    const po = c.match(/入金\s*(po_[\w-]+)/);
    if (po) {
      it.kind = 'payout';
      it.po = po[1];
      try {
        const p = await sqPayout(env, po[1]);
        Object.assign(it, p);
        if (p.gross === v || p.net === v) it.ok = true; else it.why = 'Squareの入金の金額（' + p.net.toLocaleString() + '円＋手数料' + p.fee.toLocaleString() + '円）と合いません';
      } catch (e) { it.why = e.message; }
    } else {
      const m = c.match(/(\d{4})\/(\d{2})\/(\d{2})\s+(\d{2}):(\d{2})\s*お取引\s*No\.\s*(\S+)/);
      const tm = m ? m[4] + ':' + m[5] : '';
      const no = m ? m[6] : '';
      it.time = tm; it.no = no;
      const cand = pays.filter(p => !used[p.id] && p.date === (m ? m[1] + '-' + m[2] + '-' + m[3] : t.date) && (p.amount === v || p.amount - p.refunded === v) && (!tm || Math.abs(toMin(p.ts.slice(11, 16)) - toMin(tm)) <= 3));
      const hit = cand.find(p => no && p.id.slice(0, no.length) === no) || (cand.length === 1 ? cand[0] : cand[0]);
      if (hit) { used[hit.id] = 1; it.kind = hit.method === '現金' ? 'cash' : 'card'; it.method = hit.method || ''; it.ok = true; }
      else { it.kind = 'sale'; it.why = 'Squareに同じ時刻・金額の会計が見つかりません（現金かカードか分からないので、マネーフォワードで登録してください）'; }
    }
    items.push(it);
  }
  await kvPut(env, 'sqUnentered', { n: items.length, at: Date.now() });
  return { connected: true, items: items };
}
async function adminSqUnentered(env) { return Object.assign(await sqUnentered(env), { tried: !!(await kvGet(env, 'sqEnterTried')) }); }
async function adminSqEnter(env, b) {
  const m = await mfMaster(env);
  const acc = n => { const a = m.accounts.find(x => x.name === n); if (!a) fail('マネーフォワードに「' + n + '」の科目が見つかりませんでした。'); return a.id; };
  const ids = Array.isArray(b.ids) ? b.ids.map(String) : null;
  const cur = await sqUnentered(env);
  const todo = cur.items.filter(x => x.ok && (!ids || ids.indexOf(x.id) >= 0));
  if (!todo.length) fail('登録できる明細がありません。');
  // 書き込む前に、使う科目がそろっているか確かめる（途中で止まって半端な仕訳が残らないように）
  ['売上高', '未収金'].concat(todo.some(x => x.kind === 'cash') ? ['現金'] : []).concat(todo.some(x => x.kind === 'payout') ? ['普通預金', '支払手数料'] : []).forEach(acc);
  const done = [], failed = [], months = {};
  for (const x of todo) {
    try {
      const r = await mfApi(env, 'POST', '/transactions/journalize', null, { transaction_id: x.id, account_id: x.kind === 'payout' ? acc('普通預金') : acc('売上高'), remark: x.content });
      let jid = (r.journal && r.journal.id) || r.journal_id || (r.journals && r.journals[0] && r.journals[0].id) || '';
      if (!jid) {
        const j = await mfApi(env, 'GET', '/journals', { start_date: x.date, end_date: x.date, transaction_ids: x.id });
        const hit = (j.journals || []).find(o => o.transaction_id === x.id);
        jid = hit ? hit.id : '';
      }
      if (!jid) throw new Error('登録した仕訳が見つかりませんでした');
      const g = await mfApi(env, 'GET', '/journals/' + encodeURIComponent(jid));
      const jr = g.journal || {};
      const br = (d, dv, c, cv, rm) => ({ debitor: { account_id: d, value: dv }, creditor: { account_id: c, value: cv }, remark: rm });
      let branches;
      if (x.kind === 'payout') {
        branches = [br(acc('普通預金'), x.net, acc('未収金'), x.net, x.content)];
        if (x.fee > 0) branches.push(br(acc('支払手数料'), x.fee, acc('未収金'), x.fee, '手数料'));
      } else {
        branches = [br(acc(x.kind === 'cash' ? '現金' : '未収金'), x.amount, acc('売上高'), x.amount, x.content + (x.method ? ' ' + x.method : ''))];
      }
      await mfApi(env, 'PUT', '/journals/' + encodeURIComponent(jid), null, { journal: { transaction_date: jr.transaction_date || x.date, journal_type: jr.journal_type || 'journal_entry', memo: jr.memo || '', branches: branches } });
      done.push(x.id);
      months[String(x.date).slice(0, 7)] = 1;
    } catch (e) { failed.push({ id: x.id, message: e.message }); }
  }
  for (const ym of Object.keys(months)) await mfTouched(env, ym + '-01');
  if (done.length) await kvPut(env, 'sqEnterTried', { at: jstStamp(Date.now()) });
  return { done: done, failed: failed, list: Object.assign(await sqUnentered(env), { tried: !!done.length || !!(await kvGet(env, 'sqEnterTried')) }) };
}

/* ---------- (8) Googleビジネスプロフィール（Googleマップ・検索での見られ方と口コミ） ----------
 * 店主が管理画面の「Googleとつなぐ」で一度ログインすると、読み取り用の鍵（リフレッシュトークン）を手元に置き、あとは自動で読む。
 * クライアントIDとシークレットは Cloudflare のシークレット（GOOGLE_CLIENT_ID・GOOGLE_CLIENT_SECRET）。読むだけで、書き込みはしない */
const G_SCOPE = 'https://www.googleapis.com/auth/business.manage';
function gUrl(env, host, path) { return (env.GOOGLE_API_BASE ? env.GOOGLE_API_BASE + '/' + host : 'https://' + host) + path; }
function gOn(env) { return !!(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET); }
// つなぐボタン：Googleのログイン画面のURL（state は署名つきで10分だけ使える）
async function adminGoogleStart(env, b) {
  if (!gOn(env)) fail('GoogleのクライアントIDとシークレットが、Cloudflareに登録されていません。');
  const origin = String(b.origin || '');
  if (!/^https:\/\/[a-z0-9.-]+(:\d+)?$/i.test(origin) && !/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(origin)) fail('画面のURLが読み取れませんでした。');
  const nonce = crypto.randomUUID();
  await kvPut(env, 'gState', { n: nonce, origin: origin, at: Date.now() });
  const state = await signToken(env, { k: 'g', n: nonce, e: Date.now() + 600000 });
  const q = new URLSearchParams({ client_id: env.GOOGLE_CLIENT_ID, redirect_uri: origin + '/admin/google/callback', response_type: 'code', scope: G_SCOPE, access_type: 'offline', prompt: 'consent', include_granted_scopes: 'true', state: state });
  return { url: (env.GOOGLE_AUTH_BASE || 'https://accounts.google.com') + '/o/oauth2/v2/auth?' + q.toString() };
}
// Googleから戻ってきたところ：鍵を受け取って保存し、管理画面に戻る
async function googleCallback(url, env) {
  const page = (msg, ok) => new Response('<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Google</title><body style="font-family:sans-serif;padding:24px;line-height:1.7">' +
    String(msg).replace(/[<>&]/g, '') + '<p><a href="/admin#google">管理画面に戻る</a></p>' + (ok ? '<script>location.replace("/admin#google")</script>' : '') + '</body>', { status: ok ? 200 : 400, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } });
  if (!gOn(env)) return page('GoogleのクライアントIDとシークレットが、Cloudflareに登録されていません。');
  if (url.searchParams.get('error')) return page('Googleとつなぐのをやめました（' + url.searchParams.get('error') + '）。');
  const st = await verifyToken(env, url.searchParams.get('state') || '');
  const saved = await kvGet(env, 'gState');
  if (!st || st.k !== 'g' || !saved || saved.n !== st.n) return page('時間がたったか、別の画面から開かれました。管理画面の「Googleとつなぐ」から、もう一度お試しください。');
  await env.DB.prepare("DELETE FROM kv WHERE k = 'gState'").run();
  const res = await fetch((env.GOOGLE_TOKEN_URL || 'https://oauth2.googleapis.com/token'), { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ code: url.searchParams.get('code') || '', client_id: env.GOOGLE_CLIENT_ID, client_secret: env.GOOGLE_CLIENT_SECRET, redirect_uri: url.origin + '/admin/google/callback', grant_type: 'authorization_code' }).toString() });
  const j = await res.json().catch(() => ({}));
  if (!res.ok || !j.refresh_token) { console.error('Google token', res.status, JSON.stringify(j).slice(0, 200)); return page('Googleから鍵を受け取れませんでした（' + (j.error_description || j.error || res.status) + '）。もう一度お試しください。'); }
  await kvPut(env, 'google', { refresh: j.refresh_token, at: jstStamp(Date.now()) });
  await kvPut(env, 'gTok', { t: j.access_token, exp: Date.now() + (Number(j.expires_in) || 3600) * 1000 - 60000 });
  await env.DB.prepare("DELETE FROM kv WHERE k = 'gData'").run();
  return page('Googleとつながりました。', true);
}
async function gToken(env) {
  const tok = await kvGet(env, 'gTok');
  if (tok && tok.exp > Date.now()) return tok.t;
  const g = await kvGet(env, 'google');
  if (!g || !g.refresh) fail('Googleとつながっていません。', 400, 'G_NONE');
  const res = await fetch((env.GOOGLE_TOKEN_URL || 'https://oauth2.googleapis.com/token'), { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ refresh_token: g.refresh, client_id: env.GOOGLE_CLIENT_ID, client_secret: env.GOOGLE_CLIENT_SECRET, grant_type: 'refresh_token' }).toString() });
  const j = await res.json().catch(() => ({}));
  if (!res.ok || !j.access_token) {
    // 鍵が無効、またはクライアントを作り直した（別のプロジェクトに移した）ときは、つなぎ直してもらう
    if (/^(invalid_grant|invalid_client|unauthorized_client)$/.test(j.error || '')) { await env.DB.prepare("DELETE FROM kv WHERE k = 'google'").run(); fail('Googleとのつながりが切れました。「Googleとつなぐ」から、もう一度つないでください。', 400, 'G_NONE'); }
    fail('Googleにつながりませんでした（' + (j.error || res.status) + '）。', 502, 'G_ERROR');
  }
  await kvPut(env, 'gTok', { t: j.access_token, exp: Date.now() + (Number(j.expires_in) || 3600) * 1000 - 60000 });
  return j.access_token;
}
async function gApi(env, host, path) {
  let res;
  try { res = await fetch(gUrl(env, host, path), { headers: { authorization: 'Bearer ' + await gToken(env), accept: 'application/json' } }); }
  catch (e) { if (e && e.userFacing) throw e; fail('Googleにつながりませんでした（通信エラー）。', 502, 'G_NET'); }
  const j = await res.json().catch(() => ({}));
  if (!res.ok) {
    console.error('Google API', host, path.slice(0, 80), res.status, JSON.stringify(j).slice(0, 200));
    const msg = (j.error && j.error.message) || '';
    // 申請の承認が反映される前は、上限が0なので最初の1回から429になる
    fail(res.status === 429 ? (/per minute|quota/i.test(msg) ? 'Googleとはつながりましたが、データを読む上限がまだ0のようです（申請の承認が、このプロジェクトにまだ反映されていません）。反映されると、ここに出ます。' : 'Googleの利用回数の上限です。少し待ってからお試しください。')
      : /quota|has not been used|disabled/i.test(msg) ? 'GoogleのAPIがまだ使えません（' + clean(msg, 80) + '）'
      : 'Googleでエラーになりました（' + (clean(msg, 80) || 'エラーコード ' + res.status) + '）。', 502, 'G_ERROR');
  }
  return j;
}
// お店（ビジネスプロフィール）を探す：最初のアカウントの最初のお店。1日1回だけ探し直す
async function gLocation(env) {
  const hit = await kvGet(env, 'gLoc');
  if (hit && Date.now() - hit.t < 86400000) return hit;
  const acc = await gApi(env, 'mybusinessaccountmanagement.googleapis.com', '/v1/accounts');
  const accounts = acc.accounts || [];
  for (const a of accounts) {
    const l = await gApi(env, 'mybusinessbusinessinformation.googleapis.com', '/v1/' + a.name + '/locations?readMask=name,title&pageSize=10');
    const loc = (l.locations || [])[0];
    if (loc) { const out = { account: a.name, location: loc.name, title: loc.title || '', t: Date.now() }; await kvPut(env, 'gLoc', out); return out; }
  }
  fail('このGoogleアカウントで管理しているお店が見つかりませんでした。お店のオーナーか管理者のアカウントでつないでください。', 400, 'G_ERROR');
}
const G_METRICS = {
  BUSINESS_IMPRESSIONS_MOBILE_MAPS: 'maps', BUSINESS_IMPRESSIONS_DESKTOP_MAPS: 'maps',
  BUSINESS_IMPRESSIONS_MOBILE_SEARCH: 'search', BUSINESS_IMPRESSIONS_DESKTOP_SEARCH: 'search',
  CALL_CLICKS: 'calls', WEBSITE_CLICKS: 'web', BUSINESS_DIRECTION_REQUESTS: 'dir'
};
const STARS = { ONE: 1, TWO: 2, THREE: 3, FOUR: 4, FIVE: 5 };
// 読む（6時間とっておく）：日ごとの表示・電話・ルート・サイト、先月の検索語句、口コミ
async function googleData(env, force) {
  const hit = await kvGet(env, 'gData');
  if (!force && hit && Date.now() - hit.t < 6 * 3600000) return hit;
  const loc = await gLocation(env);
  const today = jstStamp(Date.now()).slice(0, 10);
  const from = addDays(today, -57), to = addDays(today, -2);
  const dp = (k, d) => { const p = d.split('-').map(Number); return k + '.year=' + p[0] + '&' + k + '.month=' + p[1] + '&' + k + '.day=' + p[2]; };
  const q = Object.keys(G_METRICS).map(m => 'dailyMetrics=' + m).join('&') + '&' + dp('dailyRange.start_date', from) + '&' + dp('dailyRange.end_date', to);
  const perf = await gApi(env, 'businessprofileperformance.googleapis.com', '/v1/' + loc.location + ':fetchMultiDailyMetricsTimeSeries?' + q);
  const days = {};
  for (let d = from; d <= to; d = addDays(d, 1)) days[d] = { d: d, maps: 0, search: 0, calls: 0, web: 0, dir: 0 };
  (perf.multiDailyMetricTimeSeries || []).forEach(s => (s.dailyMetricTimeSeries || []).forEach(ts => {
    const key = G_METRICS[ts.dailyMetric];
    if (!key) return;
    ((ts.timeSeries || {}).datedValues || []).forEach(v => {
      if (!v.date) return;
      const d = v.date.year + '-' + pad(v.date.month) + '-' + pad(v.date.day);
      if (days[d]) days[d][key] += Number(v.value) || 0;
    });
  }));
  const list = Object.keys(days).sort().map(d => days[d]);
  const sum = arr => arr.reduce((a, x) => ({ maps: a.maps + x.maps, search: a.search + x.search, calls: a.calls + x.calls, web: a.web + x.web, dir: a.dir + x.dir }), { maps: 0, search: 0, calls: 0, web: 0, dir: 0 });
  const cur = sum(list.slice(-28)), prev = sum(list.slice(-56, -28));
  // 検索された言葉（先月）。少ないものは「15未満」のように範囲で返ってくる
  let words = [];
  try {
    const lm = addMonths(today.slice(0, 7), -1).split('-').map(Number);
    const kq = 'monthlyRange.start_month.year=' + lm[0] + '&monthlyRange.start_month.month=' + lm[1] + '&monthlyRange.end_month.year=' + lm[0] + '&monthlyRange.end_month.month=' + lm[1] + '&pageSize=100';
    const kw = await gApi(env, 'businessprofileperformance.googleapis.com', '/v1/' + loc.location + '/searchkeywords/impressions/monthly?' + kq);
    words = (kw.searchKeywordsCounts || []).map(x => ({ k: clean(x.searchKeyword, 40), v: Number((x.insightsValue || {}).value) || 0, lt: (x.insightsValue || {}).threshold ? Number(x.insightsValue.threshold) || 0 : 0 }))
      .sort((a, b) => (b.v || b.lt - 0.5) - (a.v || a.lt - 0.5)).slice(0, 15);
  } catch (e) { console.error('検索語句', e && e.message); }
  // 口コミ（古いAPI。使えないときは出さない）
  let reviews = null, revErr = '';
  try {
    const r = await gApi(env, 'mybusiness.googleapis.com', '/v4/' + loc.account + '/' + loc.location + '/reviews?pageSize=20&orderBy=updateTime%20desc');
    reviews = { avg: Number(r.averageRating) || 0, total: Number(r.totalReviewCount) || 0,
      recent: (r.reviews || []).slice(0, 20).map(x => ({ stars: STARS[x.starRating] || 0, text: clean(x.comment || '', 400).replace(/\(Translated by Google\)[\s\S]*$/, '').trim(), date: jstStamp(Date.parse(x.createTime) || Date.now()).slice(0, 10), name: clean((x.reviewer || {}).displayName || '', 30), replied: !!x.reviewReply })) };
  } catch (e) { revErr = e.message; }
  const out = { t: Date.now(), title: loc.title, from: from, to: to, days: list, cur: cur, prev: prev, words: words, wordsMonth: Number(addMonths(today.slice(0, 7), -1).slice(5)), reviews: reviews, revErr: revErr };
  await kvPut(env, 'gData', out);
  return out;
}
async function adminGoogle(env, b) {
  if (!gOn(env)) return { configured: false };
  const g = await kvGet(env, 'google');
  if (!g) return { configured: true, connected: false };
  try { return { configured: true, connected: true, since: g.at, data: await googleData(env, b && b.force) }; }
  catch (e) {
    if (!e.userFacing) throw e;
    return { configured: true, connected: e.code !== 'G_NONE', err: e.message };
  }
}
async function adminGoogleOff(env) { await env.DB.prepare("DELETE FROM kv WHERE k IN ('google','gTok','gLoc','gData')").run(); return { ok: true }; }
// Claude に渡す：Googleマップ・検索での見られ方（とってある分だけ。口コミの書いた人の名前は送らない）
async function factsGoogle(env) {
  if (!gOn(env)) return '';
  let d = null;
  try { if (await kvGet(env, 'google')) d = await googleData(env); } catch (e) { return ''; }
  if (!d) return '';
  const c = d.cur, p = d.prev;
  const lines = ['【Googleマップ・Google検索（ビジネスプロフィール、直近28日とその前の28日）】',
    'お店が表示された回数：マップ' + c.maps + '回（前' + p.maps + '）・検索' + c.search + '回（前' + p.search + '）',
    '電話' + c.calls + '回（前' + p.calls + '）・ルート検索' + c.dir + '回（前' + p.dir + '）・ウェブサイト' + c.web + '回（前' + p.web + '）'];
  if (d.words.length) lines.push(d.wordsMonth + '月に検索された言葉：' + d.words.slice(0, 10).map(w => w.k + (w.v ? ' ' + w.v + '回' : ' ' + w.lt + '回未満')).join('、'));
  if (d.reviews) {
    lines.push('口コミ：平均' + d.reviews.avg.toFixed(1) + '（' + d.reviews.total + '件）、返信していないもの' + d.reviews.recent.filter(r => !r.replied).length + '件');
    d.reviews.recent.slice(0, 5).forEach(r => lines.push('・' + r.date + ' ★' + r.stars + ' ' + noPrivate(r.text, 120)));
  }
  return lines.join('\n');
}
