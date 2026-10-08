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
    messages: [{ role: 'user', content: o.content }],
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
    env.DB.prepare("SELECT id, date, time, session, stay, arrived FROM reservations WHERE date BETWEEN ? AND ? AND status = '確定' AND (arrived IS NULL OR arrived != 'no')").bind(from, to)
  ]);
  const byDate = {};
  rs[0].results.forEach(p => { (byDate[p.date] = byDate[p.date] || { pays: [], res: [] }).pays.push(p); });
  rs[1].results.forEach(r => { if (byDate[r.date]) byDate[r.date].res.push(r); });
  const updates = [];
  Object.values(byDate).forEach(d => {
    const owner = {};
    d.res.map(r => {
      const start = toMin(r.time);
      const stay = Number(r.stay) || (s.sessions[r.session] ? Number(s.sessions[r.session].stay) : 120) || 120;
      return { id: r.id, start: start, end: start + stay };
    }).sort((a, b) => a.end - b.end).forEach(r => {
      let best = null;
      d.pays.forEach(p => {
        if (owner[p.id]) return;
        const t = toMin(p.ts.slice(11, 16));
        if (t < r.start + 20 || t > r.end + 90) return;
        const score = Math.abs(t - r.end);
        if (!best || score < best.score) best = { id: p.id, score: score };
      });
      if (best) owner[best.id] = r.id;
    });
    d.pays.forEach(p => {
      const link = owner[p.id] ? 'auto' : '';
      const res = owner[p.id] || null;
      if (p.link !== link || (p.res_id || null) !== res) {
        updates.push(env.DB.prepare('UPDATE sq_payments SET link = ?, res_id = ? WHERE id = ? AND link IN (\'\', \'auto\')').bind(link, res, p.id));
      }
    });
  });
  for (let i = 0; i < updates.length; i += 50) await env.DB.batch(updates.slice(i, i + 50));
}

// 今日の画面：今日（会計がまだなければ昨日）の売上と、予約のない会計
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
  const withRes = list.filter(p => p.link === 'auto' || p.link === 'res');
  const st = (await kvGet(env, 'sqMonths')) || {};
  return {
    connected: true, error: error, today: today, day: day,
    total: list.reduce((a, p) => a + net(p), 0), count: list.length,
    withRes: withRes.reduce((a, p) => a + net(p), 0), resCount: withRes.length,
    walkIn: list.filter(p => !(p.link === 'auto' || p.link === 'res')).reduce((a, p) => a + net(p), 0),
    walkCount: list.length - withRes.length,
    syncedAt: st[today.slice(0, 7)] ? jstStamp(st[today.slice(0, 7)]) : '',
    open: rows.filter(p => p.link === '' && net(p) > 0).slice(0, 30)
      .map(p => ({ id: p.id, date: p.date, time: p.ts.slice(11, 16), amount: net(p), method: p.method || '' }))
  };
}

