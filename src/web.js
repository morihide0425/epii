/* =========================================================
 * ホームページ（/home）と、テイクアウト（店頭受取・Squareで事前決済、/takeaway）
 * 中身は管理画面（設定＞ホームページ・テイクアウト）で書き換える。写真はD1に置く（R2はいらない）。
 * 決済は Square のお支払いリンク。テスト（Sandbox）と本番は Cloudflare の変数 TAKEOUT_SQUARE_ENVIRONMENT で切り替える。
 * 注文の確定は、Squareで支払いが「完了」になったのを確かめたときだけ（戻ってきたURLでは確定しない）。
 * ========================================================= */

function WEB_SCHEMA_SQL() {
  return [
    'CREATE TABLE IF NOT EXISTS web_media (id TEXT PRIMARY KEY, mime TEXT NOT NULL, data TEXT NOT NULL, created_at TEXT NOT NULL)',
    'CREATE TABLE IF NOT EXISTS web_orders (id TEXT PRIMARY KEY, token_hash TEXT NOT NULL UNIQUE, status TEXT NOT NULL, slot_date TEXT NOT NULL, slot_time TEXT NOT NULL, quantity INTEGER NOT NULL, amount INTEGER NOT NULL, title TEXT NOT NULL, name TEXT NOT NULL, email TEXT NOT NULL, phone TEXT NOT NULL, env TEXT NOT NULL, test INTEGER NOT NULL DEFAULT 0, location_id TEXT, link_id TEXT, link_url TEXT, sq_order_id TEXT UNIQUE, payment_id TEXT, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, picked_at TEXT, notified INTEGER NOT NULL DEFAULT 0)',
    'CREATE INDEX IF NOT EXISTS idx_web_orders_slot ON web_orders (slot_date, slot_time)'
  ];
}

/* ---------- ホームページの中身（項目と、はじめの文） ---------- */
const WEB_GROUPS = [['hours', '営業・お知らせ'], ['menu', '料理とお茶'], ['photos', '写真']];
const WEB_FIELDS = [
  { key: 'notice', label: 'トップのお知らせ', group: 'hours', type: 'textarea', max: 180, value: 'ランチセットはご予約なしで。コース料理はご予約を承っております。' },
  { key: 'lunchHours', label: 'ランチセットの時間', group: 'hours', type: 'text', max: 60, value: '11:30 – 14:00' },
  { key: 'teaDays', label: 'お茶の時間の営業日', group: 'hours', type: 'text', max: 30, value: '土・日' },
  { key: 'teaHours', label: 'お茶の時間', group: 'hours', type: 'text', max: 60, value: '14:00 – 15:30' },
  { key: 'salesHours', label: '店頭販売のご案内', group: 'hours', type: 'textarea', max: 160, value: '14:00以降、開店中にご利用いただけます' },
  { key: 'businessNote', label: '定休日・営業日の補足', group: 'hours', type: 'textarea', max: 300, value: 'コース料理はご予約制です。\n営業日・最新のご案内はInstagramをご確認ください。' },
  { key: 'reservationNote', label: '予約の受付について', group: 'hours', type: 'textarea', max: 400, value: 'ランチコースは当日9時頃まで受付。その他の受付期限・空席・価格は、LINEの予約ページまたはお電話でご確認ください。' },
  { key: 'visitNote', label: 'ご来店時のお願い', group: 'hours', type: 'textarea', max: 220, value: '店頭に駐輪場はございません。\n自転車の方は、近隣の駐輪場をご利用ください。' },
  { key: 'lunchTitle', label: 'ランチの見出し', group: 'menu', type: 'text', max: 60, value: '季節のランチセット' },
  { key: 'lunchDescription', label: 'ランチの説明・価格', group: 'menu', type: 'textarea', max: 360, value: '季節の食材を、épiiらしいひと皿に。\nいつものお昼に、身体を想うひとときを。' },
  { key: 'lunchBooking', label: 'ランチのご利用案内', group: 'menu', type: 'text', max: 120, value: 'ご予約なしでお越しいただけます' },
  { key: 'courseTitle', label: 'コースの見出し', group: 'menu', type: 'text', max: 60, value: 'ご予約で楽しむ、コース料理' },
  { key: 'courseDescription', label: 'コースの説明・価格', group: 'menu', type: 'textarea', max: 360, value: '朝、昼、夜。それぞれの時間に寄り添う料理を。\nお一人様からご予約いただけます。' },
  { key: 'courseTypes', label: 'コースの種類', group: 'menu', type: 'text', max: 120, value: 'モーニング・ランチ・ディナー' },
  { key: 'teaTitle', label: 'お茶と甘味の見出し', group: 'menu', type: 'text', max: 60, value: '養生茶と、やさしい甘味' },
  { key: 'teaDescription', label: 'お茶と甘味の説明・価格', group: 'menu', type: 'textarea', max: 360, value: 'お茶の香りに、ひと息つく午後。\n台灣の養生文化にふれる、穏やかな時間を。' },
  { key: 'menuNote', label: 'メニュー全体の補足', group: 'menu', type: 'textarea', max: 260, value: '写真はこれまでの料理の一例です。内容・価格・営業日は、公式のご案内をご確認ください。' },
  { key: 'lunchPhoto', label: 'ランチ・トップの写真', group: 'photos', type: 'image', max: 150, value: '/web/img/plate.webp', alt: 'lunchAlt' },
  { key: 'lunchAlt', label: 'ランチの写真の説明', group: 'photos', type: 'alt', max: 150, value: '季節の野菜と米粉のケイクサレを盛り合わせたépiiのひと皿' },
  { key: 'coursePhoto', label: 'コース料理の写真', group: 'photos', type: 'image', max: 150, value: '/web/img/green.webp', alt: 'courseAlt' },
  { key: 'courseAlt', label: 'コースの写真の説明', group: 'photos', type: 'alt', max: 150, value: '白い器に盛り付けた緑鮮やかな季節の料理' },
  { key: 'teaPhoto', label: '養生茶の写真', group: 'photos', type: 'image', max: 150, value: '/web/img/tea.webp', alt: 'teaAlt' },
  { key: 'teaAlt', label: '養生茶の写真の説明', group: 'photos', type: 'alt', max: 150, value: '木のテーブルに置かれた、淡い色の養生茶' },
  { key: 'sweetsPhoto', label: 'お茶と甘味の写真', group: 'photos', type: 'image', max: 150, value: '/web/img/sweet.webp', alt: 'sweetsAlt' },
  { key: 'sweetsAlt', label: 'お茶と甘味の写真の説明', group: 'photos', type: 'alt', max: 150, value: '木の匙を添えた、ガラスの器に入った台湾の甘味' },
  { key: 'journal1Photo', label: '日々のひとこま 01', group: 'photos', type: 'image', max: 150, value: '/web/img/soup.webp', alt: 'journal1Alt', cap: 'journal1Caption' },
  { key: 'journal1Alt', label: '写真01の説明', group: 'photos', type: 'alt', max: 150, value: '白い器に注がれた、橙色の季節のスープ' },
  { key: 'journal1Caption', label: '写真01のひと言', group: 'photos', type: 'caption', max: 40, value: '季節をすくう' },
  { key: 'journal2Photo', label: '日々のひとこま 02', group: 'photos', type: 'image', max: 150, value: '/web/img/dessert.webp', alt: 'journal2Alt', cap: 'journal2Caption' },
  { key: 'journal2Alt', label: '写真02の説明', group: 'photos', type: 'alt', max: 150, value: '白い器に盛られた台湾の甘味' },
  { key: 'journal2Caption', label: '写真02のひと言', group: 'photos', type: 'caption', max: 40, value: '台灣に想いを' },
  { key: 'journal3Photo', label: '日々のひとこま 03', group: 'photos', type: 'image', max: 150, value: '/web/img/shop.webp', alt: 'journal3Alt', cap: 'journal3Caption' },
  { key: 'journal3Alt', label: '写真03の説明', group: 'photos', type: 'alt', max: 150, value: '店頭に並ぶ養生茶' },
  { key: 'journal3Caption', label: '写真03のひと言', group: 'photos', type: 'caption', max: 40, value: '日々に、お茶を' }
];
const WEB_DEFAULTS = Object.fromEntries(WEB_FIELDS.map(f => [f.key, f.value]));
const WEB_IMAGE_RE = /^\/(web\/img\/[a-z0-9-]+\.webp|media\/[a-f0-9-]{36})$/;