// 予約のない会計を、お客様に結びつける・予約の会計にする・そのままにする
async function adminSalesLink(env, b) {
  const p = await env.DB.prepare('SELECT * FROM sq_payments WHERE id = ?').bind(String(b.id || '')).first();
  if (!p) fail('会計が見つかりません。画面を更新してください。');
  const act = String(b.action || '');
  const set = (link, key) => env.DB.prepare('UPDATE sq_payments SET link = ?, cust_key = ? WHERE id = ?').bind(link, key || null, p.id).run();
  if (act === 'undo') {
    if (p.link === 'cust' && p.cust_key) {
      const info = await customerInfo(env);
      const k = mergedTarget(info, p.cust_key);
      await upsertCustomer(env, k, { extra: Math.max(0, (info[k] ? info[k].extra : 0) - 1) });
    }
    await set('', null);
    return { sales: await adminSales(env, {}) };
  }
  if (p.link !== '') fail('この会計はもう選び終わっています。画面を更新してください。');
  if (act === 'cust' || act === 'new') {
    let key = String(b.key || '').slice(0, 60);
    if (act === 'new') {
      const added = await adminAddCustomer(env, { name: b.name, tel: b.tel, extra: 0 });
      key = added.key;
    }
    const info = await customerInfo(env);
    const k = mergedTarget(info, key);
    if (!k) fail('お客様を選んでください。');
    const groups = groupCustomers(await allCustomerRows(env), info).groups;
    if (!groups[k] && !info[k]) fail('お客様が見つかりません。');
    await upsertCustomer(env, k, { extra: (info[k] ? info[k].extra : 0) + 1 });
    await set('cust', k);
    return { sales: await adminSales(env, {}), key: k };
  }
  if (act === 'res' || act === 'skip') {
    await set(act, null);
    return { sales: await adminSales(env, {}) };
  }
  return fail('操作を選び直してください。');
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
const PAY_ACCOUNTS = [['現金', '現金'], ['事業主借', '個人のお金・カード（事業主借）'], ['未払金', '事業用のカード（未払金）'], ['普通預金', '口座から（普通預金）'], ['小口現金', '小口現金']];
function payOptions(m) {
  return PAY_ACCOUNTS.map(p => { const a = m.accounts.find(x => x.name === p[0]); return a ? { id: a.id, name: a.name, label: p[1] } : null; }).filter(Boolean);
}
function expenseOptions(m) {
  return m.accounts.filter(a => a.group === 'EXPENSE').map(a => ({ id: a.id, name: a.name }));
}

// 1か月分の経費（仕訳から経費の科目だけを集める。日付ごと・科目ごと）
async function mfMonth(env, ym, maxAge) {
  const key = 'mfm:' + ym;
  const saved = await kvGet(env, key);
  if (saved && Date.now() - saved.at < maxAge) return saved;
  const m = await mfMaster(env);
  const acc = {};
  m.accounts.forEach(a => { acc[a.id] = a; });
  const gross = m.method !== 'TAX_EXCLUDED';
  const sums = {};
  for (let page = 1; page <= 20; page++) {
    const j = await mfApi(env, 'GET', '/journals', { start_date: ym + '-01', end_date: monthLast(ym), per_page: 1000, page: page });
    (j.journals || []).forEach(jr => (jr.branches || []).forEach(br => {
      [['debitor', 1], ['creditor', -1]].forEach(x => {
        const side = br[x[0]];
        if (!side || !side.account_id) return;
        const a = acc[side.account_id];
        if (!a || a.group !== 'EXPENSE') return;
        const v = (Number(side.value) || 0) + (gross ? Number(side.tax_value) || 0 : 0);
        const k = jr.transaction_date + '|' + a.name;
        sums[k] = (sums[k] || 0) + x[1] * v;
      });
    }));
    const meta = j.metadata || {};
    if (!meta.total_pages || page >= meta.total_pages) break;
  }
  const out = { at: Date.now(), rows: Object.keys(sums).filter(k => sums[k]).map(k => { const p = k.split('|'); return [p[0], p[1], sums[k]]; }) };
  await kvPut(env, key, out);
  return out;
}
const FOOD = /仕入/;

/* ---------- レシートの登録（今日の画面から） ---------- */
const RECEIPT_SYSTEM = [
  'あなたは、小さな飲食店の経理を手伝っています。レシート・領収書の写真から、マネーフォワードに経費として登録するための内容を読み取ります。',
  '- date：支払った日を YYYY-MM-DD で。年がないときは今日に近い日付にする（未来にならないように）。和暦は西暦に直す。',
  '- total：支払った合計金額（税込、円、整数）。おつり・お預かりと間違えない。',
  '- payee：お店・会社の名前（支店名はなくてよい、20文字以内）。',
  '- items：買ったものを短く（例「にんじん・れんこん他」、20文字以内）。',
  '- rate：消費税の税率。食料品だけなら "8"、それ以外だけなら "10"、両方あれば "mixed"、税のかからないもの（切手・印紙・公共料金の一部など）は "none"、分からなければ "unknown"。',
  '- amount8・amount10：rate が "mixed" のときだけ、8%と10%それぞれの税込の金額。それ以外は 0。',
  '- payment：支払い方法。現金 "cash"、クレジットカード "card"、QRコード・電子マネー "qr"、分からなければ "unknown"。',
  '- account：勘定科目。必ず、渡した一覧の中から1つ選ぶ。食材・飲み物の仕入れは「仕入高」があればそれ。過去の登録に同じお店があれば、それに合わせる。',
  '- unsure：読み取りに自信がない項目（"date"・"total"・"payee"・"rate"・"account" から）。',
  '- note：自信がない理由を短く（30文字以内、なければ空）。例「日付の数字がかすれています」。',
  '- readable：レシートとして読めないとき（写真がぼやけている、レシートではない）は false。'
].join('\n');
const RECEIPT_SCHEMA = strSchema({
  readable: { type: 'boolean' },
  date: { type: 'string' },
  total: { type: 'integer' },
  payee: { type: 'string' },
  items: { type: 'string' },
  rate: { type: 'string', enum: ['8', '10', 'mixed', 'none', 'unknown'] },
  amount8: { type: 'integer' },
  amount10: { type: 'integer' },
  payment: { type: 'string', enum: ['cash', 'card', 'qr', 'unknown'] },
  account: { type: 'string' },
  unsure: { type: 'array', items: { type: 'string', enum: ['date', 'total', 'payee', 'rate', 'account'] } },
  note: { type: 'string' }
});

function imageBlock(b) {
  const data = String(b.image || '').replace(/^data:[^,]*,/, '');
  if (!data || data.length > 8000000 || !/^[A-Za-z0-9+/=]+$/.test(data.slice(0, 200))) fail('写真を読み込めませんでした。もう一度撮ってください。');
  const type = ['image/jpeg', 'image/png', 'image/webp'].indexOf(b.type) >= 0 ? b.type : 'image/jpeg';
  return { type: 'image', source: { type: 'base64', media_type: type, data: data } };
}

async function rcptList(env) {
  const ym = jstStamp(Date.now()).slice(0, 7);
  const rs = await env.DB.batch([
    env.DB.prepare("SELECT COUNT(*) AS n, COALESCE(SUM(amount), 0) AS total FROM receipts WHERE status = 'ok' AND substr(created_at, 1, 7) = ?").bind(ym),
    env.DB.prepare("SELECT * FROM receipts WHERE status = 'ok' ORDER BY created_at DESC LIMIT 12")
  ]);
  return {
    count: rs[0].results[0].n, total: rs[0].results[0].total,
    items: rs[1].results.map(r => ({ id: r.id, date: r.date, amount: r.amount, payee: r.payee, account: r.account, method: r.method, at: r.created_at }))
  };
}
async function adminRcptList(env) {
  if (!env.MF_API_KEY) return { connected: false };
  return { connected: true, list: await rcptList(env) };
}

async function adminRcptRead(env, b) {
  const img = imageBlock(b);
  const m = await mfMaster(env);
  const expense = expenseOptions(m);
  if (!expense.length) fail('マネーフォワードに経費の勘定科目が見つかりませんでした。');
  const past = (await env.DB.prepare("SELECT payee, account FROM receipts WHERE status = 'ok' ORDER BY created_at DESC LIMIT 60").all()).results;
  const seen = {};
  const hist = past.filter(p => p.payee && !seen[p.payee] && (seen[p.payee] = true)).slice(0, 20).map(p => p.payee + '→' + p.account);
  const today = jstStamp(Date.now()).slice(0, 10);
  const out = await claude(env, {
    system: RECEIPT_SYSTEM, effort: 'low', maxTokens: 6000,
    content: [img, { type: 'text', text: '今日：' + today + '\n勘定科目の一覧：' + expense.map(a => a.name).join('、') + '\n過去に登録したお店と科目：' + (hist.join('、') || 'なし') }],
    schema: RECEIPT_SCHEMA
  });
  const acc = expense.find(a => a.name === out.account) || expense.find(a => FOOD.test(a.name)) || expense[0];
  const pays = payOptions(m);
  const remember = (await kvGet(env, 'rcptPay')) || {};
  const byName = n => (pays.find(p => p.name === n) || {}).id;
  const payId = remember[out.payment] && pays.some(p => p.id === remember[out.payment]) ? remember[out.payment]
    : out.payment === 'card' ? byName('未払金') || byName('事業主借') || byName('現金')
    : out.payment === 'qr' ? byName('事業主借') || byName('現金')
    : byName('現金') || byName('事業主借');
  const total = Math.max(0, Number(out.total) || 0);
  const rate = out.rate === 'unknown' ? (FOOD.test(acc.name) ? '8' : '10') : out.rate;
  return {
    read: {
      readable: out.readable !== false && total > 0,
      date: isDate(out.date) && out.date <= today ? out.date : today,
      amount: total, payee: clean(out.payee, 40), memo: clean(out.items, 40),
      rate: rate, amount8: Number(out.amount8) || 0, amount10: Number(out.amount10) || 0,
      payment: out.payment, accountId: acc.id, payId: payId || (pays[0] ? pays[0].id : ''),
      unsure: (out.unsure || []).concat(out.rate === 'unknown' ? ['rate'] : []).concat(isDate(out.date) ? [] : ['date']),
      note: clean(out.note, 60)
    },
    accounts: expense, pays: pays, taxes: { '8': !!pickTax(m.taxes, '8'), '10': !!pickTax(m.taxes, '10') }
  };
}

async function adminRcptSave(env, b) {
  const m = await mfMaster(env);
  const date = String(b.date || '');
  if (!isDate(date)) fail('日付を入れてください。');
  const amount = Math.round(Number(String(b.amount || '').replace(/[^\d]/g, '')));
  if (!(amount > 0 && amount < 100000000)) fail('金額を入れてください。');
  const acc = expenseOptions(m).find(a => a.id === b.accountId);
  if (!acc) fail('勘定科目を選んでください。');
  const pay = m.accounts.find(a => a.id === b.payId);
  if (!pay) fail('支払い方法を選んでください。');
  const rate = ['8', '10', 'mixed', 'none'].indexOf(b.rate) >= 0 ? b.rate : '10';
  const payee = clean(b.payee, 40);
  const memo = clean(b.memo, 60);
  const remark = clean([payee, memo].filter(Boolean).join(' '), 200);
  let parts;
  if (rate === 'mixed') {
    const a8 = Math.round(Number(b.amount8) || 0);
    const a10 = amount - a8;
    if (!(a8 > 0 && a10 > 0)) fail('8%と10%の金額を確かめてください。');
    parts = [['8', a8], ['10', a10]];
  } else {
    parts = [[rate, amount]];
  }
  const branches = parts.map(p => {
    const tax = pickTax(m.taxes, p[0] === 'none' ? 'none' : p[0]);
    const deb = { account_id: acc.id, value: p[1] };
    if (tax) deb.tax_id = tax;
    return { debitor: deb, creditor: { account_id: pay.id, value: p[1] }, remark: remark };
  });
  const r = await mfApi(env, 'POST', '/journals', null, { journal: { transaction_date: date, journal_type: 'journal_entry', branches: branches, memo: 'épiiの予約管理から登録' } });
  const jid = (r.journal && r.journal.id) || r.id || '';
  // 登録した金額が合っているか、取り直して確かめる（税込で記帳しているとき）
  let check = '';
  if (jid && m.method !== 'TAX_EXCLUDED') {
    try {
      const g = await mfApi(env, 'GET', '/journals/' + encodeURIComponent(jid));
      const got = ((g.journal || {}).branches || []).reduce((a, br) => a + (br.debitor ? (Number(br.debitor.value) || 0) + (Number(br.debitor.tax_value) || 0) : 0), 0);
      if (got && got !== amount) check = 'マネーフォワード側の金額が' + '¥' + got.toLocaleString() + 'になっています。マネーフォワードで確かめてください。';
    } catch (e) { /* 確認できなくても登録はできている */ }
  }
  // 写真は証憑としてマネーフォワードに添付する（予約システムには残さない）
  let attached = false;
  if (jid && b.image) {
    try {
      await mfApi(env, 'POST', '/vouchers', null, { journal_id: jid, voucher_files: [{ file_name: 'receipt-' + date + '.jpg', file_data: String(b.image).replace(/^data:[^,]*,/, '') }] });
      attached = true;
    } catch (e) { console.error('証憑の添付に失敗', e && e.message); }
  }
  await env.DB.prepare("INSERT INTO receipts (id, created_at, date, amount, payee, account, tax, method, memo, journal_id, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ok')")
    .bind(newId('P'), jstStamp(Date.now()), date, amount, payee, acc.name, rate, pay.name, memo, jid).run();
  if (['cash', 'card', 'qr'].indexOf(b.payment) >= 0) {
    const remember = (await kvGet(env, 'rcptPay')) || {};
    remember[b.payment] = pay.id;
    await kvPut(env, 'rcptPay', remember);
  }
  await env.DB.prepare('DELETE FROM kv WHERE k = ?').bind('mfm:' + date.slice(0, 7)).run();
  return { check: check, attached: attached, list: await rcptList(env) };
}

async function adminRcptUndo(env, b) {
  const r = await env.DB.prepare("SELECT * FROM receipts WHERE id = ? AND status = 'ok'").bind(String(b.id || '')).first();
  if (!r) fail('取り消すレシートが見つかりません。');
  if (r.journal_id) await mfApi(env, 'DELETE', '/journals/' + encodeURIComponent(r.journal_id));
  await env.DB.prepare("UPDATE receipts SET status = 'deleted' WHERE id = ?").bind(r.id).run();
  await env.DB.prepare('DELETE FROM kv WHERE k = ?').bind('mfm:' + r.date.slice(0, 7)).run();
  return { list: await rcptList(env) };
}

/* ---------- 売上・経費の分析 ---------- */
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
    "COUNT(*) AS n, COALESCE(SUM(CASE WHEN link IN ('auto','res') THEN 0 ELSE 1 END), 0) AS walkN FROM sq_payments WHERE status = 'COMPLETED' AND amount > refunded AND date BETWEEN ? AND ?"
  ).bind(from, to).first();
  const g = await env.DB.prepare(
    "SELECT COALESCE(SUM(guests), 0) AS guests, COUNT(*) AS groups FROM reservations WHERE status = '確定' AND (arrived IS NULL OR arrived != 'no') AND date BETWEEN ? AND ? AND date <= ?"
  ).bind(from, to, jstStamp(Date.now()).slice(0, 10)).first();
  return { sales: r.sales, res: r.res, walk: r.sales - r.res, payments: r.n, walkN: r.walkN, guests: g.guests, groups: g.groups };
}
function expenseSums(monthsData, from, to) {
  const by = {};
  let total = 0;
  let food = 0;
  monthsData.forEach(md => (md ? md.rows : []).forEach(x => {
    if (x[0] < from || x[0] > to) return;
    by[x[1]] = (by[x[1]] || 0) + x[2];
    total += x[2];
    if (FOOD.test(x[1])) food += x[2];
  }));
  return { total: total, food: food, accounts: Object.keys(by).map(k => ({ name: k, value: by[k] })).filter(x => x.value).sort((a, b) => b.value - a.value) };
}

async function adminMoney(env, b) {
  const f = features(env);
  const today = jstStamp(Date.now()).slice(0, 10);
  const cur = today.slice(0, 7);
  const P = moneyPeriod(String(b.period || 'month'), today);
  const chartMonths = [];
  for (let i = 5; i >= 0; i--) chartMonths.push(addMonths(cur, -i));
  const need = monthsBetween(P.prevFrom < chartMonths[0] + '-01' ? P.prevFrom : chartMonths[0] + '-01', today);
  let sqErr = '';
  let mfErr = '';
  if (f.square) {
    try { await sqEnsure(env, need, b.force ? 0 : 600000); } catch (e) { if (!e.userFacing) throw e; sqErr = e.message; }
  }
  const mfData = {};
  if (f.mf) {
    try {
      await eachLimit(need, 3, async ym => { mfData[ym] = await mfMonth(env, ym, b.force && ym >= addMonths(cur, -1) ? 0 : ym === cur ? 600000 : ym === addMonths(cur, -1) ? 6 * 3600000 : 7 * 86400000); });
    } catch (e) { if (!e.userFacing) throw e; mfErr = e.message; }
  }
  const all = Object.values(mfData);
  const [now, prev] = await Promise.all([salesSums(env, P.from, P.to), salesSums(env, P.prevFrom, P.prevTo)]);
  const ex = expenseSums(all, P.from, P.to);
  const exPrev = expenseSums(all, P.prevFrom, P.prevTo);
  const months = await Promise.all(chartMonths.map(async ym => {
    const s = await salesSums(env, ym + '-01', monthLast(ym));
    return { ym: ym, sales: s.sales, expense: mfData[ym] ? expenseSums([mfData[ym]], ym + '-01', monthLast(ym)).total : null };
  }));
  const insight = await kvGet(env, 'aiMoney');
  const st = (await kvGet(env, 'sqMonths')) || {};
  return {
    features: f, sqErr: sqErr, mfErr: mfErr, period: P,
    now: Object.assign(now, { expense: ex.total, food: ex.food }),
    prev: Object.assign(prev, { expense: exPrev.total, food: exPrev.food }),
    expenses: ex.accounts, months: months,
    hasExpense: f.mf && !mfErr, hasSales: f.square && !sqErr,
    insight: insight, syncedAt: st[cur] ? jstStamp(st[cur]) : ''
  };
}