function wEsc(v) { return String(v === undefined || v === null ? '' : v).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function wJson(v) { return JSON.stringify(v).replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026'); }
function wRender(tpl, c) { return tpl.replace(/\{\{([a-zA-Z0-9]+)(:lines)?\}\}/g, (_, k, lines) => { const v = wEsc(c[k] !== undefined ? c[k] : (WEB_DEFAULTS[k] || '')); return lines ? v.replace(/\n/g, '<br>') : v; }); }
async function webContent(env) { return Object.assign({}, WEB_DEFAULTS, (await kvGet(env, 'web')) || {}); }

function webShell(title, body, o) {
  o = o || {};
  return '<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer">' +
    (o.noindex ? '<meta name="robots" content="noindex">' : '') + (o.desc ? '<meta name="description" content="' + wEsc(o.desc) + '">' : '') +
    '<title>' + wEsc(title) + '｜épii</title><link rel="icon" href="/favicon.ico"><link rel="apple-touch-icon" href="/apple-touch-icon.png">' +
    '<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>' +
    '<link href="https://fonts.googleapis.com/css2?family=Cormorant+Garamond:ital,wght@0,400;1,400&family=Noto+Serif+JP:wght@400;500&display=swap" rel="stylesheet">' +
    '<link rel="stylesheet" href="/web/home.css?v=' + WEB_VER + '"></head><body>' + body + (o.script || '') + '</body></html>';
}
function webPage(body, status) {
  return new Response(body, { status: status || 200, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer' } });
}
const WEB_VER = '1';

/* ---------- ホームページ ---------- */
async function homePage(env) {
  const c = await webContent(env);
  const tk = await tkConfig(env);
  const S = tkSq(env);
  const open = tk.state === 'on' && S && S.env === 'production';
  let body = wRender(WEB_HOME_HTML, c);
  body = body.replace('<!--PICKUP_TEASER-->', open ? tkTeaser(tk) : '');
  if (!open) body = body.replace(/<a href="\/takeaway">[^<]*(<span>[^<]*<\/span>)?\s*<\/a>/g, '');
  // 予約は LINE の予約ページ（homepage から来たと分かるように）
  const app = appUrl(env, '?src=homepage') || '#visit';
  body = body.replace(/https:\/\/miniapp\.line\.me\/[^"]+/g, wEsc(app)).replace(/<span><a href="\/admin">[^<]*<\/a><\/span>/, '');
  return webPage(webShell('季節をいただく。心を、ほどく。', body, {
    desc: '大阪・昭和町の台灣と薬膳の料理店 épii。季節のランチ、コース料理、養生茶と甘味。',
    script: '<script type="application/json" id="site-content">' + wJson({ journal1Photo: c.journal1Photo, journal1Alt: c.journal1Alt, journal1Caption: c.journal1Caption, journal2Photo: c.journal2Photo, journal2Alt: c.journal2Alt, journal2Caption: c.journal2Caption, journal3Photo: c.journal3Photo, journal3Alt: c.journal3Alt, journal3Caption: c.journal3Caption }) + '</script><script src="/web/home.js?v=' + WEB_VER + '" defer></script>'
  }));
}
function tkTeaser(tk) {
  return '<section class="pickup-teaser section" aria-labelledby="pickup-teaser-title"><div class="pickup-teaser-copy reveal"><p class="overline">TAKE ÉPII HOME</p><h2 id="pickup-teaser-title">' + wEsc(tk.title) + '</h2><p>' + wEsc(tk.description).replace(/\n/g, '<br>') + '</p>' +
    '<a class="text-link" href="/takeaway">店頭受取のご予約 <span class="round-arrow" aria-hidden="true">↗</span></a></div>' +
    (tk.photo ? '<div class="pickup-teaser-image reveal"><img src="' + wEsc(tk.photo) + '" alt="' + wEsc(tk.alt) + '" loading="lazy"></div>' : '') + '</section>';
}

// 同梱の写真・CSS・JS（長くとっておいてよい）と、管理画面から入れた写真
function webAsset(path) {
  if (path === '/web/home.css') return new Response(WEB_HOME_CSS, { headers: { 'content-type': 'text/css; charset=utf-8', 'cache-control': 'public, max-age=3600' } });
  if (path === '/web/home.js') return new Response(WEB_HOME_JS, { headers: { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'public, max-age=3600' } });
  if (path === '/web/takeout.js') return new Response(WEB_TAKEOUT_JS, { headers: { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'public, max-age=3600' } });
  const m = path.match(/^\/web\/img\/([a-z0-9-]+)\.webp$/);
  if (m && WEB_IMAGES[m[1]]) return new Response(Uint8Array.from(atob(WEB_IMAGES[m[1]]), ch => ch.charCodeAt(0)), { headers: { 'content-type': 'image/webp', 'cache-control': 'public, max-age=604800' } });
  return null;
}
async function webMedia(env, id) {
  if (!/^[a-f0-9-]{36}$/.test(id)) return new Response('Not found', { status: 404 });
  await ensureSchema(env);
  const r = await env.DB.prepare('SELECT mime, data FROM web_media WHERE id = ?').bind(id).first();
  if (!r) return new Response('Not found', { status: 404 });
  return new Response(Uint8Array.from(atob(r.data), ch => ch.charCodeAt(0)), { headers: { 'content-type': r.mime, 'cache-control': 'public, max-age=31536000, immutable' } });
}

/* ---------- 管理画面：ホームページ ---------- */
async function adminWeb(env) {
  return { fields: WEB_FIELDS.map(f => ({ key: f.key, label: f.label, group: f.group, type: f.type, max: f.max, alt: f.alt || '', cap: f.cap || '' })), groups: WEB_GROUPS, content: await webContent(env), defaults: WEB_DEFAULTS };
}
async function adminWebSave(env, b) {
  const src = b.content || {};
  const cur = await webContent(env);
  const out = {};
  for (const f of WEB_FIELDS) {
    let v = src[f.key] === undefined ? cur[f.key] : String(src[f.key]);
    v = String(v).replace(/\r/g, '').trim();
    if (v.length > f.max) fail(f.label + 'は' + f.max + '文字以内にしてください。');
    if (f.type === 'image' && !WEB_IMAGE_RE.test(v)) fail(f.label + 'を選び直してください。');
    if (!v && f.type !== 'textarea' && f.type !== 'caption') fail(f.label + 'を入れてください。');
    out[f.key] = v;
  }
  await kvPut(env, 'web', out);
  return await adminWeb(env);
}
// 写真：画面で縮めたもの（JPEG・WebP）を受け取って置く
async function adminWebPhoto(env, b) {
  const m = String(b.image || '').match(/^data:(image\/(?:jpeg|webp|png));base64,([A-Za-z0-9+/=]+)$/);
  if (!m) fail('写真を読み込めませんでした。');
  if (m[2].length > 1600000) fail('写真が大きすぎます。');
  const id = crypto.randomUUID();
  await env.DB.prepare('INSERT INTO web_media (id, mime, data, created_at) VALUES (?, ?, ?, ?)').bind(id, m[1], m[2], jstStamp(Date.now())).run();
  return { url: '/media/' + id };
}

/* ---------- テイクアウトの設定 ---------- */
const TK_DEFAULT = {
  state: 'off', title: '季節のオードブルセット', description: '季節の料理を囲む、ちょっと特別な食卓。\népiiの味わいを、ご自宅でゆっくり楽しむひと箱に。',
  price: 0, servings: '', contents: '', photo: '/web/img/plate.webp', alt: 'épiiの季節の料理', photoNote: '写真はイメージです。',
  hours: '', allergens: '', care: '', cancellation: '', cutoff: { days: 1, time: '18:00' }, maxPerOrder: 5, slots: []
};
async function tkConfig(env) { return Object.assign({}, TK_DEFAULT, (await kvGet(env, 'takeout')) || {}); }
// Squareの決済のつなぎ先。テスト（Sandbox）か本番か
function tkSq(env) {
  const name = env.TAKEOUT_SQUARE_ENVIRONMENT === 'production' ? 'production' : 'sandbox';
  const token = env.TAKEOUT_SQUARE_ACCESS_TOKEN || (name === 'production' ? env.SQUARE_ACCESS_TOKEN : '');
  if (!token) return null;
  return { env: name, token: token, sig: env.TAKEOUT_SQUARE_WEBHOOK_SIGNATURE_KEY || '', loc: env.TAKEOUT_SQUARE_LOCATION_ID || '',
    base: env.TAKEOUT_SQUARE_API_BASE || (name === 'production' ? 'https://connect.squareup.com' : 'https://connect.squareupsandbox.com') };
}
async function tkCall(S, path, method, body) {
  let res;
  try {
    res = await fetch(S.base + path, { method: method || 'GET', headers: { authorization: 'Bearer ' + S.token, 'square-version': SQ_VERSION, 'content-type': 'application/json', accept: 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  } catch (e) { fail('Squareにつながりませんでした。少し待ってからお試しください。', 502, 'TK_NET'); }
  const j = await res.json().catch(() => ({}));
  if (!res.ok) {
    console.error('Square takeout', method || 'GET', path, res.status, JSON.stringify(j).slice(0, 300));
    const e = new Error('Squareでエラーになりました（' + ((j.errors && j.errors[0] && (j.errors[0].detail || j.errors[0].code)) || res.status) + '）。');
    e.userFacing = true; e.status = 502; e.code = 'TK_SQ'; e.sqStatus = res.status;
    throw e;
  }
  return j;
}
// お店（ロケーション）：変数で決めていなければ、カード決済ができる最初のお店を使う
async function tkLocation(env, S) {
  if (S.loc) return S.loc;
  const hit = await kvGet(env, 'tkLoc:' + S.env);
  if (hit && hit.id) return hit.id;
  const j = await tkCall(S, '/v2/locations');
  const loc = (j.locations || []).find(l => l.status === 'ACTIVE' && (l.capabilities || []).indexOf('CREDIT_CARD_PROCESSING') >= 0) || (j.locations || [])[0];
  if (!loc) fail('Squareのお店（ロケーション）が見つかりませんでした。');
  await kvPut(env, 'tkLoc:' + S.env, { id: loc.id, name: loc.name || '' });
  return loc.id;
}
const TK_HOLD = "('creating','pending','paid','review','picked')";
function tkDeadline(cfg, slot) { return addDays(slot.d, -Number(cfg.cutoff.days || 0)) + ' ' + (cfg.cutoff.time || '23:59'); }
// 受取枠と残り（いまの決済のつなぎ先の注文だけ数える。テストの注文は本番の枠を減らさない）
async function tkSlots(env, cfg, envName, now) {
  const stamp = jstStamp(now || Date.now());
  const used = {};
  (await env.DB.prepare('SELECT slot_date, slot_time, SUM(quantity) AS n FROM web_orders WHERE status IN ' + TK_HOLD + ' AND env = ? GROUP BY slot_date, slot_time').bind(envName).all()).results
    .forEach(r => { used[r.slot_date + ' ' + r.slot_time] = Number(r.n) || 0; });
  return (cfg.slots || []).filter(s => tkDeadline(cfg, s) > stamp)
    .map(s => ({ date: s.d, time: s.t, cap: s.cap, left: Math.max(0, s.cap - (used[s.d + ' ' + s.t] || 0)), until: tkDeadline(cfg, s) }))
    .sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time));
}
// いま、お客様が注文できるか（本番の決済で「受け付ける」のときだけ。テストの注文は管理画面のテスト用リンクから）
function tkPublicOpen(cfg, S) { return cfg.state === 'on' && !!S && S.env === 'production' && cfg.price > 0; }
async function tkTestOk(env, t) { const p = t ? await verifyToken(env, t) : null; return !!(p && p.k === 'tk'); }

/* ---------- お客様のページ ---------- */
function tkHeader() { return '<header class="pickup-header"><a class="order-wordmark" href="/home">épii <span>台灣と薬膳</span></a><a href="/home">ホームページへ ↗</a></header>'; }
async function takeawayPage(env, url) {
  const cfg = await tkConfig(env);
  const S = tkSq(env);
  const test = url.searchParams.get('test') || '';
  const testOk = await tkTestOk(env, test);
  const open = tkPublicOpen(cfg, S) || (testOk && !!S && cfg.price > 0);
  let body = tkHeader() + '<main class="pickup-page"><div class="pickup-intro"><p class="overline">TAKE ÉPII HOME</p><h1>おいしい時間を、<br>おうちにも。</h1><p>季節の料理を囲んで、心ほどける食卓を。</p></div>';
  if (testOk) body += '<aside class="pickup-sample"><span>管理者のテスト' + (S && S.env === 'sandbox' ? '（Sandbox：実際には引き落とされません）' : '（本番の決済です）') + '</span><p>この画面は、管理画面のテスト用リンクから開いたときだけ注文できます。</p></aside>';
  if (cfg.state === 'off' && !testOk) return webPage(webShell('店頭受取', body + '<section class="pickup-empty"><h2>次の季節の便りを、お待ちください。</h2><p>現在、店頭受取の受付はお休みしています。</p><a class="text-link" href="/home">ホームページへ ↗</a></section></main>', { noindex: true }));
  const slots = open ? await tkSlots(env, cfg, S.env) : [];
  body += '<section class="pickup-product"><div class="pickup-product-image"><img src="' + wEsc(cfg.photo) + '" alt="' + wEsc(cfg.alt) + '">' + (cfg.photoNote ? '<p>' + wEsc(cfg.photoNote) + '</p>' : '') + '</div><div class="pickup-product-info"><span class="pickup-badge">店頭受取・事前決済のみ</span><h2>' + wEsc(cfg.title) + '</h2>' +
    (cfg.servings ? '<p class="pickup-servings">' + wEsc(cfg.servings) + '</p>' : '') + '<p class="pickup-price">' + (cfg.price > 0 ? '¥' + Number(cfg.price).toLocaleString('ja-JP') + '<small>（税込）／1セット</small>' : '価格は決まり次第ご案内') + '</p>' +
    '<p class="pickup-description">' + wEsc(cfg.description).replace(/\n/g, '<br>') + '</p><dl class="pickup-facts">' + (cfg.hours ? '<div><dt>受取時間</dt><dd>' + wEsc(cfg.hours).replace(/\n/g, '<br>') + '</dd></div>' : '') +
    '<div><dt>受付の締切</dt><dd>受取日の' + (Number(cfg.cutoff.days) ? cfg.cutoff.days + '日前の' : '当日') + wEsc(cfg.cutoff.time) + 'まで</dd></div><div><dt>お渡し場所</dt><dd>épii 店頭（大阪市阿倍野区昭和町1-16-20）</dd></div></dl></div></section>';
  body += '<div class="pickup-details-grid">' + (cfg.contents ? '<section><p class="overline">IN THE BOX</p><h2>ひと箱のなかに。</h2><p class="pickup-prose">' + wEsc(cfg.contents).replace(/\n/g, '<br>') + '</p></section>' : '') +
    '<section><h2>お召し上がりの前に。</h2>' + (cfg.allergens ? '<h3>原材料・アレルギー</h3><p class="pickup-prose">' + wEsc(cfg.allergens).replace(/\n/g, '<br>') + '</p>' : '') + (cfg.care ? '<h3>持ち帰り・保存</h3><p class="pickup-prose">' + wEsc(cfg.care).replace(/\n/g, '<br>') + '</p>' : '') +
    (cfg.cancellation ? '<h3>変更・キャンセル</h3><p class="pickup-prose">' + wEsc(cfg.cancellation).replace(/\n/g, '<br>') + '</p>' : '') + '</section></div>';
  if (!open) body += '<section class="pickup-empty"><h2>ただいま、受付の準備中です。</h2><p>受付を始めたら、ホームページとInstagramでお知らせします。</p></section>';
  else body += '<section class="checkout-page" id="order"><p class="overline">A LITTLE FEAST, RESERVED FOR YOU.</p><h2 class="checkout-title">受取の日時を選ぶ</h2><div id="checkout-root"><p>受取日の一覧を準備しています…</p></div><noscript>ご注文にはJavaScriptを有効にしてください。</noscript></section>';
  const boot = { page: 'order', test: testOk ? test : '', product: { title: cfg.title, price: Number(cfg.price) || 0, max: Number(cfg.maxPerOrder) || 5, allergens: cfg.allergens, cancellation: cfg.cancellation }, slots: slots };
  return webPage(webShell('店頭受取のご予約', body + '</main>', { noindex: testOk, desc: cfg.title + '｜épiiの店頭受取', script: open ? '<script type="application/json" id="checkout-data">' + wJson(boot) + '</script><script src="/web/takeout.js?v=' + WEB_VER + '" defer></script>' : '' }));
}
function takeawayDonePage() {
  return webPage(webShell('ご注文・お支払いの確認', tkHeader() + '<main class="pickup-page checkout-page"><div id="checkout-root"><p>お支払いを確認しています…</p></div></main>', { noindex: true,
    script: '<script type="application/json" id="checkout-data">{"page":"status"}</script><script src="/web/takeout.js?v=' + WEB_VER + '" defer></script>' }));
}

/* ---------- お客様のAPI（注文・状況・取り消し） ---------- */
async function tkHash(v) { const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(v))); return [...new Uint8Array(d)].map(x => x.toString(16).padStart(2, '0')).join(''); }
function tkPublic(r) {
  return { id: r.id.slice(0, 8), status: r.status, title: r.title, date: r.slot_date, time: r.slot_time, quantity: r.quantity, amount: r.amount, name: r.name, test: !!r.test, env: r.env,
    payUrl: r.status === 'pending' && Date.now() < r.expires_at ? r.link_url : '', expiresAt: r.expires_at };
}
async function tkLimit(env, request) {
  const ip = request.headers.get('cf-connecting-ip') || 'unknown';
  const k = 'tkrl:' + (await tkHash(ip + ':' + Math.floor(Date.now() / 900000))).slice(0, 24);
  const cur = (await kvGet(env, k)) || { n: 0 };
  if (cur.n >= 20) fail('少し時間をおいてから、もう一度お試しください。', 429);
  await kvPut(env, k, { n: cur.n + 1 });
}
async function takeawayApi(name, body, request, env, url) {
  const S = tkSq(env);
  if (name === 'order') {
    await tkLimit(env, request);
    const cfg = await tkConfig(env);
    const test = await tkTestOk(env, body.test);
    if (!S) fail('ただいま、注文を受け付けていません。', 409);
    if (!(tkPublicOpen(cfg, S) || (test && cfg.price > 0))) fail('ただいま、注文を受け付けていません。', 409);
    const token = String(body.token || '');
    if (!/^[a-f0-9]{64}$/.test(token)) fail('画面を開き直してください。');
    const th = await tkHash(token);
    const prev = await env.DB.prepare('SELECT * FROM web_orders WHERE token_hash = ?').bind(th).first();
    if (prev) return { order: tkPublic(await tkEnsureLink(env, S, prev, url.origin, token)) };
    const date = String(body.date || ''), time = String(body.time || '');
    const qty = Math.round(Number(body.quantity) || 0);
    const name = clean(body.name, 60), email = clean(body.email, 120), phone = String(body.phone || '').replace(/[^\d+\-() ]/g, '').slice(0, 20);
    if (!isDate(date) || !isTime(time)) fail('受取日と受取時間を選んでください。');
    if (!name) fail('お名前を入れてください。');
    if (!/^\S+@[^\s@]+\.[^\s@]+$/.test(email)) fail('メールアドレスを確かめてください（お支払いの控えが届きます）。');
    if (phone.replace(/\D/g, '').length < 8) fail('つながる電話番号を入れてください。');
    if (body.agreed !== true) fail('ご案内を確かめて、チェックを入れてください。');
    const slots = await tkSlots(env, cfg, S.env);
    const slot = slots.find(s => s.date === date && s.time === time);
    if (!slot) fail('この受取日時は選べません。別の日時を選んでください。');
    const max = Math.min(Number(cfg.maxPerOrder) || 5, slot.left);
    if (!(qty >= 1 && qty <= max)) fail(slot.left ? '数量は' + max + 'セットまでです。' : 'この時間は満枠になりました。別の時間を選んでください。');
    await tkReconcile(env, 3).catch(e => console.error('テイクアウトの照合', e && e.message));
    const id = crypto.randomUUID();
    const now = Date.now();
    const loc = await tkLocation(env, S);
    // 枠の残りの確認と仮押さえを、1つの命令でまとめて行う（同時に押されても売りすぎない）
    const ins = await env.DB.prepare('INSERT INTO web_orders (id, token_hash, status, slot_date, slot_time, quantity, amount, title, name, email, phone, env, test, location_id, created_at, expires_at, updated_at) ' +
      "SELECT ?, ?, 'creating', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE COALESCE((SELECT SUM(quantity) FROM web_orders WHERE slot_date = ? AND slot_time = ? AND env = ? AND status IN " + TK_HOLD + '), 0) + ? <= ?')
      .bind(id, th, date, time, qty, qty * Number(cfg.price), cfg.title, name, email, phone, S.env, test ? 1 : 0, loc, now, now + 15 * 60000, now, date, time, S.env, qty, slot.cap).run();
    if (!ins.meta || ins.meta.changes !== 1) fail('この時間は満枠になりました。別の時間を選んでください。', 409);
    const row = await env.DB.prepare('SELECT * FROM web_orders WHERE id = ?').bind(id).first();
    return { order: tkPublic(await tkEnsureLink(env, S, row, url.origin, token, cfg)) };
  }
  if (name === 'status' || name === 'cancel') {
    const token = String(body.token || '');
    if (!/^[a-f0-9]{64}$/.test(token)) fail('ご注文が見つかりません。');
    let row = await env.DB.prepare('SELECT * FROM web_orders WHERE token_hash = ?').bind(await tkHash(token)).first();
    if (!row) fail('ご注文が見つかりません。', 404);
    if (S && row.env === S.env) row = await tkCheck(env, S, row, name === 'cancel');
    return { order: tkPublic(row) };
  }
  fail('不明な操作です。', 404);
}
// Squareのお支払いリンクを作る（同じ注文IDで何度呼んでも1つだけ）
async function tkEnsureLink(env, S, row, origin, token, cfg) {
  if (row.link_url || row.status !== 'creating') return row;
  cfg = cfg || await tkConfig(env);
  const note = '店頭受取 ' + row.slot_date + ' ' + row.slot_time;
  let link;
  try {
    const j = await tkCall(S, '/v2/online-checkout/payment-links', 'POST', {
      idempotency_key: row.id,
      order: { location_id: row.location_id, reference_id: row.id.slice(0, 40), line_items: [{ name: row.title, quantity: String(row.quantity), base_price_money: { amount: Math.round(row.amount / row.quantity), currency: 'JPY' }, note: note }] },
      checkout_options: { redirect_url: origin + '/takeaway/done#' + token, ask_for_shipping_address: false, allow_tipping: false, accepted_payment_methods: { apple_pay: true, google_pay: true } },
      pre_populated_data: { buyer_email: row.email },
      payment_note: 'épii ' + note + ' ' + row.id.slice(0, 8)
    });
    link = j.payment_link;
    if (!link || !link.url || !link.order_id) throw new Error('リンクが返ってきませんでした');
  } catch (e) {
    await env.DB.prepare("UPDATE web_orders SET status = 'failed', updated_at = ? WHERE id = ? AND status = 'creating'").bind(Date.now(), row.id).run();
    if (e.userFacing) throw e;
    fail('Squareのお支払い画面を作れませんでした。少し待ってからお試しください。', 502);
  }
  await env.DB.prepare("UPDATE web_orders SET status = 'pending', link_id = ?, link_url = ?, sq_order_id = ?, updated_at = ? WHERE id = ? AND status = 'creating'").bind(link.id, link.url, link.order_id, Date.now(), row.id).run();
  return await env.DB.prepare('SELECT * FROM web_orders WHERE id = ?').bind(row.id).first();
}
// Squareで支払いが完了したか確かめる。期限切れ・取り消しは、Squareのリンクを止めてから枠を戻す
async function tkCheck(env, S, row, cancel) {
  if (['expired', 'cancelled', 'failed'].indexOf(row.status) >= 0 || !row.sq_order_id) return row;
  const order = (await tkCall(S, '/v2/orders/' + encodeURIComponent(row.sq_order_id))).order || {};
  let paid = null, unsettled = false;
  for (const t of order.tenders || []) {
    if (!t.payment_id) continue;
    const p = (await tkCall(S, '/v2/payments/' + encodeURIComponent(t.payment_id))).payment || {};
    if (p.status === 'COMPLETED') paid = p; else if (['FAILED', 'CANCELED'].indexOf(p.status) < 0) unsettled = true;
  }
  if (paid) return await tkApplyPaid(env, row, paid);
  if (row.status !== 'pending' || unsettled) return row;
  if (!cancel && Date.now() < row.expires_at) return row;
  try { if (row.link_id) await tkCall(S, '/v2/online-checkout/payment-links/' + encodeURIComponent(row.link_id), 'DELETE'); }
  catch (e) { if (e.sqStatus !== 404) throw e; }
  await env.DB.prepare("UPDATE web_orders SET status = ?, updated_at = ? WHERE id = ? AND status = 'pending'").bind(cancel ? 'cancelled' : 'expired', Date.now(), row.id).run();
  return await env.DB.prepare('SELECT * FROM web_orders WHERE id = ?').bind(row.id).first();
}
async function tkApplyPaid(env, row, p) {
  const amountOk = p.amount_money && p.amount_money.amount === row.amount && p.amount_money.currency === 'JPY' && !(p.refunded_money && p.refunded_money.amount);
  const next = row.status === 'picked' ? 'picked' : amountOk && ['pending', 'paid', 'creating'].indexOf(row.status) >= 0 ? 'paid' : 'review';
  await env.DB.prepare('UPDATE web_orders SET status = ?, payment_id = COALESCE(payment_id, ?), updated_at = ? WHERE id = ?').bind(next, p.id, Date.now(), row.id).run();
  const r = await env.DB.prepare('SELECT * FROM web_orders WHERE id = ?').bind(row.id).first();
  if (!r.notified && (next === 'paid' || next === 'review')) {
    await env.DB.prepare('UPDATE web_orders SET notified = 1 WHERE id = ?').bind(r.id).run();
    await pushOwner(env, (r.test ? '【テスト】' : '') + '【テイクアウトのご注文】\n' + jd(r.slot_date) + ' ' + r.slot_time + ' 受取\n' + r.title + ' ' + r.quantity + 'セット　¥' + r.amount.toLocaleString() + '\n' + r.name + ' 様' + (next === 'review' ? '\n※金額が合わないので、Squareで確かめてください' : '')).catch(() => {});
  }
  return r;
}
// 定期処理：支払い待ちのまま期限が過ぎたものを確かめる
async function tkReconcile(env, limit) {
  const S = tkSq(env);
  if (!S) return 0;
  const rows = (await env.DB.prepare("SELECT * FROM web_orders WHERE status IN ('creating','pending') AND env = ? AND (expires_at <= ? OR created_at <= ?) ORDER BY expires_at LIMIT ?").bind(S.env, Date.now(), Date.now() - 5 * 60000, limit || 5).all()).results;
  let n = 0;
  for (const r of rows) {
    try {
      if (r.status === 'creating' && r.expires_at <= Date.now()) { await env.DB.prepare("UPDATE web_orders SET status = 'failed', updated_at = ? WHERE id = ? AND status = 'creating'").bind(Date.now(), r.id).run(); n++; continue; }
      const x = await tkCheck(env, S, r, false); if (x.status !== r.status) n++;
    } catch (e) { console.error('テイクアウトの照合', e && e.message); }
  }
  return n;
}
// Squareからの知らせ（Webhook）。署名を確かめてから、その注文の支払いをSquareに聞き直す
async function squareWebhook(request, env, url) {
  const S = tkSq(env);
  const raw = await request.text();
  if (!S || !S.sig) return json({ ok: false }, 400);
  const sig = request.headers.get('x-square-hmacsha256-signature') || '';
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(S.sig), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(url.origin + url.pathname + raw)))));
  if (!sig || !(await safeEqual(env, mac, sig))) return json({ ok: false }, 401);
  let ev = {};
  try { ev = JSON.parse(raw); } catch (e) { return json({ ok: false }, 400); }
  const p = ev.data && ev.data.object && ev.data.object.payment;
  if (p && p.order_id) {
    await ensureSchema(env);
    const row = await env.DB.prepare('SELECT * FROM web_orders WHERE sq_order_id = ? AND env = ?').bind(p.order_id, S.env).first();
    if (row) await tkCheck(env, S, row, false);
  }
  return json({ ok: true });
}

/* ---------- 管理画面：テイクアウト ---------- */
async function adminTakeout(env) {
  const cfg = await tkConfig(env);
  const S = tkSq(env);
  const today = jstStamp(Date.now()).slice(0, 10);
  const orders = (await env.DB.prepare("SELECT * FROM web_orders WHERE status IN ('paid','review','picked','pending') AND slot_date >= ? ORDER BY slot_date, slot_time, created_at LIMIT 200").bind(addDays(today, -7)).all()).results;
  let loc = '';
  if (S) { try { loc = (await kvGet(env, 'tkLoc:' + S.env) || {}).name || S.loc; } catch (e) { /* なくてもよい */ } }
  return {
    cfg: cfg, sq: S ? { env: S.env, webhook: !!S.sig, location: loc } : null,
    open: tkPublicOpen(cfg, S),
    slots: S ? await tkSlots(env, cfg, S.env) : [],
    orders: orders.map(r => ({ id: r.id, status: r.status, date: r.slot_date, time: r.slot_time, quantity: r.quantity, amount: r.amount, title: r.title, name: r.name, phone: r.phone, email: r.email, test: !!r.test, env: r.env, picked: r.picked_at || '' })),
    webhookUrl: '/api/square/webhook'
  };
}
async function adminTakeoutSave(env, b) {
  const c = b.cfg || {};
  const cur = await tkConfig(env);
  const t = (v, n) => String(v === undefined ? '' : v).replace(/\r/g, '').trim().slice(0, n);
  const out = {
    state: ['off', 'test', 'on'].indexOf(c.state) >= 0 ? c.state : cur.state,
    title: t(c.title, 80) || cur.title, description: t(c.description, 700), price: Math.max(0, Math.min(999999, Math.round(Number(c.price) || 0))),
    servings: t(c.servings, 80), contents: t(c.contents, 1000), photo: WEB_IMAGE_RE.test(String(c.photo || '')) ? c.photo : cur.photo, alt: t(c.alt, 150), photoNote: t(c.photoNote, 200),
    hours: t(c.hours, 180), allergens: t(c.allergens, 700), care: t(c.care, 500), cancellation: t(c.cancellation, 700),
    cutoff: { days: Math.max(0, Math.min(14, Math.round(Number(c.cutoff && c.cutoff.days) || 0))), time: isTime(c.cutoff && c.cutoff.time) ? c.cutoff.time : '18:00' },
    maxPerOrder: Math.max(1, Math.min(20, Math.round(Number(c.maxPerOrder) || 5))),
    slots: []
  };
  const seen = {};
  (Array.isArray(c.slots) ? c.slots : []).slice(0, 300).forEach(s => {
    if (!isDate(s.d) || !isTime(s.t)) return;
    const cap = Math.round(Number(s.cap) || 0);
    if (cap < 1 || cap > 999 || seen[s.d + s.t]) return;
    seen[s.d + s.t] = 1; out.slots.push({ d: s.d, t: s.t, cap: cap });
  });
  out.slots.sort((a, x) => (a.d + a.t).localeCompare(x.d + x.t));
  if (out.state === 'on') {
    const miss = [];
    if (!(out.price > 0)) miss.push('価格');
    if (!out.slots.length) miss.push('受取枠');
    if (!out.cancellation) miss.push('変更・キャンセルのご案内');
    if (!out.allergens) miss.push('原材料・アレルギー');
    if (miss.length) fail('受け付けるには、次を入れてください：' + miss.join('・'));
  }
  await kvPut(env, 'takeout', out);
  return await adminTakeout(env);
}
async function adminTakeoutPick(env, b) {
  await env.DB.prepare("UPDATE web_orders SET status = CASE WHEN ? = 1 THEN 'picked' ELSE 'paid' END, picked_at = CASE WHEN ? = 1 THEN ? ELSE NULL END, updated_at = ? WHERE id = ? AND status IN ('paid','picked')")
    .bind(b.picked ? 1 : 0, b.picked ? 1 : 0, jstStamp(Date.now()), Date.now(), String(b.id || '')).run();
  return await adminTakeout(env);
}
// テスト用のリンク（24時間だけ使える）
async function adminTakeoutTest(env, b) {
  const t = await signToken(env, { k: 'tk', e: Date.now() + 86400000 });
  return { url: String(b.origin || '') + '/takeaway?test=' + encodeURIComponent(t) };
}
// 今日の画面：今日と明日のお持ち帰り
async function takeoutToday(env) {
  const S = tkSq(env);
  if (!S) return [];
  const today = jstStamp(Date.now()).slice(0, 10);
  return (await env.DB.prepare("SELECT id, status, slot_date, slot_time, quantity, title, name, phone, test FROM web_orders WHERE status IN ('paid','review','picked') AND env = ? AND slot_date BETWEEN ? AND ? ORDER BY slot_date, slot_time").bind(S.env, today, addDays(today, 1)).all()).results
    .map(r => ({ id: r.id, status: r.status, date: r.slot_date, time: r.slot_time, quantity: r.quantity, title: r.title, name: r.name, phone: r.phone, test: !!r.test }));
}