// Claude に渡す数字（お客様の名前・電話は入れない）
async function moneyFacts(env) {
  const f = features(env);
  const today = jstStamp(Date.now()).slice(0, 10);
  const cur = today.slice(0, 7);
  const s = await getSettings(env);
  const lines = ['今日：' + jdLong(today), 'お店：' + s.seats + '席、店主ひとり。予約はLINEのリクエスト制（お店が承認して確定）。'];
  lines.push('いつもの営業：' + WD.split('').map((w, i) => w + '曜 ' + ((s.weekly[String(i)] || []).map(k => sessionLabel(s, k)).join('・') || '休み')).join('、'));
  lines.push('締切：予約は' + s.cutoff.days + '日前、変更は' + s.changeCutoff.days + '日前、ネットでのキャンセルは' + s.cancelDays + '日前まで。受付は' + (s.openUntil ? jdLong(s.openUntil) + 'まで' : s.aheadDays + '日先まで'));
  const months = [];
  for (let i = 5; i >= 0; i--) months.push(addMonths(cur, -i));
  if (f.square) { try { await sqEnsure(env, months, 600000); } catch (e) { lines.push('Squareの取り込みエラー：' + e.message); } }
  const mfData = {};
  if (f.mf) {
    try { await eachLimit(months, 3, async ym => { mfData[ym] = await mfMonth(env, ym, ym === cur ? 600000 : 6 * 3600000); }); }
    catch (e) { lines.push('マネーフォワードの取り込みエラー：' + e.message); }
  }
  lines.push('', '【月ごと】（売上はSquareのレジ、経費はマネーフォワード。今月は今日まで）');
  for (const ym of months) {
    const x = await salesSums(env, ym + '-01', ym === cur ? today : monthLast(ym));
    const e = mfData[ym] ? expenseSums([mfData[ym]], ym + '-01', monthLast(ym)) : null;
    lines.push(ym + '：' + (f.square ? '売上 ¥' + x.sales.toLocaleString() + '（予約あり ¥' + x.res.toLocaleString() + '・予約なしの会計 ' + x.walkN + '件 ¥' + x.walk.toLocaleString() + '）' : '売上データなし') +
      '、予約の来店 ' + x.groups + '組 ' + x.guests + '名' +
      (e ? '、経費 ¥' + e.total.toLocaleString() + '（食材の仕入れ ¥' + e.food.toLocaleString() + '）、内訳：' + e.accounts.slice(0, 6).map(a => a.name + ' ¥' + a.value.toLocaleString()).join('・') : ''));
  }
  const P = moneyPeriod('month', today);
  const a = await salesSums(env, P.from, P.to);
  const b = await salesSums(env, P.prevFrom, P.prevTo);
  lines.push('今月（' + P.to.slice(8) + '日まで）と先月の同じ日まで：売上 ¥' + a.sales.toLocaleString() + ' / ¥' + b.sales.toLocaleString() + '、予約の来店 ' + a.guests + '名 / ' + b.guests + '名');
  // 曜日・時間帯ごと（直近8週）
  const from8 = addDays(today, -56);
  const rs = await env.DB.batch([
    env.DB.prepare("SELECT date, ts, amount - refunded AS v, link FROM sq_payments WHERE status = 'COMPLETED' AND amount > refunded AND date BETWEEN ? AND ?").bind(from8, today),
    env.DB.prepare("SELECT date, session, guests, status, arrived, course_name FROM reservations WHERE date BETWEEN ? AND ? AND status IN ('確定','キャンセル')").bind(from8, addDays(today, -1)),
    env.DB.prepare("SELECT c.date, c.session FROM change_requests c WHERE c.created_at >= ?").bind(from8)
  ]);
  const ws = {};
  const sessOf = hm => {
    const m = toMin(hm);
    const keys = sessionKeys(s);
    const hit = keys.find(k => toMin(s.sessions[k].open) - 30 <= m && m < toMin(s.sessions[k].close) + 90);
    return hit || keys[keys.length - 1];
  };
  const cell = (d, k) => { const id = WD[weekday(d)] + '曜' + sessionLabel(s, k); return ws[id] || (ws[id] = { sales: 0, walk: 0, walkN: 0, guests: 0, cancel: 0, noshow: 0 }); };
  rs[0].results.forEach(p => { const c = cell(p.date, sessOf(p.ts.slice(11, 16))); c.sales += p.v; if (!(p.link === 'auto' || p.link === 'res')) { c.walk += p.v; c.walkN++; } });
  const courses = {};
  rs[1].results.forEach(r => {
    const c = cell(r.date, r.session);
    if (r.status === 'キャンセル') c.cancel++;
    else if (r.arrived === 'no') c.noshow++;
    else { c.guests += r.guests; courses[r.course_name] = (courses[r.course_name] || 0) + r.guests; }
  });
  lines.push('', '【直近8週の曜日・時間帯ごと】（合計）');
  Object.keys(ws).forEach(k => {
    const c = ws[k];
    lines.push(k + '：' + (f.square ? '売上 ¥' + c.sales.toLocaleString() + '（予約なし ' + c.walkN + '件 ¥' + c.walk.toLocaleString() + '）、' : '') + '予約の来店 ' + c.guests + '名、キャンセル ' + c.cancel + '件、来店なし ' + c.noshow + '件');
  });
  lines.push('メニューごとの来店人数（直近8週）：' + (Object.keys(courses).map(k => k + ' ' + courses[k] + '名').join('、') || 'なし'));
  lines.push('予約の変更の申し込み（直近8週）：' + rs[2].results.length + '件');
  // これからの空き
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
  lines.push('', '【これから2週間の空き】（各時間帯のいちばん空いている時間）', open.join('、') || '受付中の日がありません');
  if (s.openUntil && diffDays(today, s.openUntil) <= 14) lines.push('受付の最終日が近い：' + jdLong(s.openUntil));
  // 予約ページの閲覧（直近30日）
  try {
    const an = await adminAnalytics(env, { days: 30 });
    lines.push('', '【予約ページ（直近30日）】開かれた ' + an.totals.opens + '回、見た人 ' + an.totals.users + '人、リクエスト ' + an.funnel.request + '人。満席・締切で選べなかった日を押した人：' + an.blocked.reduce((x, y) => x + y.users, 0) + '人');
    lines.push('どこから：' + an.sources.slice(0, 5).map(x => x.src + ' ' + x.users + '人').join('、'));
  } catch (e) { /* なくても続ける */ }
  // Instagram（直近30日）
  try {
    const ig = await env.DB.prepare('SELECT COALESCE(SUM(reach), 0) AS reach, COUNT(*) AS days FROM ig_daily WHERE date >= ?').bind(addDays(today, -30)).first();
    const md = await env.DB.prepare("SELECT kind, COUNT(*) AS n FROM ig_media WHERE date >= ? GROUP BY kind").bind(addDays(today, -30)).all();
    if (ig && ig.days) lines.push('【Instagram（直近30日）】リーチ ' + ig.reach + '、' + md.results.map(x => ({ feed: '投稿', reel: 'リール', story: 'ストーリー' }[x.kind] || x.kind) + ' ' + x.n + '件').join('・'));
  } catch (e) { /* なくても続ける */ }
  return lines.join('\n');
}

const MONEY_SYSTEM = [
  'あなたは、大阪・阿倍野の小さな薬膳レストラン「épii」（店主ひとりで営業）の経営を手伝う相談役です。店主は数字や専門用語が得意ではありません。',
  '売上（Squareのレジ）・経費（マネーフォワード）・予約・予約ページの閲覧・Instagramの数字を読み、今いちばん大事な気づきを3つ（多くても4つ）選び、それぞれに今週できる「やること」を1つ付けます。',
  '目的は損益をよくすること：売上を増やす、食材のロスや経費を減らす、空いている席を埋める。',
  '',
  '書き方：',
  '- title：何が起きているかを1文で（40文字以内）。例「食材費の割合が31%から35%に上がっています」',
  '- body：そう言える根拠の数字を2文以内で（90文字以内）。データにないことは書かない。推測するときは「〜かもしれません」。',
  '- todo：今週できる具体的な行動を1つ（40文字以内）。管理画面でできることなら場所も書く（例：設定＞受付、予約＞受付を止める、設定＞分析＞Instagramの文案）。良い状態なら「今のまま」でもよい。',
  '- tone：good（良い変化）、warn（気をつけたいこと）、info（参考になること）。',
  '- 専門用語（原価率・客単価・CVR・KPIなど）は使わず、「食材費の割合」「1人あたり」「予約まで進んだ割合」のように書く。',
  '- 金額は「¥12,300」、割合は「35%」と書く。',
  '- データが少ない項目や、つながっていないサービスの項目には触れない。',
  '- ' + AI_BREAK_RULE
].join('\n');
const MONEY_SCHEMA = strSchema({
  items: {
    type: 'array',
    items: strSchema({
      tone: { type: 'string', enum: ['good', 'warn', 'info'] },
      title: { type: 'string' }, body: { type: 'string' }, todo: { type: 'string' }
    })
  }
});

// 週のまとめ（定期実行）はじっくり、画面の「最新にする」は待たせすぎないように
async function makeMoneyInsight(env, effort) {
  const facts = await moneyFacts(env);
  const out = await claude(env, { system: MONEY_SYSTEM, effort: effort || 'medium', maxTokens: 32000, timeout: 240000, content: [{ type: 'text', text: facts }], schema: MONEY_SCHEMA });
  const items = (out.items || []).slice(0, 4).map(x => ({
    tone: ['good', 'warn', 'info'].indexOf(x.tone) >= 0 ? x.tone : 'info',
    title: aiText(x.title, 120), body: aiText(x.body, 240), todo: aiText(x.todo, 120)
  }));
  const v = { at: jstStamp(Date.now()), items: items };
  await kvPut(env, 'aiMoney', v);
  return v;
}
async function adminMoneyAi(env) {
  return { insight: await makeMoneyInsight(env) };
}

/* ---------- (2) 週1回のまとめ（月曜 9:00 にお店のLINEへ） ---------- */
async function weeklyReport(env, force) {
  const f = features(env);
  if (!f.ai && !f.square) return { skipped: 'off' };
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
  let todos = [];
  if (f.ai) {
    try { todos = (await makeMoneyInsight(env, 'high')).items.map(x => plain(x.todo)).filter(Boolean).slice(0, 3); }
    catch (e) { console.error('週のまとめ：分析', e.message); }
  }
  if (todos.length) lines.push('', '【今週やること】', ...todos.map((t, i) => (i + 1) + '. ' + t));
  const url = await adminUrl(env);
  if (url) lines.push('', 'くわしくは管理画面で', url);
  const res = await pushOwner(env, lines.join('\n'));
  if (res.ok) await kvPut(env, 'weeklyAt', { date: today, at: now });
  return { ok: res.ok, text: lines.join('\n') };
}

/* ---------- (3) Instagramの文案 ---------- */
const IG_SYSTEM = [
  'あなたは、大阪・阿倍野の小さな薬膳レストラン「épii」のInstagramの文を、店主の代わりに下書きします。',
  'これまでの投稿の文（渡す一覧）を読んで、書き出し・文の長さ・改行・絵文字やハッシュタグの使い方を、そのお店の書き方に合わせてください。',
  '- story：ストーリーに載せる短い文（3〜4行、全体で60文字くらい）。空いている日時を知らせ、「ご予約はリンクから」で締める。',
  '- post：フィード投稿の文（5〜8行）。季節や食材から書き出し、空きのお知らせとご予約の案内。最後にハッシュタグを3〜5個（これまでの投稿で使っているものを優先）。',
  '- reel：リールに付ける短い文（2〜3行）とハッシュタグ。',
  '- style：これまでの投稿から読み取った書き方の特徴を、3〜4項目（各25文字以内）。',
  '- 料理の写真があれば、写っているものに合わせる。写っていない料理や食材は書かない。写真がなければ、メニューの説明にある範囲で書く。',
  '- 値段・席数の数字は書かない（「お席に余裕があります」くらい）。お店が言っていない特典は書かない。',
  '- 改行は「\\n」で入れる。' + AI_BREAK_RULE
].join('\n');

async function igCaptions(env) {
  const tk = await igToken(env).catch(() => null);
  if (tk) {
    try {
      const m = await igGet(env, tk.token, '/me/media', { fields: 'caption,media_product_type,timestamp', limit: 30 });
      const list = (m.data || []).map(x => clean(x.caption, 1200)).filter(Boolean);
      if (list.length) return list.slice(0, 20);
    } catch (e) { /* 取り込み済みの文を使う */ }
  }
  return (await env.DB.prepare("SELECT caption FROM ig_media WHERE kind != 'story' AND caption IS NOT NULL AND caption != '' ORDER BY ts DESC LIMIT 20").all()).results.map(x => x.caption);
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
async function adminIgOpenings(env) {
  const o = await upcomingOpenings(env);
  const cached = {};
  if (o.list.length) {
    const keys = o.list.map(x => 'ig:' + x.date + ':' + x.session).concat('ig:free');
    (await env.DB.prepare('SELECT k, v FROM ai_cache WHERE k IN (' + keys.map(() => '?').join(',') + ')').bind(...keys).all()).results
      .forEach(r => { try { cached[r.k.slice(3)] = JSON.parse(r.v); } catch (e) { /* 何もしない */ } });
  }
  return { openings: o.list, drafts: cached };
}

async function adminIgDraft(env, b) {
  const o = await upcomingOpenings(env);
  const free = b.date === 'free';
  const op = free ? null : o.list.find(x => x.date === b.date && x.session === b.session) || (isDate(b.date) ? { date: b.date, session: String(b.session || ''), label: sessionLabel(o.s, String(b.session || '')), left: 0 } : null);
  if (!free && !op) fail('告知する日を選んでください。');
  const key = free ? 'ig:free' : 'ig:' + op.date + ':' + op.session;
  const caps = await igCaptions(env);
  const menu = o.courses.filter(c => c.visible && (free || c.sessions.indexOf(op.session) >= 0))
    .map(c => '・' + c.name + (c.description ? '（' + c.description + '）' : '')).join('\n');
  const today = jstStamp(Date.now()).slice(0, 10);
  const facts = [
    '今日：' + jdLong(today),
    free ? '告知：空きのお知らせではない、ふだんの投稿' : '告知する空き：' + jdLong(op.date) + ' ' + op.label + (op.date === today ? '（今日）' : op.date === addDays(today, 1) ? '（明日）' : ''),
    'メニュー：\n' + (menu || 'なし'),
    'これまでの投稿の文（新しい順）：\n' + (caps.length ? caps.map((c, i) => '---' + (i + 1) + '\n' + c).join('\n') : 'なし（落ち着いた丁寧な文で書く）')
  ].join('\n');
  const src = await hashOf(facts);
  if (!b.fresh && !b.image) {
    const hit = await aiCacheGet(env, key);
    if (hit && hit.src === src) return { key: key.slice(3), draft: hit.v };
  }
  const content = [];
  if (b.image) content.push(imageBlock(b));
  content.push({ type: 'text', text: facts + (b.image ? '\n料理の写真：あり（1枚目）' : '') + (b.fresh && b.before ? '\n\n前の案とは違う書き出しにしてください：' + plain(clean(b.before, 400)) : '') });
  const out = await claude(env, {
    system: IG_SYSTEM, effort: 'medium', maxTokens: 12000, content: content,
    schema: strSchema({ style: { type: 'array', items: { type: 'string' } }, story: { type: 'string' }, post: { type: 'string' }, reel: { type: 'string' } })
  });
  const draft = {
    story: aiText(out.story, 600), post: aiText(out.post, 2000), reel: aiText(out.reel, 800),
    style: (out.style || []).slice(0, 4).map(x => aiText(x, 80)), photo: !!b.image, at: jstStamp(Date.now())
  };
  await aiCachePut(env, key, src, draft);
  return { key: key.slice(3), draft: draft };
}
