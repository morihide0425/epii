/**
 * épii 予約システム（Cloudflare Workers）
 *
 * お店の営業時間・席数・受付ルール・メニューは、すべて管理画面から変更できます。
 * このファイルで書き換えるのは、すぐ下の「お店の情報」だけです。
 */

// ===== お店の情報 =====
const SHOP = {
  name: 'épii',
  tel: '050-1720-7788',
  zip: '〒545-0011',
  address: '大阪府大阪市阿倍野区 1-16-20',
  building: '第三昭和町マンション1階',
  mapQuery: '大阪府大阪市阿倍野区 1-16-20 第三昭和町マンション',
  // 「地図を開く」で開くURL（Googleマップの共有リンク）
  mapUrl: 'https://maps.app.goo.gl/i5j9bDBUab8Fkuxc6',
  access: [
    ['御堂筋線 昭和町駅', '3番出口から徒歩1分'],
    ['谷町線 文の里駅', '7番出口から文の里商店街を通って徒歩6分']
  ],
  // LINEミニアプリの場合は 'https://miniapp.line.me/'、LINEログインのLIFFの場合は 'https://liff.line.me/'
  appUrlBase: 'https://miniapp.line.me/'
};
// ===== ここまで =====

/*__SHARED_CODE__*/

const DEFAULT_SESSION_NAME = { morning: 'モーニング', lunch: 'ランチ', dinner: 'ディナー' };
const WD = '日月火水木金土';
const ALL_WEEK = [0, 1, 2, 3, 4, 5, 6];

const DEFAULT_SETTINGS = {
  seats: 16,
  maxGuests: 6,
  aheadDays: 60,
  openUntil: '',
  cancelDays: 1,
  replyHint: '24時間以内',
  remindHours: 12,
  maxActive: 3,
  cutoff: { days: 2, time: '23:59' },
  changeCutoff: { days: 2, time: '23:59' },
  weekly: {
    0: ['morning', 'lunch', 'dinner'], 1: [], 2: [],
    3: ['morning', 'lunch', 'dinner'], 4: ['morning', 'lunch', 'dinner'],
    5: ['morning', 'lunch', 'dinner'], 6: ['morning', 'lunch', 'dinner']
  },
  sessions: {
    morning: { name: 'モーニング', en: '', short: '朝', open: '08:00', close: '11:00', first: '08:30', last: '09:30', interval: 30, stay: 90 },
    lunch: { name: 'ランチ', en: '', short: '昼', open: '11:30', close: '15:00', first: '11:30', last: '13:00', interval: 30, stay: 90 },
    dinner: { name: 'ディナー', en: '', short: '夜', open: '18:00', close: '22:00', first: '18:00', last: '19:30', interval: 30, stay: 150 }
  }
};

const ST = { WAIT: '返事待ち', OFFER: '提案中', OK: '確定', NG: 'お断り', CANCEL: 'キャンセル', WITHDRAW: '取り下げ' };
const HOLDING_SQL = "('返事待ち','提案中','確定')";
const CHG = { WAIT: '返事待ち', OK: '承認', NG: 'お断り', WITHDRAW: '取り下げ' };

const SCHEMA = [
  'CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT NOT NULL)',
  'CREATE TABLE IF NOT EXISTS reservations (id TEXT PRIMARY KEY, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, status TEXT NOT NULL, date TEXT NOT NULL, time TEXT NOT NULL, session TEXT NOT NULL, guests INTEGER NOT NULL, name TEXT NOT NULL, phone TEXT, course_id TEXT, course_name TEXT, note TEXT, alt_date TEXT, alt_time TEXT, offer_date TEXT, offer_time TEXT, hold_date TEXT NOT NULL, hold_time TEXT NOT NULL, hold_session TEXT NOT NULL, source TEXT, user_id TEXT, line_name TEXT, reminded_at TEXT, memo TEXT, arrived TEXT, stay INTEGER)',
  'CREATE INDEX IF NOT EXISTS idx_res_hold ON reservations (hold_date, status)',
  'CREATE INDEX IF NOT EXISTS idx_res_user ON reservations (user_id, hold_date)',
  'CREATE INDEX IF NOT EXISTS idx_res_status ON reservations (status, created_at)',
  'CREATE TABLE IF NOT EXISTS courses (id TEXT PRIMARY KEY, sort INTEGER NOT NULL, visible INTEGER NOT NULL, name TEXT NOT NULL, price INTEGER NOT NULL, price_type TEXT NOT NULL, description TEXT, sessions TEXT NOT NULL, weekdays TEXT NOT NULL, min_guests INTEGER NOT NULL, cutoff_mode TEXT NOT NULL, cutoff_days INTEGER NOT NULL, cutoff_time TEXT NOT NULL, chg_mode TEXT NOT NULL DEFAULT \'default\', chg_days INTEGER NOT NULL DEFAULT 2, chg_time TEXT NOT NULL DEFAULT \'23:59\', cap INTEGER)',
  'CREATE TABLE IF NOT EXISTS day_rules (date TEXT PRIMARY KEY, kind TEXT NOT NULL, sessions TEXT NOT NULL)',
  'CREATE TABLE IF NOT EXISTS blocks (id TEXT PRIMARY KEY, date TEXT NOT NULL, type TEXT NOT NULL, start TEXT NOT NULL, end TEXT NOT NULL, seats INTEGER, memo TEXT, created_at TEXT NOT NULL)',
  'CREATE INDEX IF NOT EXISTS idx_blocks_date ON blocks (date)',
  'CREATE TABLE IF NOT EXISTS login_fail (ip TEXT PRIMARY KEY, count INTEGER NOT NULL, until INTEGER NOT NULL)'
].concat(CHANGE_SCHEMA()).concat(CUSTOMER_SCHEMA()).concat(EVENT_SCHEMA()).concat(IG_SCHEMA()).concat(MONEY_SCHEMA_SQL());

// 売上・経費とClaudeの下書き（あとから追加した表）
function MONEY_SCHEMA_SQL() {
  return [
    'CREATE TABLE IF NOT EXISTS ai_cache (k TEXT PRIMARY KEY, src TEXT, v TEXT NOT NULL, at TEXT NOT NULL)',
    "CREATE TABLE IF NOT EXISTS sq_payments (id TEXT PRIMARY KEY, ts TEXT NOT NULL, date TEXT NOT NULL, amount INTEGER NOT NULL, refunded INTEGER NOT NULL DEFAULT 0, tip INTEGER NOT NULL DEFAULT 0, method TEXT, status TEXT, link TEXT NOT NULL DEFAULT '', res_id TEXT, cust_key TEXT, updated_at TEXT)",
    'CREATE INDEX IF NOT EXISTS idx_sq_date ON sq_payments (date)',
    'CREATE TABLE IF NOT EXISTS receipts (id TEXT PRIMARY KEY, created_at TEXT NOT NULL, date TEXT NOT NULL, amount INTEGER NOT NULL, payee TEXT, account TEXT, tax TEXT, method TEXT, memo TEXT, journal_id TEXT, status TEXT NOT NULL, data TEXT)',
    'CREATE INDEX IF NOT EXISTS idx_receipts_at ON receipts (created_at)'
  ].concat(MF_SCHEMA_SQL());
}
// マネーフォワードの経費の仕訳（月ごとに取り込む）と、口座の明細を待っているレシートの写真（あとから追加した表）
function MF_SCHEMA_SQL() {
  return [
    'CREATE TABLE IF NOT EXISTS mf_lines (jid TEXT, date TEXT NOT NULL, ym TEXT NOT NULL, account TEXT NOT NULL, value INTEGER NOT NULL, remark TEXT)',
    'CREATE INDEX IF NOT EXISTS idx_mf_lines_ym ON mf_lines (ym)',
    'CREATE TABLE IF NOT EXISTS receipt_photos (id TEXT PRIMARY KEY, img TEXT NOT NULL)'
  ];
}

// Instagramの数値（あとから追加した表）
function IG_SCHEMA() {
  return [
    'CREATE TABLE IF NOT EXISTS ig_daily (date TEXT PRIMARY KEY, followers INTEGER, reach INTEGER, views INTEGER, profile_views INTEGER, engaged INTEGER, interactions INTEGER, link_taps INTEGER, updated_at TEXT)',
    'CREATE TABLE IF NOT EXISTS ig_media (id TEXT PRIMARY KEY, kind TEXT, ts TEXT, date TEXT, caption TEXT, permalink TEXT, reach INTEGER, views INTEGER, likes INTEGER, comments INTEGER, saves INTEGER, shares INTEGER, interactions INTEGER, updated_at TEXT)'
  ];
}

// 予約ページの利用状況（あとから追加した表）
function EVENT_SCHEMA() {
  return [
    'CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT NOT NULL, date TEXT NOT NULL, user_id TEXT, sid TEXT, kind TEXT NOT NULL, t_date TEXT, t_time TEXT, course_id TEXT, src TEXT, extra TEXT)',
    'CREATE INDEX IF NOT EXISTS idx_events_date ON events (date, kind)',
    'CREATE INDEX IF NOT EXISTS idx_events_user ON events (user_id, date)'
  ];
}

// お客様メモ（あとから追加した表）
function CUSTOMER_SCHEMA() {
  return [
    'CREATE TABLE IF NOT EXISTS customers (phone TEXT PRIMARY KEY, memo TEXT, updated_at TEXT NOT NULL, name TEXT, tel TEXT, extra_visits INTEGER NOT NULL DEFAULT 0, merged_into TEXT, created_at TEXT)'
  ];
}

// 予約の変更リクエスト（あとから追加した表）
function CHANGE_SCHEMA() {
  return [
    'CREATE TABLE IF NOT EXISTS change_requests (id TEXT PRIMARY KEY, res_id TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, status TEXT NOT NULL, date TEXT NOT NULL, time TEXT NOT NULL, session TEXT NOT NULL, guests INTEGER NOT NULL, course_id TEXT, course_name TEXT, user_id TEXT, reminded_at TEXT)',
    'CREATE INDEX IF NOT EXISTS idx_chg_status ON change_requests (status, created_at)',
    'CREATE INDEX IF NOT EXISTS idx_chg_res ON change_requests (res_id, status)',
    'CREATE INDEX IF NOT EXISTS idx_chg_date ON change_requests (date, status)'
  ];
}

const SEED_COURSES = [
  ['モーニング', 2500, 'fixed', '薬膳粥と季節の小鉢', 'morning', 1, 'custom', 3, '23:59', 'default', 2, '23:59'],
  ['養生ランチ', 4800, 'fixed', '季節の薬膳スープと魚料理、デザート', 'lunch', 1, 'custom', 0, '10:00', 'custom', 1, '23:59'],
  ['季節の薬膳フレンチ', 9800, 'fixed', '前菜から甘味まで全7皿', 'dinner', 1, 'default', 2, '23:59', 'default', 2, '23:59'],
  ['シェフおまかせ', 14000, 'from', '全9皿・薬膳酒のペアリング付き', 'dinner', 2, 'default', 2, '23:59', 'default', 2, '23:59']
];
const SCHEMA_VERSION = 10;

let schemaReady = false;

/* =========================================================
 * 入口
 * ========================================================= */

export default {
  async fetch(request, env, ctx) {
    try {
      return await route(request, env, ctx);
    } catch (err) {
      if (err && err.userFacing) return json({ ok: false, message: err.message, code: err.code || '' }, err.status || 400);
      console.error(err && err.stack ? err.stack : err);
      return json({ ok: false, message: '処理中に問題が起きました。時間をおいてもう一度お試しください。' }, 500);
    }
  },
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runSchedule(env));
  }
};

async function route(request, env, ctx) {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, '') || '/';
  checkEnv(env);

  if (request.method === 'GET') {
    if (path === '/') return html(renderPage(CUSTOMER_HTML, env));
    if (path === '/admin') return html(renderPage(ADMIN_HTML, env), true);
    if (path === '/logo.webp') return logo();
    const iconMatch = path.match(/^\/icon-(32|180|192|512)\.png$/);
    if (iconMatch) return pngIcon(iconMatch[1]);
    if (path === '/favicon.ico') return pngIcon('32');
    if (path === '/apple-touch-icon.png') return pngIcon('180');
    if (path === '/admin.webmanifest') return manifest('admin');
    if (path === '/app.webmanifest') return manifest('app');
    return new Response('Not found', { status: 404 });
  }
  if (request.method !== 'POST') return new Response('Method not allowed', { status: 405 });

  await ensureSchema(env);
  rememberOrigin(env, ctx, url.origin);
  if (path.startsWith('/admin/api/')) return adminApi(path.slice(11), request, env, ctx);
  const body = await readJson(request);

  if (path.startsWith('/api/')) return customerApi(path.slice(5), body, request, env, ctx);
  return new Response('Not found', { status: 404 });
}

function checkEnv(env) {
  if (!env.DB) fail('データベース（DB）がつながっていません。手順書の「D1をつなぐ」を確認してください。', 500);
}

async function readJson(request, max) {
  const text = await request.text();
  if (text.length > (max || 20000)) fail(max ? '写真が大きすぎます。' : '送信内容が大きすぎます。');
  if (!text) return {};
  try { return JSON.parse(text); } catch (e) { return fail('送信内容が正しくありません。'); }
}

function json(obj, status, headers) {
  return new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: Object.assign({
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff'
    }, headers || {})
  });
}

function html(body, isAdmin) {
  const h = {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'same-origin'
  };
  if (isAdmin) {
    h['x-frame-options'] = 'DENY';
    h['x-robots-tag'] = 'noindex';
  }
  return new Response(body, { headers: h });
}

function renderPage(template, env) {
  const boot = {
    liffId: env.LIFF_ID || '',
    lineId: env.LINE_ID || '',
    shop: SHOP
  };
  const bootJson = JSON.stringify(boot).replace(/</g, '\\u003c');
  return template
    .replace('"__BOOT__"', () => bootJson)
    .replace('/*__SHARED__*/', () => SHARED_SOURCE);
}

function pngIcon(size) {
  const bin = Uint8Array.from(atob(ICONS[size]), c => c.charCodeAt(0));
  return new Response(bin, { headers: { 'content-type': 'image/png', 'cache-control': 'public, max-age=604800' } });
}

// ホーム画面に追加したときの名前とアイコン
function manifest(kind) {
  const admin = kind === 'admin';
  const body = {
    name: admin ? SHOP.name + ' 予約管理' : SHOP.name + ' ご予約',
    short_name: admin ? SHOP.name + ' 管理' : SHOP.name,
    start_url: admin ? '/admin' : '/',
    scope: admin ? '/admin' : '/',
    display: 'standalone',
    background_color: '#F3F2EF',
    theme_color: '#F3F2EF',
    icons: [
      { src: '/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any maskable' },
      { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any maskable' }
    ]
  };
  return new Response(JSON.stringify(body), { headers: { 'content-type': 'application/manifest+json; charset=utf-8', 'cache-control': 'public, max-age=86400' } });
}

function logo() {
  const bin = Uint8Array.from(atob(LOGO_B64), c => c.charCodeAt(0));
  return new Response(bin, { headers: { 'content-type': 'image/webp', 'cache-control': 'public, max-age=604800' } });
}

function fail(message, status, code) {
  const e = new Error(message);
  e.userFacing = true;
  e.status = status || 400;
  if (code) e.code = code;
  throw e;
}

/* =========================================================
 * データベースの準備
 * ========================================================= */

async function ensureSchema(env) {
  if (schemaReady) return;
  let version = 0;
  try {
    const row = await env.DB.prepare("SELECT v FROM kv WHERE k = 'schema'").first();
    version = row ? Number(row.v) || 1 : 0;
  } catch (e) {
    version = 0;
  }
  if (version > 0 && version < 10) {
    await env.DB.batch(MONEY_SCHEMA_SQL().map(sql => env.DB.prepare(sql)));
    try { await env.DB.prepare('ALTER TABLE receipts ADD COLUMN data TEXT').run(); } catch (e) { /* すでにある */ }
    await env.DB.prepare("DELETE FROM kv WHERE k LIKE 'mfm:%' OR k = 'aiMoney'").run();
  }
  if (version > 0 && version < 8) {
    try { await env.DB.prepare('ALTER TABLE reservations ADD COLUMN stay INTEGER').run(); } catch (e) { /* すでにある */ }
  }
  if (version > 0 && version < 7) {
    await env.DB.batch(IG_SCHEMA().map(sql => env.DB.prepare(sql)));
  }
  if (version > 0 && version < 6) {
    await env.DB.batch(EVENT_SCHEMA().map(sql => env.DB.prepare(sql)));
  }
  if (version > 0 && version < 5) {
    try { await env.DB.prepare('ALTER TABLE courses ADD COLUMN cap INTEGER').run(); } catch (e) { /* すでにある */ }
  }
  if (version > 0 && version < 4) {
    await env.DB.batch(CUSTOMER_SCHEMA().map(sql => env.DB.prepare(sql)));
    const cols = ['ALTER TABLE customers ADD COLUMN name TEXT', 'ALTER TABLE customers ADD COLUMN tel TEXT',
      'ALTER TABLE customers ADD COLUMN extra_visits INTEGER NOT NULL DEFAULT 0', 'ALTER TABLE customers ADD COLUMN merged_into TEXT',
      'ALTER TABLE customers ADD COLUMN created_at TEXT'];
    for (const sql of cols) { try { await env.DB.prepare(sql).run(); } catch (e) { /* すでにある */ } }
  }
  if (version > 0 && version < 3) {
    await env.DB.batch(CUSTOMER_SCHEMA().map(sql => env.DB.prepare(sql)));
    try { await env.DB.prepare('ALTER TABLE reservations ADD COLUMN arrived TEXT').run(); } catch (e) { /* すでにある */ }
  }
  if (version > 0 && version < 2) {
    // すでにあるデータを残したまま、変更リクエストの表と項目を追加する
    await env.DB.batch(CHANGE_SCHEMA().map(sql => env.DB.prepare(sql)));
    const cols = [
      "ALTER TABLE courses ADD COLUMN chg_mode TEXT NOT NULL DEFAULT 'default'",
      'ALTER TABLE courses ADD COLUMN chg_days INTEGER NOT NULL DEFAULT 2',
      "ALTER TABLE courses ADD COLUMN chg_time TEXT NOT NULL DEFAULT '23:59'"
    ];
    for (const sql of cols) {
      try { await env.DB.prepare(sql).run(); } catch (e) { /* すでにある場合は何もしない */ }
    }
    await env.DB.prepare("INSERT OR REPLACE INTO kv (k, v) VALUES ('schema', ?)").bind(String(SCHEMA_VERSION)).run();
    version = SCHEMA_VERSION;
  }
  if (!version) {
    await env.DB.batch(SCHEMA.map(sql => env.DB.prepare(sql)));
    const count = await env.DB.prepare('SELECT COUNT(*) AS n FROM courses').first();
    const stmts = [];
    if (!count || !count.n) {
      SEED_COURSES.forEach((c, i) => stmts.push(env.DB.prepare(
        'INSERT INTO courses (id, sort, visible, name, price, price_type, description, sessions, weekdays, min_guests, cutoff_mode, cutoff_days, cutoff_time, chg_mode, chg_days, chg_time) VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
      ).bind(newId('C'), i + 1, c[0], c[1], c[2], c[3], c[4], ALL_WEEK.join(','), c[5], c[6], c[7], c[8], c[9], c[10], c[11])));
    }
    stmts.push(env.DB.prepare("INSERT OR IGNORE INTO kv (k, v) VALUES ('settings', ?)").bind(JSON.stringify(DEFAULT_SETTINGS)));
    stmts.push(env.DB.prepare("INSERT OR REPLACE INTO kv (k, v) VALUES ('schema', ?)").bind(String(SCHEMA_VERSION)));
    await env.DB.batch(stmts);
  } else if (version < SCHEMA_VERSION) {
    // 移行が終わったら版を記録する（次からは移行を飛ばす）
    await env.DB.prepare("INSERT OR REPLACE INTO kv (k, v) VALUES ('schema', ?)").bind(String(SCHEMA_VERSION)).run();
  }
  schemaReady = true;
}

let knownOrigin = '';
function rememberOrigin(env, ctx, origin) {
  if (knownOrigin === origin || !/^https:/.test(origin)) return;
  knownOrigin = origin;
  ctx.waitUntil(env.DB.prepare("INSERT OR REPLACE INTO kv (k, v) VALUES ('origin', ?)").bind(origin).run().catch(() => {}));
}

async function adminUrl(env) {
  if (knownOrigin) return knownOrigin + '/admin';
  const row = await env.DB.prepare("SELECT v FROM kv WHERE k = 'origin'").first();
  return row ? row.v + '/admin' : '';
}

function parseSettings(row) {
  let saved = {};
  try { saved = JSON.parse(row && row.v ? row.v : '{}'); } catch (e) { saved = {}; }
  const s = Object.assign({}, DEFAULT_SETTINGS, saved);
  s.cutoff = Object.assign({}, DEFAULT_SETTINGS.cutoff, saved.cutoff || {});
  s.changeCutoff = Object.assign({}, DEFAULT_SETTINGS.changeCutoff, saved.changeCutoff || {});
  s.weekly = Object.assign({}, DEFAULT_SETTINGS.weekly, saved.weekly || {});
  const savedSessions = saved.sessions && Object.keys(saved.sessions).length ? saved.sessions : DEFAULT_SETTINGS.sessions;
  s.sessions = {};
  Object.keys(savedSessions).forEach(k => {
    const base = DEFAULT_SETTINGS.sessions[k] || {};
    const c = Object.assign({ name: DEFAULT_SESSION_NAME[k] || k, en: '', short: '' }, base, savedSessions[k]);
    if (!c.name) c.name = DEFAULT_SESSION_NAME[k] || k;
    if (!c.short) c.short = c.name.slice(0, 1);
    s.sessions[k] = c;
  });
  return s;
}

function parseCourse(r) {
  return {
    id: r.id, sort: r.sort, visible: !!r.visible, name: r.name, price: r.price, price_type: r.price_type,
    description: r.description || '',
    sessions: String(r.sessions || '').split(',').filter(Boolean),
    weekdays: String(r.weekdays || '').split(',').filter(x => x !== '').map(Number),
    min_guests: r.min_guests, cutoff_mode: r.cutoff_mode, cutoff_days: r.cutoff_days, cutoff_time: r.cutoff_time,
    chg_mode: r.chg_mode || 'default', chg_days: r.chg_days === null || r.chg_days === undefined ? 2 : r.chg_days,
    chg_time: r.chg_time || '23:59',
    cap: r.cap ? Number(r.cap) : null
  };
}

function rulesMap(rows) {
  const m = {};
  rows.forEach(r => { m[r.date] = { kind: r.kind, sessions: String(r.sessions || '').split(',').filter(Boolean) }; });
  return m;
}

// 期間内の設定・席・営業日・メニューをまとめて読む
async function loadWindow(env, from, to) {
  const db = env.DB;
  const rs = await db.batch([
    db.prepare("SELECT v FROM kv WHERE k = 'settings'"),
    db.prepare('SELECT id, hold_date AS date, hold_time AS time, hold_session AS session, guests, status, course_id AS course, stay FROM reservations WHERE hold_date BETWEEN ? AND ? AND status IN ' + HOLDING_SQL).bind(from, to),
    db.prepare("SELECT id, date, time, session, guests, 1 AS chg, course_id AS course FROM change_requests WHERE date BETWEEN ? AND ? AND status = '返事待ち'").bind(from, to),
    db.prepare('SELECT id, date, type, start, end, seats FROM blocks WHERE date BETWEEN ? AND ?').bind(from, to),
    db.prepare('SELECT date, kind, sessions FROM day_rules WHERE date BETWEEN ? AND ?').bind(from, to),
    db.prepare('SELECT * FROM courses ORDER BY sort, name')
  ]);
  const s = parseSettings(rs[0].results[0]);
  return {
    s: s,
    holds: rs[1].results.concat(rs[2].results),
    blocks: rs[3].results,
    rules: rulesMap(rs[4].results),
    courses: rs[5].results.map(parseCourse)
  };
}

async function getSettings(env) {
  return parseSettings(await env.DB.prepare("SELECT v FROM kv WHERE k = 'settings'").first());
}

/* =========================================================
 * お客様の予約ページ用
 * ========================================================= */

async function customerApi(name, body, request, env, ctx) {
  if (name === 'login') {
    const user = await verifyIdToken(env, body.idToken);
    const token = await signToken(env, { k: 'c', u: user.userId, n: user.name, e: Date.now() + 12 * 3600 * 1000 });
    return json({ ok: true, token: token, data: await customerData(env, user.userId) });
  }
  const user = await customerAuth(env, request);
  if (name === 'init') return json({ ok: true, data: await customerData(env, user.userId) });
  if (name === 'request') {
    const r = await createRequest(env, user, body.data || {});
    if (r.status === ST.WAIT && ctx) ctx.waitUntil(warmReply(env, 'r', r.id));
    return json({ ok: true, reservation: r, data: await customerData(env, user.userId) });
  }
  if (name === 'cancel') {
    const message = await customerCancel(env, user, String(body.id || ''));
    return json({ ok: true, message: message, data: await customerData(env, user.userId) });
  }
  if (name === 'track') {
    await trackEvents(env, user, body);
    return json({ ok: true });
  }
  if (name === 'change') {
    const chg = await createChange(env, user, body.data || {});
    if (chg && chg.id && ctx) ctx.waitUntil(warmReply(env, 'g', chg.id));
    return json({ ok: true, data: await customerData(env, user.userId) });
  }
  if (name === 'cancelChange') {
    await cancelChange(env, user, String(body.id || ''));
    return json({ ok: true, data: await customerData(env, user.userId) });
  }
  if (name === 'accept') {
    await acceptOffer(env, user, String(body.id || ''));
    return json({ ok: true, data: await customerData(env, user.userId) });
  }
  if (name === 'decline') {
    await declineOffer(env, user, String(body.id || ''));
    return json({ ok: true, data: await customerData(env, user.userId) });
  }
  return fail('不明な操作です。', 404);
}

async function customerAuth(env, request) {
  const h = request.headers.get('authorization') || '';
  const p = await verifyToken(env, h.replace(/^Bearer\s+/i, ''));
  if (!p || p.k !== 'c') fail('LINEの確認の有効期限が切れました。ページを開き直してください。', 401);
  return { userId: p.u, name: p.n };
}

async function customerData(env, userId) {
  const nowMs = Date.now();
  const now = jstStamp(nowMs);
  const today = now.slice(0, 10);
  const first = await getSettings(env);
  const end = bookingEnd(first, today);
  const w = await loadWindow(env, today, end < today ? today : end);
  const mine = await env.DB.prepare(
    'SELECT * FROM reservations WHERE user_id = ? AND hold_date >= ? AND status IN ' + HOLDING_SQL + ' ORDER BY hold_date, hold_time'
  ).bind(userId, today).all();
  const chg = await env.DB.prepare(
    "SELECT * FROM change_requests WHERE user_id = ? AND status = '返事待ち'"
  ).bind(userId).all();
  const s = w.s;
  return {
    nowMs: nowMs,
    now: now,
    settings: {
      seats: s.seats, maxGuests: s.maxGuests, aheadDays: s.aheadDays, openUntil: s.openUntil || '', cancelDays: s.cancelDays,
      replyHint: s.replyHint, cutoff: s.cutoff, changeCutoff: s.changeCutoff, weekly: s.weekly, sessions: s.sessions
    },
    courses: w.courses.filter(c => c.visible).map(publicCourse),
    rules: w.rules,
    holds: w.holds.map(h => ({ id: h.id, date: h.date, time: h.time, session: h.session, guests: h.guests, course: h.course || '', stay: h.stay || null })),
    blocks: w.blocks.map(b => ({ id: b.id, date: b.date, type: b.type, start: b.start, end: b.end, seats: b.seats })),
    mine: mine.results.map(r => {
      const o = publicReservation(r, s, today);
      const c = chg.results.find(x => x.res_id === r.id);
      if (c) o.change = { id: c.id, date: c.date, time: c.time, guests: c.guests, course: c.course_name };
      const course = w.courses.find(x => x.id === r.course_id);
      o.changeRule = course ? changeRule(course, s) : s.changeCutoff;
      o.canChange = r.status === ST.OK && !c && now <= deadlineOf(r.date, o.changeRule);
      return o;
    })
  };
}

function publicCourse(c) {
  return {
    id: c.id, name: c.name, price: c.price, price_type: c.price_type, description: c.description,
    sessions: c.sessions, weekdays: c.weekdays, min_guests: c.min_guests,
    cutoff_mode: c.cutoff_mode, cutoff_days: c.cutoff_days, cutoff_time: c.cutoff_time,
    chg_mode: c.chg_mode, chg_days: c.chg_days, chg_time: c.chg_time, cap: c.cap
  };
}

function publicReservation(r, s, today) {
  const days = diffDays(today, r.date);
  return {
    id: r.id, status: r.status, date: r.date, time: r.time, session: r.session, guests: r.guests,
    course: r.course_name, courseId: r.course_id, name: r.name, altDate: r.alt_date, altTime: r.alt_time,
    offerDate: r.offer_date, offerTime: r.offer_time,
    canCancel: r.status !== ST.OK || days >= s.cancelDays
  };
}

async function createRequest(env, user, d) {
  const nowMs = Date.now();
  const now = jstStamp(nowMs);
  const today = now.slice(0, 10);
  const guests = Math.round(Number(d.guests));
  // 姓と名は分けて受け取り、両方を必須にする（古い画面からの送信は、お名前1つでも受け付ける）
  let name;
  if (d.sei !== undefined || d.mei !== undefined) {
    const sei = clean(d.sei, 20).replace(/[\s\u3000]+/g, '');
    const mei = clean(d.mei, 20).replace(/[\s\u3000]+/g, '');
    if (!sei) fail('姓をご入力ください。');
    if (!mei) fail('名をご入力ください。');
    name = sei + ' ' + mei;
  } else {
    name = clean(d.name, 40);
    if (name.replace(/\s/g, '').length < 2) fail('お名前をフルネームでご入力ください。');
  }
  const phone = String(d.phone || '').replace(/[^\d-]/g, '').slice(0, 20);
  const note = clean(d.note, 300);
  if (!isDate(d.date) || !isTime(d.time)) fail('日付と時間を選んでください。');
  if (phone.replace(/-/g, '').length < 10) fail('電話番号を正しくご入力ください。');

  const w = await loadWindow(env, d.date, d.date);
  const s = w.s;
  if (!(guests >= 1)) fail('人数をお選びください。');
  if (guests > s.maxGuests) fail((s.maxGuests + 1) + '名以上のご予約はお電話でご相談ください。');
  if (diffDays(today, d.date) < 0) fail('過ぎた日付にはご予約いただけません。');
  if (d.date > bookingEnd(s, today)) fail(bookingEnd(s, today) < today ? 'ただいま次の期間のご予約の準備中です。お電話でお問い合わせください（' + SHOP.tel + '）。' : jdLong(bookingEnd(s, today)) + 'までのご予約を承っています。それ以降はまだ受付前です。');

  const active = await env.DB.prepare(
    'SELECT COUNT(*) AS n FROM reservations WHERE user_id = ? AND hold_date >= ? AND status IN ' + HOLDING_SQL
  ).bind(user.userId, today).first();
  if (active && active.n >= s.maxActive) fail('お申し込み中の予約が上限に達しています。お電話でお問い合わせください。');

  if (!sessionsAt(d.date, d.time, w.rules, s).length) fail('選んだ日時はご予約を承っていません。選び直してください。');
  const course = w.courses.find(c => c.visible && c.id === d.courseId);
  if (!course) fail('メニューを選び直してください。');
  const session = sessionFor(d.date, d.time, w.rules, s, course);
  if (!session) fail(reasonText('session', course, s));
  const slot = { time: d.time, session: session };
  const why = courseCheck(course, d.date, d.time, session, guests, now, s, false);
  if (why) fail(reasonText(why, course, s));

  let altDate = '';
  let altTime = '';
  if (d.altDate && d.altTime) {
    if (!isDate(d.altDate) || !isTime(d.altTime)) fail('第2希望を選び直してください。');
    if (d.altDate === d.date && d.altTime === d.time) fail('第2希望は第1希望と別の日時を選んでください。');
    const aw = d.altDate === d.date ? w : await loadWindow(env, d.altDate, d.altDate);
    const asession = sessionFor(d.altDate, d.altTime, aw.rules, s, course);
    if (!asession) fail('第2希望では、このメニューをご予約いただけません。別の日時をお選びください。');
    if (courseCheck(course, d.altDate, d.altTime, asession, guests, now, s, false)) fail('第2希望の日時では、このメニューをご予約いただけません。');
    if (d.altDate > bookingEnd(s, today)) fail('第2希望の日付は、まだ受付前です。');
    altDate = d.altDate;
    altTime = d.altTime;
  }

  // 通信エラーなどで同じ内容が二重に届いたときは、1件として扱う
  const same = await env.DB.prepare(
    'SELECT * FROM reservations WHERE user_id = ? AND date = ? AND time = ? AND guests = ? AND course_id = ? AND status IN ' + HOLDING_SQL + ' ORDER BY created_at DESC'
  ).bind(user.userId, d.date, d.time, guests, course.id).first();
  if (same && Date.now() - stampMs(same.created_at) < 5 * 60 * 1000) {
    return publicReservation(same, s, today);
  }

  const idx = buildIndex(w.holds, w.blocks, s);
  if (leftAt(idx, d.date, d.time, slot.session, null, s) < guests) {
    fail('申し訳ありません。この時間はちょうど満席になりました。別の時間をお選びください。');
  }
  if (courseLeft(w.holds, s, course, d.date, d.time, slot.session, null) < guests) {
    fail('「' + course.name + '」は、この時間はご予約がいっぱいです。別の時間かメニューをお選びください。');
  }

  const r = {
    id: newId('R'), created_at: now, updated_at: rev(), status: ST.WAIT, date: d.date, time: d.time,
    session: slot.session, guests: guests, name: name, phone: phone, course_id: course.id, course_name: course.name,
    note: note, alt_date: altDate, alt_time: altTime, offer_date: '', offer_time: '',
    hold_date: d.date, hold_time: d.time, hold_session: slot.session,
    source: 'LINE', user_id: user.userId, line_name: user.name, reminded_at: null, memo: ''
  };
  // 同時に申し込まれても席数を超えないよう、空きを確かめながら登録する
  const ins = await env.DB.prepare(
    'INSERT INTO reservations (id, created_at, updated_at, status, date, time, session, guests, name, phone, course_id, course_name, note, alt_date, alt_time, offer_date, offer_time, hold_date, hold_time, hold_session, source, user_id, line_name, reminded_at, memo) ' +
    'SELECT ?1, ?2, ?19, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, \'\', \'\', ?4, ?5, ?6, \'LINE\', ?15, ?16, NULL, \'\' ' +
    'WHERE (SELECT COALESCE(SUM(guests), 0) * 1000 + COUNT(*) FROM reservations WHERE hold_date = ?4 AND status IN ' + HOLDING_SQL + ') = ?17 ' +
    "AND (SELECT COALESCE(SUM(guests), 0) * 1000 + COUNT(*) FROM change_requests WHERE date = ?4 AND status = '返事待ち') = ?18 " +
    'AND (SELECT COUNT(*) FROM blocks WHERE date = ?4) = ?20'
  ).bind(r.id, now, r.status, r.date, r.time, r.session, r.guests, r.name, r.phone, r.course_id, r.course_name,
    r.note, r.alt_date, r.alt_time, r.user_id, r.line_name,
    holdKey(w.holds, d.date, false), holdKey(w.holds, d.date, true), rev(),
    w.blocks.filter(x => x.date === d.date).length).run();
  if (!ins.meta || !ins.meta.changes) {
    fail('同じ時間に別のご予約が入りました。お手数ですが、もう一度お試しください。', 409);
  }

  const notify = [];
  const lines = ['【予約リクエスト】', r.name + ' 様　' + r.guests + '名', '第1希望：' + jd(r.date) + ' ' + r.time];
  if (altDate) lines.push('第2希望：' + jd(altDate) + ' ' + altTime);
  lines.push('メニュー：' + r.course_name, '電話：' + r.phone);
  if (r.note) lines.push('ご要望：' + r.note);
  lines.push('', '返事をする：' + await adminUrl(env));
  notify.push(pushOwner(env, lines.join('\n')));

  const receipt = [
    r.name + ' 様',
    '',
    'ご予約のリクエストを受け付けました。',
    'まだご予約は確定していません。確認のうえ、' + s.replyHint + 'にLINEでご連絡いたします。',
    '',
    '第1希望：' + jdLong(r.date) + ' ' + r.time
  ];
  if (altDate) receipt.push('第2希望：' + jdLong(altDate) + ' ' + altTime);
  receipt.push('人数：' + r.guests + '名', 'メニュー：' + r.course_name, '', SHOP.name, 'TEL ' + SHOP.tel);
  notify.push(linePush(env, r.user_id, [textMsg(receipt.join('\n')), myPageButton(env, 'リクエストの確認・取り下げはこちら')]));
  notify.push(trackServer(env, user.userId, 'request', r));
  await Promise.all(notify);

  return publicReservation(r, s, today);
}

function reasonText(why, c, s) {
  if (why === 'session') return 'このメニューは選んだ時間帯にはご用意していません。';
  if (why === 'weekday') return 'このメニューは選んだ曜日にはご用意していません。';
  if (why === 'guests') return '「' + c.name + '」は' + c.min_guests + '名様から承ります。';
  if (why === 'past') return 'この時間はすでに過ぎています。';
  if (why === 'deadline') return '「' + c.name + '」のご予約は' + ruleText(cutoffRule(c, s)) + 'です。この日時の受付は終了しました。';
  return 'このメニューはご予約いただけません。';
}

function ruleText(rule) {
  if (Number(rule.days) === 0) return '当日' + rule.time + 'まで';
  return (rule.time === '23:59' ? Number(rule.days) + '日前まで' : Number(rule.days) + '日前の' + rule.time + 'まで');
}

// お客様からの予約変更リクエスト
async function createChange(env, user, d) {
  const r = await findMine(env, user, String(d.id || ''));
  if (r.status !== ST.OK) fail('確定したご予約のみ変更をお申し込みいただけます。');
  const now = jstStamp(Date.now());
  const today = now.slice(0, 10);
  const dup = await env.DB.prepare("SELECT id FROM change_requests WHERE res_id = ? AND status = '返事待ち'").bind(r.id).first();
  if (dup) fail('この予約は、すでに変更をお申し込み中です。');

  if (!isDate(d.date) || !isTime(d.time)) fail('日付と時間を選んでください。');
  const guests = Math.round(Number(d.guests));
  const w = await loadWindow(env, d.date, d.date);
  const s = w.s;
  if (!(guests >= 1)) fail('人数をお選びください。');
  if (guests > s.maxGuests) fail((s.maxGuests + 1) + '名以上のご予約はお電話でご相談ください。');
  if (diffDays(today, d.date) < 0) fail('過ぎた日付にはご予約いただけません。');
  if (d.date > bookingEnd(s, today)) fail(bookingEnd(s, today) < today ? 'ただいま次の期間のご予約の準備中です。お電話でお問い合わせください（' + SHOP.tel + '）。' : jdLong(bookingEnd(s, today)) + 'までのご予約を承っています。それ以降はまだ受付前です。');

  const cur = (await env.DB.prepare('SELECT * FROM courses WHERE id = ?').bind(r.course_id || '').first());
  const rule = cur ? changeRule(parseCourse(cur), s) : s.changeCutoff;
  if (now > deadlineOf(r.date, rule)) fail('この予約の変更受付は終了しました。お電話でご相談ください（' + SHOP.tel + '）。');

  if (!sessionsAt(d.date, d.time, w.rules, s).length) fail('選んだ日時はご予約を承っていません。選び直してください。');
  const course = w.courses.find(c => c.visible && c.id === d.courseId);
  if (!course) fail('メニューを選び直してください。');
  const session = sessionFor(d.date, d.time, w.rules, s, course);
  if (!session) fail(reasonText('session', course, s));
  const slot = { time: d.time, session: session };
  const why = courseCheck(course, d.date, d.time, session, guests, now, s, false);
  if (why) fail(reasonText(why, course, s));
  if (d.date === r.date && d.time === r.time && guests === Number(r.guests) && course.name === r.course_name) {
    fail('今と同じ内容です。変更したい内容をお選びください。');
  }

  const sameChg = await env.DB.prepare(
    "SELECT * FROM change_requests WHERE res_id = ? AND date = ? AND time = ? AND guests = ? AND status = '返事待ち'"
  ).bind(r.id, d.date, d.time, guests).first();
  if (sameChg) return true;

  const idx = buildIndex(w.holds, w.blocks, s);
  if (leftAt(idx, d.date, d.time, slot.session, r.id, s) < guests) {
    fail('申し訳ありません。この時間はちょうど満席になりました。別の時間をお選びください。');
  }
  if (courseLeft(w.holds, s, course, d.date, d.time, slot.session, r.id) < guests) {
    fail('「' + course.name + '」は、この時間はご予約がいっぱいです。別の時間かメニューをお選びください。');
  }

  const id = newId('G');
  const ins = await env.DB.prepare(
    'INSERT INTO change_requests (id, res_id, created_at, updated_at, status, date, time, session, guests, course_id, course_name, user_id, reminded_at) ' +
    "SELECT ?1, ?2, ?3, ?13, '返事待ち', ?4, ?5, ?6, ?7, ?8, ?9, ?10, NULL " +
    'WHERE (SELECT COALESCE(SUM(guests), 0) * 1000 + COUNT(*) FROM reservations WHERE hold_date = ?4 AND status IN ' + HOLDING_SQL + ') = ?11 ' +
    "AND (SELECT COALESCE(SUM(guests), 0) * 1000 + COUNT(*) FROM change_requests WHERE date = ?4 AND status = '返事待ち') = ?12 " +
    "AND (SELECT COUNT(*) FROM change_requests WHERE res_id = ?2 AND status = '返事待ち') = 0 " +
    "AND (SELECT status FROM reservations WHERE id = ?2) = '確定' " +
    'AND (SELECT COUNT(*) FROM blocks WHERE date = ?4) = ?14'
  ).bind(id, r.id, now, d.date, d.time, slot.session, guests, course.id, course.name, user.userId,
    holdKey(w.holds, d.date, false), holdKey(w.holds, d.date, true), rev(),
    w.blocks.filter(x => x.date === d.date).length).run();
  if (!ins.meta || !ins.meta.changes) {
    fail('同じ時間に別のお申し込みが入りました。お手数ですが、もう一度お試しください。', 409);
  }

  await pushOwner(env, ['【予約変更のリクエスト】',
    r.name + ' 様',
    '変更前：' + jd(r.date) + ' ' + r.time + '　' + r.guests + '名　' + r.course_name,
    '変更後：' + jd(d.date) + ' ' + d.time + '　' + guests + '名　' + course.name,
    '電話：' + r.phone,
    '',
    '返事をする：' + await adminUrl(env)].join('\n'));
  return { id: id };
}

async function cancelChange(env, user, id) {
  const c = await env.DB.prepare('SELECT * FROM change_requests WHERE id = ?').bind(id).first();
  if (!c || c.user_id !== user.userId) fail('変更のお申し込みが見つかりません。', 404);
  if (c.status !== CHG.WAIT) fail('この変更のお申し込みはすでに終了しています。');
  await env.DB.prepare('UPDATE change_requests SET status = ?, updated_at = ? WHERE id = ? AND status = ?')
    .bind(CHG.WITHDRAW, rev(), id, CHG.WAIT).run();
  const r = await env.DB.prepare('SELECT * FROM reservations WHERE id = ?').bind(c.res_id).first();
  await Promise.all([
    pushOwner(env, '【予約変更のリクエストが取り下げられました】\n' + (r ? r.name + ' 様\n' : '') +
      '変更後として押さえていた ' + jd(c.date) + ' ' + c.time + ' は空きに戻りました。'),
    linePush(env, user.userId, [textMsg((r ? r.name + ' 様\n\n' : '') + '変更のお申し込みの取り下げを承りました。\n' +
      (r ? 'ご予約は ' + jdLong(r.date) + ' ' + r.time + '　' + r.guests + '名 のままです。\n' : '') +
      '\nご来店を心よりお待ちしております。\n' + SHOP.name)])
  ]);
  return true;
}

async function withdrawChanges(env, resId) {
  await env.DB.prepare('UPDATE change_requests SET status = ?, updated_at = ? WHERE res_id = ? AND status = ?')
    .bind(CHG.WITHDRAW, rev(), resId, CHG.WAIT).run();
}

// 予約ページの操作を記録する（お店のアカウントは数えない）
const EVENT_KINDS = ['open', 'date', 'time', 'course', 'blocked', 'filter', 'change'];
function isOwner(env, userId) {
  return String(env.OWNER_USER_ID || '').split(',').map(x => x.trim()).filter(Boolean).indexOf(userId) >= 0;
}
async function trackEvents(env, user, body) {
  if (isOwner(env, user.userId)) return;
  const list = Array.isArray(body.events) ? body.events.slice(0, 20) : [];
  if (!list.length) return;
  const now = jstStamp(Date.now());
  const sid = clean(body.sid, 40);
  const src = clean(body.src, 30).toLowerCase().replace(/[^a-z0-9_-]/g, '') || 'direct';
  const stmts = list.filter(e => e && EVENT_KINDS.indexOf(e.kind) >= 0).map(e => env.DB.prepare(
    'INSERT INTO events (ts, date, user_id, sid, kind, t_date, t_time, course_id, src, extra) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
  ).bind(now, now.slice(0, 10), user.userId, sid, e.kind, isDate(e.date) ? e.date : null, isTime(e.time) ? e.time : null,
    clean(e.courseId, 40) || null, src, clean(e.extra, 40) || null));
  if (stmts.length) await env.DB.batch(stmts);
}
async function trackServer(env, userId, kind, r) {
  if (isOwner(env, userId)) return;
  const now = jstStamp(Date.now());
  try {
    await env.DB.prepare('INSERT INTO events (ts, date, user_id, sid, kind, t_date, t_time, course_id, src, extra) VALUES (?, ?, ?, NULL, ?, ?, ?, ?, NULL, NULL)')
      .bind(now, now.slice(0, 10), userId, kind, r.date || null, r.time || null, r.course_id || null).run();
  } catch (e) { /* 記録に失敗しても予約は止めない */ }
}

async function findMine(env, user, id) {
  const r = await env.DB.prepare('SELECT * FROM reservations WHERE id = ?').bind(id).first();
  if (!r || r.user_id !== user.userId) fail('予約が見つかりません。', 404);
  return r;
}

async function customerCancel(env, user, id) {
  const r = await findMine(env, user, id);
  const s = await getSettings(env);
  const now = jstStamp(Date.now());
  let status;
  if (r.status === ST.WAIT || r.status === ST.OFFER) {
    status = ST.WITHDRAW;
  } else if (r.status === ST.OK) {
    if (diffDays(now.slice(0, 10), r.date) < s.cancelDays) fail('この日程のキャンセルはお電話で承ります（' + SHOP.tel + '）。');
    status = ST.CANCEL;
  } else {
    fail('この予約はすでに終了しています。');
  }
  const res = await env.DB.prepare('UPDATE reservations SET status = ?, updated_at = ? WHERE id = ? AND status = ?')
    .bind(status, rev(), r.id, r.status).run();
  if (!res.meta.changes) fail('予約の状態が変わりました。ページを開き直してください。', 409);
  await withdrawChanges(env, r.id);

  const tasks = [];
  if (status === ST.CANCEL) {
    tasks.push(pushOwner(env, '【キャンセルがありました】\n' + r.name + ' 様　' + r.guests + '名\n' +
      jd(r.date) + ' ' + r.time + '　' + r.course_name + '\n席は自動で空きに戻りました。'));
    tasks.push(linePush(env, r.user_id, [textMsg(r.name + ' 様\n\n下記のご予約のキャンセルを承りました。\n\n' +
      jdLong(r.date) + ' ' + r.time + '　' + r.guests + '名\n' + r.course_name + '\n\nまたのご来店をお待ちしております。\n' + SHOP.name)]));
  } else {
    tasks.push(pushOwner(env, '【リクエストが取り下げられました】\n' + r.name + ' 様　' + r.guests + '名\n' +
      jd(r.hold_date) + ' ' + r.hold_time + '　' + r.course_name));
    tasks.push(linePush(env, r.user_id, [textMsg(r.name + ' 様\n\n下記のご予約リクエストの取り下げを承りました。\n\n' +
      jdLong(r.hold_date) + ' ' + r.hold_time + '　' + r.guests + '名\n' + r.course_name +
      '\n\nまたのご利用をお待ちしております。\n' + SHOP.name)]));
  }
  await Promise.all(tasks);
  return status === ST.CANCEL ? 'ご予約をキャンセルしました' : 'リクエストを取り下げました';
}

async function acceptOffer(env, user, id) {
  const r = await findMine(env, user, id);
  if (r.status !== ST.OFFER) fail('このご提案はすでに終了しています。');
  const now = jstStamp(Date.now());
  if (now >= r.offer_date + ' ' + r.offer_time) fail('ご提案の日時が過ぎています。お電話でご相談ください（' + SHOP.tel + '）。');
  const res = await env.DB.prepare(
    "UPDATE reservations SET status = ?, date = offer_date, time = offer_time, session = hold_session, offer_date = '', offer_time = '', updated_at = ? WHERE id = ? AND status = ?"
  ).bind(ST.OK, rev(), r.id, ST.OFFER).run();
  if (!res.meta.changes) fail('このご提案はすでに終了しています。');
  await Promise.all([
    pushOwner(env, '【ご提案が承諾されました】\n' + r.name + ' 様　' + r.guests + '名\n' +
      jd(r.offer_date) + ' ' + r.offer_time + '　' + r.course_name + '\n予約が確定しました。'),
    linePush(env, r.user_id, [
      textMsg(r.name + ' 様\n\nご予約が確定しました。\n\n日時：' + jdLong(r.offer_date) + ' ' + r.offer_time +
        '\n人数：' + r.guests + '名\nメニュー：' + r.course_name + '\n\nご来店を心よりお待ちしております。\n\n' + SHOP.name + '\nTEL ' + SHOP.tel),
      myPageButton(env, 'ご予約の確認・キャンセルはこちら')
    ])
  ]);
}

async function declineOffer(env, user, id) {
  const r = await findMine(env, user, id);
  if (r.status !== ST.OFFER) fail('このご提案はすでに終了しています。');
  const res = await env.DB.prepare('UPDATE reservations SET status = ?, updated_at = ? WHERE id = ? AND status = ?')
    .bind(ST.WITHDRAW, rev(), r.id, ST.OFFER).run();
  if (!res.meta.changes) fail('このご提案はすでに終了しています。');
  await Promise.all([
    pushOwner(env, '【ご提案が見送られました】\n' + r.name + ' 様　' + r.guests + '名\n提案した日時：' +
      jd(r.offer_date) + ' ' + r.offer_time),
    linePush(env, r.user_id, [textMsg(r.name + ' 様\n\nご提案の見送りを承りました。\nご予約は承っておりませんので、ご了承ください。\n\n' +
      'またのご利用をお待ちしております。\n' + SHOP.name)])
  ]);
}

/* =========================================================
 * 管理画面用
 * ========================================================= */

const ADMIN_COOKIE = 'epii_admin';

// 写真を送る操作だけ、大きな送信を受け付ける（ログインを確かめてから読む）
const ADMIN_BIG = { rcptRead: 1, rcptSave: 1, igDraft: 1 };

async function adminApi(name, request, env, ctx) {
  if (name === 'login') return adminLogin(env, request, await readJson(request));
  if (name === 'logout') {
    return json({ ok: true }, 200, { 'set-cookie': ADMIN_COOKIE + '=; Path=/admin; HttpOnly; Secure; SameSite=Strict; Max-Age=0' });
  }
  if (request.headers.get('x-epii') !== '1') fail('不正なリクエストです。', 403);
  const cookie = (request.headers.get('cookie') || '').split(/;\s*/).find(c => c.indexOf(ADMIN_COOKIE + '=') === 0);
  const p = cookie ? await verifyToken(env, cookie.slice(ADMIN_COOKIE.length + 1)) : null;
  if (!p || p.k !== 'a' || p.p !== await pwTag(env)) fail('ログインしてください。', 401);
  const fn = ADMIN_FUNCS[name];
  if (!fn) fail('不明な操作です。', 404);
  const body = await readJson(request, ADMIN_BIG[name] ? 12000000 : 0);
  const result = await fn(env, body, ctx);
  return json(Object.assign({ ok: true }, result));
}

async function adminLogin(env, request, body) {
  if (!env.ADMIN_PASSWORD) fail('管理画面のパスワード（ADMIN_PASSWORD）が未設定です。', 500);
  const ip = request.headers.get('cf-connecting-ip') || 'unknown';
  const nowMs = Date.now();
  const lock = await env.DB.prepare('SELECT count, until FROM login_fail WHERE ip = ?').bind(ip).first();
  if (lock && lock.count >= 5 && lock.until > nowMs) {
    fail('ログインの失敗が続いたため、15分ほど待ってからお試しください。', 429);
  }
  const ok = await safeEqual(env, String(body.password || ''), env.ADMIN_PASSWORD);
  if (!ok) {
    const count = lock && lock.until > nowMs ? lock.count + 1 : 1;
    await env.DB.prepare('INSERT OR REPLACE INTO login_fail (ip, count, until) VALUES (?, ?, ?)')
      .bind(ip, count, nowMs + 15 * 60 * 1000).run();
    await new Promise(r => setTimeout(r, 600));
    fail('パスワードが違います。', 401);
  }
  if (lock) await env.DB.prepare('DELETE FROM login_fail WHERE ip = ?').bind(ip).run();
  const days = 30;
  const token = await signToken(env, { k: 'a', p: await pwTag(env), e: nowMs + days * 86400 * 1000 });
  return json({ ok: true }, 200, {
    'set-cookie': ADMIN_COOKIE + '=' + token + '; Path=/admin; HttpOnly; Secure; SameSite=Strict; Max-Age=' + days * 86400
  });
}

const ADMIN_FUNCS = {
  boot: async env => {
    const now = jstStamp(Date.now());
    const [s, courses, req] = await Promise.all([getSettings(env), allCourses(env), adminRequestsData(env)]);
    return { now: now, settings: s, courses: courses, requests: req, liffUrl: appUrl(env, ''), bookingEnd: bookingEnd(s, now.slice(0, 10)), features: features(env) };
  },
  requests: async env => ({ requests: await adminRequestsData(env) }),
  reply: adminReply,
  replyChange: adminReplyChange,
  day: adminDay,
  upcoming: async env => {
    const today = jstStamp(Date.now()).slice(0, 10);
    const r = await env.DB.prepare("SELECT * FROM reservations WHERE status = '確定' AND date >= ? ORDER BY date, time LIMIT 300").bind(today).all();
    return { list: r.results.map(adminView) };
  },
  addPhone: adminAddPhone,
  arrive: async (env, b) => {
    const state = ['yes', 'no', ''].indexOf(b.state) >= 0 ? b.state : '';
    await env.DB.prepare('UPDATE reservations SET arrived = ? WHERE id = ?').bind(state, String(b.id || '')).run();
    return {};
  },
  customers: adminCustomers,
  customer: adminCustomer,
  saveCustomer: async (env, b) => {
    const key = String(b.key || normPhone(b.phone) || '').slice(0, 60);
    if (!key) fail('お客様が見つかりません。');
    const patch = {};
    ['memo', 'name', 'tel', 'extra'].forEach(k => { if (b[k] !== undefined) patch[k] = b[k]; });
    await upsertCustomer(env, key, patch);
    return {};
  },
  addCustomer: adminAddCustomer,
  mergeCustomers: adminMergeCustomers,
  unmergeCustomer: async (env, b) => {
    const key = String(b.key || '').slice(0, 60);
    if (!key) fail('お客様が見つかりません。');
    await upsertCustomer(env, key, { merged: null });
    return {};
  },
  cancel: adminCancel,
  edit: adminEdit,
  addBlock: adminAddBlock,
  deleteBlock: async (env, b) => {
    await env.DB.prepare('DELETE FROM blocks WHERE id = ?').bind(String(b.id || '')).run();
    return {};
  },
  month: adminMonth,
  setDay: adminSetDay,
  saveSettings: adminSaveSettings,
  courses: async env => ({ courses: await allCourses(env) }),
  saveCourse: adminSaveCourse,
  toggleCourse: async (env, b) => {
    await env.DB.prepare('UPDATE courses SET visible = ? WHERE id = ?').bind(b.visible ? 1 : 0, String(b.id || '')).run();
    return { courses: await allCourses(env) };
  },
  moveCourse: adminMoveCourse,
  deleteCourse: async (env, b) => {
    const id = String(b.id || '');
    const today = jstStamp(Date.now()).slice(0, 10);
    const used = await env.DB.prepare(
      'SELECT COUNT(*) AS n FROM reservations WHERE course_id = ? AND hold_date >= ? AND status IN ' + HOLDING_SQL
    ).bind(id, today).first();
    await env.DB.prepare('DELETE FROM courses WHERE id = ?').bind(id).run();
    return { courses: await allCourses(env), used: used ? used.n : 0 };
  },
  quota: adminQuota,
  analytics: adminAnalytics,
  igStats: adminIgStats,
  igSync: async env => ({ result: await igSync(env, true) }),
  // Claude・Square・マネーフォワード（src/services.js）
  aiReply: adminAiReply,
  aiMemos: adminAiMemos,
  sales: adminSales,
  salesLink: adminSalesLink,
  money: adminMoney,
  dash: adminDash,
  analysisAi: adminAnalysisAi,
  aiNote: adminAiNote,
  aiAsk: adminAiAsk,
  rcptList: adminRcptList,
  rcptRead: adminRcptRead,
  rcptSave: adminRcptSave,
  rcptUndo: adminRcptUndo,
  rcptForce: adminRcptForce,
  mfTx: adminMfTx,
  mfTxSave: adminMfTxSave,
  igOpenings: adminIgOpenings,
  igDraft: adminIgDraft,
  igSave: adminIgSave
};

async function allCourses(env) {
  const r = await env.DB.prepare('SELECT * FROM courses ORDER BY sort, name').all();
  return r.results.map(parseCourse);
}

function adminView(r) {
  return {
    id: r.id, status: r.status, createdAt: r.created_at, date: r.date, time: r.time, session: r.session,
    holdDate: r.hold_date, holdTime: r.hold_time, guests: r.guests, name: r.name, phone: r.phone,
    course: r.course_name, courseId: r.course_id, note: r.note, altDate: r.alt_date, altTime: r.alt_time,
    offerDate: r.offer_date, offerTime: r.offer_time, source: r.source, hasLine: !!r.user_id,
    lineName: r.line_name, memo: r.memo, updatedAt: r.updated_at, arrived: r.arrived || '',
    stay: r.stay || null, until: r.stay ? toHM(toMin(r.time) + Number(r.stay)) : ''
  };
}

async function adminRequestsData(env) {
  const nowMs = Date.now();
  const now = jstStamp(nowMs);
  const today = now.slice(0, 10);
  const rows = (await env.DB.prepare(
    "SELECT * FROM reservations WHERE status IN ('返事待ち','提案中') ORDER BY created_at"
  ).all()).results;
  const s = await getSettings(env);
  const w = await loadWindow(env, addDays(today, -1), addDays(bookingEnd(s, today) > today ? bookingEnd(s, today) : today, 31));
  const idx = buildIndex(w.holds, w.blocks, s);
  const waiting = rows.filter(r => r.status === ST.WAIT).map(r => {
    const course = w.courses.find(c => c.id === r.course_id);
    return Object.assign(adminView(r), {
      left: leftAt(idx, r.date, r.time, r.session, r.id, s),
      altLeft: r.alt_date ? leftAt(idx, r.alt_date, r.alt_time, r.session, r.id, s) : null,
      suggestions: suggestSlots(w, idx, s, r, course, now)
    });
  });
  return { waiting: waiting, offering: rows.filter(r => r.status === ST.OFFER).map(adminView), changes: await changeList(env, w, idx, s) };
}

// 変更リクエストの一覧（変更前・変更後と、変更後の日時の空き）
async function changeList(env, w, idx, s) {
  const rows = (await env.DB.prepare(
    "SELECT c.*, r.date AS old_date, r.time AS old_time, r.guests AS old_guests, r.course_name AS old_course, r.name AS name, r.phone AS phone, r.status AS res_status, r.user_id AS res_user, r.updated_at AS res_updated FROM change_requests c JOIN reservations r ON r.id = c.res_id WHERE c.status = '返事待ち' ORDER BY c.created_at"
  ).all()).results;
  return rows.map(c => ({
    id: c.id, resId: c.res_id, createdAt: c.created_at, name: c.name, phone: c.phone,
    date: c.date, time: c.time, session: c.session, guests: c.guests, course: c.course_name,
    oldDate: c.old_date, oldTime: c.old_time, oldGuests: c.old_guests, oldCourse: c.old_course,
    hasLine: !!c.res_user, resStatus: c.res_status,
    left: leftAt(idx, c.date, c.time, c.session, [c.res_id, c.id], s)
  }));
}

async function adminReplyChange(env, b) {
  const c = await env.DB.prepare('SELECT * FROM change_requests WHERE id = ?').bind(String(b.id || '')).first();
  if (!c) fail('変更のリクエストが見つかりません。');
  if (c.status !== CHG.WAIT) fail('このリクエストはすでに返事済みです。画面を更新してください。');
  const r = await env.DB.prepare('SELECT * FROM reservations WHERE id = ?').bind(c.res_id).first();
  if (!r) fail('元の予約が見つかりません。');
  const text = String(b.text || '').trim();
  if (!text) fail('送る文面を入力してください。');
  if (text.length > 4500) fail('文面が長すぎます。');
  const now = jstStamp(Date.now());
  const s = await getSettings(env);

  if (b.mode === 'ok') {
    if (r.status !== ST.OK) fail('元の予約が確定ではありません。画面を更新してください。');
    if (!b.force) {
      const w = await loadWindow(env, c.date, c.date);
      const idx = buildIndex(w.holds, w.blocks, s);
      const ccx = w.courses.find(x => x.id === c.course_id);
      if (leftAt(idx, c.date, c.time, c.session, [c.res_id, c.id], s) < c.guests || courseLeft(w.holds, s, ccx, c.date, c.time, c.session, [c.res_id, c.id]) < c.guests) {
        return { ok: false, full: true, message: 'この日時は席数を超えます。それでも変更しますか？' };
      }
    }
  } else if (b.mode !== 'ng') {
    fail('返事の種類を選んでください。');
  }

  // 先に保存してから送る（送れなかったときは元に戻す）
  const stmts = [];
  if (b.mode === 'ok') {
    stmts.push(env.DB.prepare(
      'UPDATE reservations SET date = ?, time = ?, session = ?, guests = ?, course_id = ?, course_name = ?, hold_date = ?, hold_time = ?, hold_session = ?, updated_at = ? ' +
      "WHERE id = ? AND status = ? AND updated_at = ? AND (SELECT status FROM change_requests WHERE id = ?) = '返事待ち'"
    ).bind(c.date, c.time, c.session, c.guests, c.course_id, c.course_name, c.date, c.time, c.session, rev(), r.id, ST.OK, r.updated_at, c.id));
  }
  stmts.push(env.DB.prepare('UPDATE change_requests SET status = ?, updated_at = ? WHERE id = ? AND status = ?')
    .bind(b.mode === 'ok' ? CHG.OK : CHG.NG, rev(), c.id, CHG.WAIT));
  const done = await env.DB.batch(stmts);
  if (done.some(x => !x.meta.changes)) {
    fail('予約またはリクエストがほかの操作で変わりました。画面を更新して内容を確認してください。', 409);
  }
  if (r.user_id && !b.skipLine) {
    const res = await linePush(env, r.user_id, [textMsg(text), myPageButton(env, 'ご予約の確認・キャンセルはこちら')]);
    if (!res.ok) {
      if (b.mode === 'ok') {
        if (!(await fits(env, s, r.date, r.time, r.hold_session, Number(r.guests), r.id))) {
          await env.DB.prepare('UPDATE reservations SET memo = ? WHERE id = ?')
            .bind('LINE未達（' + now + '）要電話連絡', r.id).run();
          fail('LINEを送れませんでした（' + res.message + '）。元の日時はすでに埋まっているため、変更を反映したまま保存しました。お客様にはお電話でご連絡ください。', 400, 'LINE_FAILED_KEPT');
        }
        await env.DB.prepare(
          'UPDATE reservations SET date = ?, time = ?, session = ?, guests = ?, course_id = ?, course_name = ?, hold_date = ?, hold_time = ?, hold_session = ?, updated_at = ? WHERE id = ?'
        ).bind(r.date, r.time, r.session, r.guests, r.course_id, r.course_name, r.hold_date, r.hold_time, r.hold_session, r.updated_at, r.id).run();
      }
      await env.DB.prepare('UPDATE change_requests SET status = ?, updated_at = ? WHERE id = ?')
        .bind(CHG.WAIT, c.updated_at, c.id).run();
      fail('LINEを送れませんでした（' + res.message + '）。状態は変更していません。', 400, 'LINE_FAILED');
    }
  }
  return { requests: await adminRequestsData(env) };
}

function suggestSlots(w, idx, s, r, course, now) {
  const found = [];
  const today = now.slice(0, 10);
  const offsets = [0];
  for (let k = 1; k <= 30; k++) offsets.push(k, -k);
  for (let i = 0; i < offsets.length && found.length < 12; i++) {
    const date = addDays(r.date, offsets[i]);
    if (date < today || date > bookingEnd(s, today)) continue;
    daySlots(date, w.rules, s).forEach(x => {
      if (found.length >= 12 || x.session !== r.session) return;
      if (date === r.date && x.time === r.time) return;
      if (course && courseCheck(course, date, x.time, x.session, r.guests, now, s, true)) return;
      if (!course && now >= date + ' ' + x.time) return;
      if (leftAt(idx, date, x.time, x.session, r.id, s) >= r.guests && courseLeft(w.holds, s, course, date, x.time, x.session, r.id) >= r.guests) found.push({ date: date, time: x.time });
    });
  }
  return found.sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time));
}

async function adminReply(env, b) {
  const r = await env.DB.prepare('SELECT * FROM reservations WHERE id = ?').bind(String(b.id || '')).first();
  if (!r) fail('リクエストが見つかりません。');
  if (r.status !== ST.WAIT) fail('このリクエストはすでに返事済みです。画面を更新してください。');
  const text = String(b.text || '').trim();
  if (!text) fail('送る文面を入力してください。');
  if (text.length > 4500) fail('文面が長すぎます。');
  const now = jstStamp(Date.now());
  const s = await getSettings(env);

  let sql;
  let args;
  let extra = null;
  if (b.mode === 'ok' || b.mode === 'ok2') {
    const date = b.mode === 'ok2' ? r.alt_date : r.date;
    const time = b.mode === 'ok2' ? r.alt_time : r.time;
    if (!date) fail('第2希望がありません。');
    if (now >= date + ' ' + time) fail('過ぎた日時は確定できません。日時を変更するか、お断りの返事をしてください。');
    if (!b.force && !(await fits(env, s, date, time, r.session, r.guests, r.id, r.course_id))) {
      return { ok: false, full: true, message: 'この日時は席数（またはメニューの上限人数）を超えます。それでも確定しますか？' };
    }
    sql = 'UPDATE reservations SET status = ?, date = ?, time = ?, hold_date = ?, hold_time = ?, updated_at = ? WHERE id = ? AND status = ?';
    args = [ST.OK, date, time, date, time, rev(), r.id, ST.WAIT];
    extra = myPageButton(env, 'ご予約の確認・キャンセルはこちら');
  } else if (b.mode === 'offer') {
    const o = b.offer || {};
    if (!isDate(o.date) || !isTime(o.time)) fail('提案する日時を選んでください。');
    const w = await loadWindow(env, o.date, o.date);
    const slot = daySlots(o.date, w.rules, s).find(x => x.time === o.time);
    if (!slot || slot.session !== r.session) fail('提案する日時を選び直してください。');
    if (now >= o.date + ' ' + o.time) fail('過ぎた日時は提案できません。');
    if (!b.force && !(await fits(env, s, o.date, o.time, r.session, r.guests, r.id, r.course_id))) {
      return { ok: false, full: true, message: '提案する日時は席数（またはメニューの上限人数）を超えます。それでも提案しますか？' };
    }
    sql = 'UPDATE reservations SET status = ?, offer_date = ?, offer_time = ?, hold_date = ?, hold_time = ?, updated_at = ? WHERE id = ? AND status = ?';
    args = [ST.OFFER, o.date, o.time, o.date, o.time, rev(), r.id, ST.WAIT];
    extra = {
      type: 'template',
      altText: 'ご提案：' + jd(o.date) + ' ' + o.time,
      template: {
        type: 'buttons',
        text: ('ご提案の日時\n' + jd(o.date) + ' ' + o.time + '　' + r.guests + '名').slice(0, 160),
        actions: [{ type: 'uri', label: '確認して返事をする', uri: appUrl(env, '?view=offer&id=' + encodeURIComponent(r.id)) }]
      }
    };
  } else if (b.mode === 'ng') {
    sql = 'UPDATE reservations SET status = ?, updated_at = ? WHERE id = ? AND status = ?';
    args = [ST.NG, rev(), r.id, ST.WAIT];
  } else {
    fail('返事の種類を選んでください。');
  }

  if (extra && !env.LIFF_ID) fail('LIFF_IDが未設定のため、ボタン付きのメッセージを送れません。');
  // 先に保存してから送る（送れなかったときは元に戻す）
  const up = await env.DB.prepare(sql).bind(...args).run();
  if (!up.meta.changes) fail('このリクエストはすでに返事済みです。画面を更新してください。');
  if (r.user_id && !b.skipLine) {
    const messages = [textMsg(text)];
    if (extra) messages.push(extra);
    const res = await linePush(env, r.user_id, messages);
    if (!res.ok) {
      await env.DB.prepare(
        'UPDATE reservations SET status = ?, date = ?, time = ?, offer_date = ?, offer_time = ?, hold_date = ?, hold_time = ?, updated_at = ? WHERE id = ?'
      ).bind(r.status, r.date, r.time, r.offer_date, r.offer_time, r.hold_date, r.hold_time, r.updated_at, r.id).run();
      fail('LINEを送れませんでした（' + res.message + '）。状態は変更していません。', 400, 'LINE_FAILED');
    }
  }
  return { requests: await adminRequestsData(env) };
}

async function fits(env, s, date, time, session, guests, excludeId, courseId, stay) {
  const w = await loadWindow(env, date, date);
  const idx = buildIndex(w.holds, w.blocks, s);
  if (leftAt(idx, date, time, session, excludeId, s, stay) < guests) return false;
  const course = courseId ? w.courses.find(c => c.id === courseId) : null;
  return courseLeft(w.holds, s, course, date, time, session, excludeId) >= guests;
}

async function adminDay(env, b) {
  const date = String(b.date || '');
  if (!isDate(date)) fail('日付が正しくありません。');
  const w = await loadWindow(env, date, date);
  const s = w.s;
  const plan = dayPlan(date, w.rules, s);
  const idx = buildIndex(w.holds, w.blocks, s);
  const chgIdx = buildIndex(w.holds.filter(h => h.chg), [], s);
  const tentIdx = buildIndex(w.holds.filter(h => h.chg || h.status === ST.WAIT || h.status === ST.OFFER), [], s);
  const slots = [];
  sessionKeys(s).forEach(k => sessionSlots(s, k).forEach(x => {
    const m = toMin(x.time);
    slots.push({
      time: x.time, session: k, open: plan.sessions.indexOf(k) >= 0,
      used: usedAt(idx, date, m, null), pending: usedAt(chgIdx, date, m, null), tentative: usedAt(tentIdx, date, m, null),
      stopped: stoppedAt(idx, date, m)
    });
  }));
  const rs = await env.DB.batch([
    env.DB.prepare("SELECT * FROM reservations WHERE hold_date = ? AND status IN ('返事待ち','提案中','確定','キャンセル') ORDER BY hold_time").bind(date),
    env.DB.prepare('SELECT * FROM blocks WHERE date = ? ORDER BY start').bind(date),
    env.DB.prepare("SELECT c.*, r.name AS name, r.date AS old_date, r.time AS old_time, r.guests AS old_guests, r.course_name AS old_course FROM change_requests c JOIN reservations r ON r.id = c.res_id WHERE c.status = '返事待ち' AND (c.date = ? OR r.hold_date = ?)").bind(date, date)
  ]);
  const [allRows, info] = await Promise.all([allCustomerRows(env), customerInfo(env)]);
  const grouped = groupCustomers(allRows, info);
  const memos = {};
  Object.keys(info).forEach(k => { memos[k] = info[k].memo; });
  const today = jstStamp(Date.now()).slice(0, 10);
  const withCustomer = r => {
    const v = adminView(r);
    const key = grouped.keyOf[r.id];
    if (key) {
      const g = grouped.groups[key];
      const before = g.rows.filter(x => x.id !== r.id && isVisit(x, today) && (x.date + x.time) < (r.date + r.time)).length;
      v.custKey = key;
      v.visitNo = before + 1 + (info[key] ? info[key].extra : 0);
      v.custMemo = memos[key] || '';
    }
    return v;
  };
  // 来店前メモ（作ってあるものだけ。まだのものは画面から作る）
  let memo = { memos: {}, missing: [] };
  if (env.ANTHROPIC_API_KEY && date >= today) memo = await dayMemos(env, rs[0].results, false, { grouped: grouped, info: info });
  return {
    date: date, plan: plan, seats: s.seats, slots: slots, aiMemos: memo.memos, aiMissing: memo.missing,
    reservations: rs[0].results.map(withCustomer),
    blocks: rs[1].results,
    changes: rs[2].results.map(c => ({
      id: c.id, resId: c.res_id, name: c.name, date: c.date, time: c.time, guests: c.guests, course: c.course_name,
      oldDate: c.old_date, oldTime: c.old_time, oldGuests: c.old_guests, oldCourse: c.old_course
    }))
  };
}

async function adminAddPhone(env, d) {
  const s = await getSettings(env);
  if (!isDate(d.date) || !isTime(d.time)) fail('日付と時間を選んでください。');
  const slot = sessionKeys(s).map(k => sessionSlots(s, k)).flat().find(x => x.time === d.time);
  if (!slot) fail('時間を選び直してください。');
  const guests = Math.round(Number(d.guests));
  if (!(guests >= 1 && guests <= 200)) fail('人数を入力してください。');
  const name = clean(d.name, 40);
  if (!name) fail('お名前を入力してください。');
  let stay = null;
  if (d.until) {
    if (!isTime(d.until)) fail('「何時まで」を選び直してください。');
    stay = toMin(d.until) - toMin(d.time);
    if (stay < 15 || stay > 720) fail('「何時まで」は、開始の15分後から12時間以内で選んでください。');
    if (s.sessions[slot.session] && stay === Number(s.sessions[slot.session].stay)) stay = null; // いつもの長さなら記録しない
  }
  if (!d.force && !(await fits(env, s, d.date, d.time, slot.session, guests, null, d.courseId || '', stay))) {
    const w0 = await loadWindow(env, d.date, d.date);
    const stopped = stoppedAt(buildIndex(w0.holds, w0.blocks, s), d.date, toMin(d.time));
    return { ok: false, full: true, message: stopped ? 'この時間はネット予約の受付を止めています。それでも追加しますか？' : 'この時間は席数（またはメニューの上限人数）を超えます。それでも追加しますか？' };
  }
  const now = jstStamp(Date.now());
  await env.DB.prepare(
    'INSERT INTO reservations (id, created_at, updated_at, status, date, time, session, guests, name, phone, course_id, course_name, note, alt_date, alt_time, offer_date, offer_time, hold_date, hold_time, hold_session, source, user_id, line_name, reminded_at, memo, stay) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, \'\', \'\', \'\', \'\', ?, ?, ?, ?, \'\', \'\', NULL, \'\', ?)'
  ).bind(newId('R'), now, rev(), ST.OK, d.date, d.time, slot.session, guests, name,
    String(d.phone || '').replace(/[^\d-]/g, '').slice(0, 20), String(d.courseId || ''),
    clean(d.courseName, 60) || '当日決定', clean(d.note, 300), d.date, d.time, slot.session,
    clean(d.source, 20) || '電話', stay).run();
  return {};
}

async function adminCancel(env, b) {
  const r = await env.DB.prepare('SELECT * FROM reservations WHERE id = ?').bind(String(b.id || '')).first();
  if (!r) fail('予約が見つかりません。');
  if ([ST.WAIT, ST.OFFER, ST.OK].indexOf(r.status) < 0) fail('この予約はすでに終了しています。');
  const text = String(b.text || '').trim();
  const up = await env.DB.prepare("UPDATE reservations SET status = ?, updated_at = ?, memo = 'お店側でキャンセル' WHERE id = ? AND status = ?")
    .bind(ST.CANCEL, rev(), r.id, r.status).run();
  if (!up.meta.changes) fail('この予約はほかの操作で変わりました。画面を更新してください。', 409);
  if (text && r.user_id) {
    const res = await linePush(env, r.user_id, [textMsg(text)]);
    if (!res.ok) {
      await env.DB.prepare('UPDATE reservations SET status = ?, updated_at = ?, memo = ? WHERE id = ?')
        .bind(r.status, r.updated_at, r.memo || '', r.id).run();
      fail('LINEを送れませんでした（' + res.message + '）。キャンセルはしていません。');
    }
  }
  await withdrawChanges(env, r.id);
  return {};
}

// 確定した予約の内容を変更する（LINEで予約した人には、日時・人数・メニューの変更をLINEで知らせる）
async function adminEdit(env, b) {
  const r = await env.DB.prepare('SELECT * FROM reservations WHERE id = ?').bind(String(b.id || '')).first();
  if (!r) fail('予約が見つかりません。');
  if (r.status !== ST.OK) fail('確定した予約だけ変更できます。画面を更新してください。');
  if (b.updatedAt && b.updatedAt !== r.updated_at) fail('この予約はほかの操作で変わりました。画面を更新してから、もう一度変更してください。', 409);

  const date = String(b.date || '');
  const time = String(b.time || '');
  if (!isDate(date) || !isTime(time)) fail('日付と時間を選んでください。');
  const guests = Math.round(Number(b.guests));
  if (!(guests >= 1 && guests <= 200)) fail('人数を入力してください。');
  const name = clean(b.name, 40);
  if (!name) fail('お名前を入力してください。');
  const phone = String(b.phone || '').replace(/[^\d-]/g, '').slice(0, 20);
  const note = clean(b.note, 300);
  const now = jstStamp(Date.now());
  if (now >= date + ' ' + time) fail('過ぎた日時には変更できません。');

  const w = await loadWindow(env, date, date);
  const s = w.s;
  const cover = sessionsAt(date, time, w.rules, s);
  if (!cover.length) fail('選んだ日時は営業していません。営業日の設定を確認するか、別の日時を選んでください。');

  let courseId = '';
  let courseName = '当日決定';
  const warnings = [];
  let slot = { time: time, session: cover[0] };
  if (b.courseId) {
    const c = w.courses.find(x => x.id === b.courseId);
    if (!c) fail('メニューを選び直してください。');
    courseId = c.id;
    courseName = c.name;
    slot = { time: time, session: sessionFor(date, time, w.rules, s, c) || cover[0] };
    const why = courseCheck(c, date, time, slot.session, guests, now, s, true);
    if (why === 'session') warnings.push('「' + c.name + '」は' + sessionLabel(s, slot.session) + 'では出していないメニューです。');
    if (why === 'weekday') warnings.push('「' + c.name + '」は' + WD[weekday(date)] + '曜日に出していないメニューです。');
    if (why === 'guests') warnings.push('「' + c.name + '」は' + c.min_guests + '名様からのメニューです。');
  }
  const idx = buildIndex(w.holds, w.blocks, s);
  const left = leftAt(idx, date, time, slot.session, r.id, s);
  if (left < guests) warnings.push('この日時は席数を超えます（空き' + left + '席）。');
  const cc = courseId ? w.courses.find(x => x.id === courseId) : null;
  if (cc && cc.cap) {
    const cl = courseLeft(w.holds, s, cc, date, time, slot.session, r.id);
    if (cl < guests) warnings.push('「' + cc.name + '」の上限人数を超えます（あと' + cl + '名）。');
  }
  if (warnings.length && !b.force) {
    return { ok: false, confirm: true, message: warnings.join('\n') + '\nそれでも変更しますか？' };
  }

  const important = date !== r.date || time !== r.time || guests !== Number(r.guests) || courseName !== r.course_name;
  const text = String(b.text || '').trim();
  if (important && r.user_id) {
    if (!text) fail('お客様に送る文面を入力してください。');
    if (text.length > 4500) fail('文面が長すぎます。');
  }
  let sent = false;

  const up = await env.DB.prepare(
    'UPDATE reservations SET date = ?, time = ?, session = ?, guests = ?, course_id = ?, course_name = ?, name = ?, phone = ?, note = ?, ' +
    'hold_date = ?, hold_time = ?, hold_session = ?, updated_at = ?, memo = ? WHERE id = ? AND status = ? AND updated_at = ?'
  ).bind(date, time, slot.session, guests, courseId, courseName, name, phone, note,
    date, time, slot.session, rev(), important ? 'お店で変更（' + now + '）' : (r.memo || ''),
    r.id, ST.OK, r.updated_at).run();
  if (!up.meta.changes) {
    fail('この予約はほかの操作で変わりました。画面を更新してから、もう一度変更してください。', 409);
  }
  // 先に保存してから送る（送れなかったときは元に戻す。戻すと席が足りない場合はそのまま）
  if (important && r.user_id) {
    const res = await linePush(env, r.user_id, [textMsg(text), myPageButton(env, 'ご予約の確認・キャンセルはこちら')]);
    if (!res.ok) {
      if (!(await fits(env, s, r.date, r.time, r.session, Number(r.guests), r.id))) {
        await env.DB.prepare("UPDATE reservations SET memo = ? WHERE id = ?")
          .bind('LINE未達（' + now + '）要電話連絡', r.id).run();
        fail('LINEを送れませんでした（' + res.message + '）。元の日時はすでに埋まっているため、変更した内容のまま保存しました。お客様にはお電話でご連絡ください。', 400, 'LINE_FAILED_KEPT');
      }
      await env.DB.prepare(
        'UPDATE reservations SET date = ?, time = ?, session = ?, guests = ?, course_id = ?, course_name = ?, name = ?, phone = ?, note = ?, hold_date = ?, hold_time = ?, hold_session = ?, updated_at = ?, memo = ? WHERE id = ?'
      ).bind(r.date, r.time, r.session, r.guests, r.course_id, r.course_name, r.name, r.phone, r.note,
        r.hold_date, r.hold_time, r.hold_session, r.updated_at, r.memo || '', r.id).run();
      fail('LINEを送れませんでした（' + res.message + '）。変更は保存していません。');
    }
    sent = true;
  }
  return { sent: sent, date: date };
}

function normPhone(v) {
  return String(v || '').replace(/[^\d]/g, '').slice(0, 15);
}

// お名前の表記ゆれをそろえる（空白・様・全角半角）
function normName(v) {
  return String(v || '').normalize('NFKC').replace(/\s/g, '').replace(/(様|さま|さん)$/, '');
}

// 名前のない押さえ（「電話の予約」など）はお客様として数えない
function isPlaceholderName(n) {
  return !n || /の予約$/.test(n) || n === '当日決定';
}

// 予約をお客様ごとにまとめる：電話番号があれば電話番号、なければお名前
// 電話番号のない予約は、同じお名前の電話番号ありのお客様が1人だけならそこに合流させる
function groupCustomers(rows, info) {
  info = info || {};
  const groups = {};
  const byName = {};
  const keyOf = {};
  // 手入力で登録した電話番号も、名前の合流先に使う
  Object.values(info).forEach(c => {
    const p = normPhone(c.tel || (/^\d{8,}$/.test(c.key) ? c.key : ''));
    const nn = normName(c.name);
    if (p.length >= 8 && nn && !c.merged) (byName[nn] = byName[nn] || {})[p] = true;
  });
  rows.forEach(r => {
    const p = normPhone(r.phone);
    if (p.length < 8) return;
    const g = groups[p] || (groups[p] = { key: p, phone: p, name: r.name, rows: [] });
    g.rows.push(r);
    keyOf[r.id] = p;
    const nn = normName(r.name);
    if (nn && !isPlaceholderName(nn)) (byName[nn] = byName[nn] || {})[p] = true;
  });
  rows.forEach(r => {
    if (normPhone(r.phone).length >= 8) return;
    const nn = normName(r.name);
    if (isPlaceholderName(nn)) return;
    const phones = Object.keys(byName[nn] || {});
    let key;
    if (phones.length === 1) {
      key = phones[0];
    } else {
      key = 'n:' + nn;
      if (!groups[key]) groups[key] = { key: key, phone: '', name: r.name, rows: [] };
    }
    groups[key].rows.push(r);
    keyOf[r.id] = key;
  });
  // 予約がまだない、手入力のお客様
  Object.values(info).forEach(c => {
    if (c.merged || groups[c.key] || !c.name) return;
    groups[c.key] = { key: c.key, phone: normPhone(c.tel || (/^\d{8,}$/.test(c.key) ? c.key : '')), name: c.name, rows: [] };
  });
  // 合体：まとめた側の予約を、まとめ先に移す
  Object.keys(groups).forEach(k => {
    const to = mergedTarget(info, k);
    if (to === k) return;
    const src = groups[k];
    const dst = groups[to] || (groups[to] = { key: to, phone: normPhone((info[to] && info[to].tel) || (/^\d{8,}$/.test(to) ? to : '')), name: (info[to] && info[to].name) || src.name, rows: [] });
    src.rows.forEach(r => { dst.rows.push(r); keyOf[r.id] = to; });
    if (!dst.phone && src.phone) dst.phone = src.phone;
    delete groups[k];
  });
  Object.values(groups).forEach(g => {
    if (info[g.key] && info[g.key].name) g.name = info[g.key].name;
    if (info[g.key] && info[g.key].tel && !g.phone) g.phone = normPhone(info[g.key].tel);
    g.rows.sort((a, b) => (b.date + b.time).localeCompare(a.date + a.time));
  });
  return { groups: groups, keyOf: keyOf };
}

// 来店とみなす：確定していて、過ぎた日か来店チェック済み（来店なしは除く）
function isVisit(r, today) {
  return r.status === '確定' && r.arrived !== 'no' && (r.date < today || r.arrived === 'yes');
}

async function allCustomerRows(env) {
  return (await env.DB.prepare(
    "SELECT id, phone, name, date, time, status, arrived, guests, course_name, note, source, user_id FROM reservations WHERE status IN ('確定','キャンセル','返事待ち','提案中') ORDER BY date DESC, time DESC"
  ).all()).results;
}

// お客様ごとの手入力の情報（メモ・名前・電話・予約なしの来店・合体先）
async function customerInfo(env) {
  const map = {};
  (await env.DB.prepare('SELECT * FROM customers').all()).results.forEach(m => {
    map[m.phone] = { key: m.phone, memo: m.memo || '', name: m.name || '', tel: m.tel || '', extra: Number(m.extra_visits) || 0, merged: m.merged_into || '' };
  });
  return map;
}
async function customerMemos(env) {
  const info = await customerInfo(env);
  const memos = {};
  Object.keys(info).forEach(k => { memos[k] = info[k].memo; });
  return memos;
}

// 合体先をたどる（循環しないよう最大5回）
function mergedTarget(info, key) {
  let k = key;
  for (let i = 0; i < 5 && info[k] && info[k].merged; i++) k = info[k].merged;
  return k;
}

// かな・カナの違いもそろえた名前（表記ゆれの候補探し用）
function foldName(v) {
  return normName(v).replace(/[\u30a1-\u30f6]/g, c => String.fromCharCode(c.charCodeAt(0) - 0x60)).toLowerCase();
}

// お客様台帳
function customerSummary(c, info, today) {
  const extra = info[c.key] ? info[c.key].extra : 0;
  const out = { key: c.key, phone: c.phone, name: c.name, visits: 0, extra: extra, noShows: 0, cancels: 0, last: '', next: '', notes: [], memo: info[c.key] ? info[c.key].memo : '', sources: [] };
  c.rows.forEach(r => {
    if (r.status === 'キャンセル') out.cancels++;
    else if (r.status === '確定' && r.arrived === 'no') out.noShows++;
    else if (isVisit(r, today)) { out.visits++; if (!out.last) out.last = r.date; }
    else if (r.date >= today && (!out.next || r.date < out.next)) out.next = r.date;
    if (r.note && out.notes.indexOf(r.note) < 0 && out.notes.length < 3) out.notes.push(r.note);
    if (r.source && out.sources.indexOf(r.source) < 0) out.sources.push(r.source);
  });
  out.total = out.visits + out.extra;
  return out;
}

async function adminCustomers(env, b) {
  const q = clean(b.q, 40);
  const today = jstStamp(Date.now()).slice(0, 10);
  const [rows, info] = await Promise.all([allCustomerRows(env), customerInfo(env)]);
  const g = groupCustomers(rows, info).groups;
  let list = Object.values(g).map(c => customerSummary(c, info, today));
  // 表記ゆれかもしれない組（名前がかな・カナ・空白の違いだけで同じ）
  const byFold = {};
  list.forEach(c => { const f = foldName(c.name); if (f && !isPlaceholderName(f)) (byFold[f] = byFold[f] || []).push(c); });
  const dupes = Object.values(byFold).filter(x => x.length > 1).slice(0, 20)
    .map(x => x.map(c => ({ key: c.key, name: c.name, phone: c.phone, total: c.total })));
  if (q) {
    const qn = foldName(q);
    const qp = q.replace(/[^\d]/g, '');
    list = list.filter(c => foldName(c.name).indexOf(qn) >= 0 || (qp && c.phone.indexOf(qp) >= 0));
  }
  list.sort((a, b) => (b.next ? 1 : 0) - (a.next ? 1 : 0) || (a.next || '').localeCompare(b.next || '') || (b.last || '').localeCompare(a.last || '') || b.total - a.total);
  return { customers: list.slice(0, 500), total: list.length, dupes: q ? [] : dupes };
}

async function adminCustomer(env, b) {
  const key = String(b.key || b.phone || '').slice(0, 60);
  if (!key) fail('お客様が見つかりません。');
  const [rows, info] = await Promise.all([allCustomerRows(env), customerInfo(env)]);
  const target = mergedTarget(info, key);
  const c = groupCustomers(rows, info).groups[target];
  if (!c) fail('お客様が見つかりません。');
  const today = jstStamp(Date.now()).slice(0, 10);
  const sum = customerSummary(c, info, today);
  const full = c.rows.length ? (await env.DB.prepare(
    'SELECT * FROM reservations WHERE id IN (' + c.rows.map(() => '?').join(',') + ') ORDER BY date DESC, time DESC'
  ).bind(...c.rows.map(r => r.id)).all()).results : [];
  const merged = Object.values(info).filter(x => x.merged === target).map(x => ({ key: x.key, name: x.name || x.key.replace(/^n:/, '') }));
  const uids = c.rows.map(r => r.user_id).filter((x, i, a) => x && a.indexOf(x) === i);
  let views = { opens: 0, days: 0, last: '' };
  if (uids.length) {
    const v = await env.DB.prepare("SELECT COUNT(*) AS opens, COUNT(DISTINCT date) AS days, MAX(date) AS last FROM events WHERE kind = 'open' AND user_id IN (" + uids.map(() => '?').join(',') + ')')
      .bind(...uids).first();
    if (v) views = { opens: v.opens || 0, days: v.days || 0, last: v.last || '' };
  }
  return Object.assign(sum, {
    key: target, tel: info[target] ? info[target].tel : '', manual: !!(info[target] && info[target].name),
    history: full.map(adminView), merged: merged, views: views
  });
}

// お客様の手入力の情報を保存（書かれていない項目はそのまま）
async function upsertCustomer(env, key, patch) {
  const cur = await env.DB.prepare('SELECT * FROM customers WHERE phone = ?').bind(key).first();
  const now = jstStamp(Date.now());
  const v = {
    memo: patch.memo !== undefined ? clean(patch.memo, 500) : (cur ? cur.memo : ''),
    name: patch.name !== undefined ? clean(patch.name, 40) : (cur ? cur.name : ''),
    tel: patch.tel !== undefined ? String(patch.tel || '').replace(/[^\d-]/g, '').slice(0, 20) : (cur ? cur.tel : ''),
    extra: patch.extra !== undefined ? Math.max(0, Math.min(9999, Math.round(Number(patch.extra) || 0))) : (cur ? Number(cur.extra_visits) || 0 : 0),
    merged: patch.merged !== undefined ? patch.merged : (cur ? cur.merged_into : null)
  };
  await env.DB.prepare('INSERT OR REPLACE INTO customers (phone, memo, updated_at, name, tel, extra_visits, merged_into, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .bind(key, v.memo, now, v.name, v.tel, v.extra, v.merged || null, cur && cur.created_at ? cur.created_at : now).run();
}

async function adminAddCustomer(env, b) {
  const name = clean(b.name, 40);
  if (!name) fail('お名前を入力してください。');
  const tel = String(b.tel || '').replace(/[^\d-]/g, '').slice(0, 20);
  const digits = normPhone(tel);
  if (digits && digits.length < 10) fail('電話番号を正しく入力してください。');
  const key = digits.length >= 10 ? digits : 'n:' + normName(name);
  const [rows, info] = await Promise.all([allCustomerRows(env), customerInfo(env)]);
  const groups = groupCustomers(rows, info).groups;
  if (groups[key] || groups[mergedTarget(info, key)]) {
    return { ok: false, exists: true, key: mergedTarget(info, key), message: 'このお客様はすでに登録されています。' };
  }
  await upsertCustomer(env, key, { name: name, tel: tel, memo: b.memo || '', extra: b.extra || 0, merged: null });
  return { key: key };
}

async function adminMergeCustomers(env, b) {
  const from = String(b.from || '').slice(0, 60);
  const into = String(b.into || '').slice(0, 60);
  if (!from || !into || from === into) fail('まとめるお客様を選んでください。');
  const info = await customerInfo(env);
  if (mergedTarget(info, into) === from) fail('この組み合わせではまとめられません。');
  const src = info[from] || { memo: '', extra: 0 };
  const dst = info[into] || { memo: '', extra: 0, name: '' };
  const [rows] = await Promise.all([allCustomerRows(env)]);
  const groups = groupCustomers(rows, info).groups;
  const dstName = (groups[into] && groups[into].name) || dst.name || '';
  const memo = [dst.memo, src.memo].filter(Boolean).filter((x, i, a) => a.indexOf(x) === i).join('\n');
  await upsertCustomer(env, into, { memo: memo, extra: (dst.extra || 0) + (src.extra || 0), name: dst.name || dstName });
  await upsertCustomer(env, from, { merged: into, extra: 0 });
  return { key: into };
}

async function adminAddBlock(env, b) {
  const date = String(b.date || '');
  if (!isDate(date)) fail('日付が正しくありません。');
  const type = b.type === 'stop' ? 'stop' : 'seats';
  if (!isTime(b.start) || !isTime(b.end)) fail('時間を選んでください。');
  if (toMin(b.end) <= toMin(b.start)) fail('終わりの時間は、始まりの時間より後にしてください。');
  let seats = null;
  if (type === 'seats' && !b.allSeats) {
    seats = Math.round(Number(b.seats));
    if (!(seats >= 1 && seats <= 200)) fail('押さえる席数を入力してください。');
  }
  const id = newId('B');
  await env.DB.prepare('INSERT INTO blocks (id, date, type, start, end, seats, memo, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .bind(id, date, type, b.start, b.end, seats, clean(b.memo, 100), jstStamp(Date.now())).run();
  return { id: id };
}

async function adminMonth(env, b) {
  const ym = String(b.ym || '');
  if (!/^\d{4}-\d{2}$/.test(ym)) fail('月が正しくありません。');
  const [y, m] = ym.split('-').map(Number);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const from = ym + '-01';
  const to = ym + '-' + pad(last);
  const s = await getSettings(env);
  const rs = await env.DB.batch([
    env.DB.prepare('SELECT date, kind, sessions FROM day_rules WHERE date BETWEEN ? AND ?').bind(from, to),
    env.DB.prepare('SELECT hold_date AS date, SUM(guests) AS n FROM reservations WHERE hold_date BETWEEN ? AND ? AND status IN ' + HOLDING_SQL + ' GROUP BY hold_date').bind(from, to),
    env.DB.prepare('SELECT date, COUNT(*) AS n FROM blocks WHERE date BETWEEN ? AND ? GROUP BY date').bind(from, to)
  ]);
  const rules = rulesMap(rs[0].results);
  const guests = {};
  rs[1].results.forEach(x => { guests[x.date] = x.n; });
  const blocks = {};
  rs[2].results.forEach(x => { blocks[x.date] = x.n; });
  const days = [];
  for (let d = 1; d <= last; d++) {
    const date = ym + '-' + pad(d);
    days.push({ date: date, plan: dayPlan(date, rules, s), guests: guests[date] || 0, blocks: blocks[date] || 0 });
  }
  return { now: jstStamp(Date.now()), days: days };
}

async function adminSetDay(env, b) {
  const date = String(b.date || '');
  if (!isDate(date)) fail('日付が正しくありません。');
  const s = await getSettings(env);
  if (b.revert) {
    await env.DB.prepare('DELETE FROM day_rules WHERE date = ?').bind(date).run();
  } else {
    const kind = ['open', 'off', 'private'].indexOf(b.kind) >= 0 ? b.kind : 'open';
    const keys = sessionKeys(s);
    const sessions = kind === 'open' ? (b.sessions || []).filter(k => keys.indexOf(k) >= 0) : [];
    await env.DB.prepare('INSERT OR REPLACE INTO day_rules (date, kind, sessions) VALUES (?, ?, ?)')
      .bind(date, kind === 'open' && !sessions.length ? 'off' : kind, sessions.join(',')).run();
  }
  const n = await env.DB.prepare('SELECT COUNT(*) AS n FROM reservations WHERE hold_date = ? AND status IN ' + HOLDING_SQL).bind(date).first();
  return { warning: n && n.n ? 'この日にはすでに予約・リクエストが' + n.n + '件あります。必要に応じてお客様へご連絡ください。' : '' };
}

async function adminSaveSettings(env, v) {
  v = v || {};
  const num = (x, min, max, label) => {
    const k = Number(x);
    if (!(k >= min && k <= max) || Math.floor(k) !== k) fail(label + 'は' + min + '〜' + max + 'の整数で入力してください。');
    return k;
  };
  const time = (x, label) => {
    if (!isTime(x)) fail(label + 'は「18:00」の形で入力してください。');
    return String(x);
  };
  const inSessions = v.sessions && Object.keys(v.sessions).length ? v.sessions : DEFAULT_SETTINGS.sessions;
  const keys = Object.keys(inSessions);
  if (!keys.length) fail('時間帯を1つ以上つくってください。');
  if (keys.length > 6) fail('時間帯は6つまでです。');
  const sessions = {};
  keys.forEach(k => {
    if (!/^[a-z0-9_]{1,20}$/.test(k)) fail('時間帯の内部名が正しくありません。');
    const o = inSessions[k] || {};
    const label = clean(o.name, 20) || DEFAULT_SESSION_NAME[k] || k;
    const c = {
      name: label, en: clean(o.en, 24), short: clean(o.short, 2) || label.slice(0, 1),
      open: time(o.open, label + 'の開店時間'), close: time(o.close, label + 'の閉店時間'),
      first: time(o.first, label + 'の最初の予約時間'), last: time(o.last, label + 'の最後の予約時間'),
      interval: num(o.interval, 10, 120, label + 'の予約の間隔'), stay: num(o.stay, 30, 360, label + 'の滞在時間')
    };
    if (toMin(c.open) >= toMin(c.close)) fail(label + 'の閉店時間は、開店時間より後にしてください。');
    if (toMin(c.first) > toMin(c.last)) fail(label + 'の最後の予約時間は、最初の予約時間より後にしてください。');
    if (toMin(c.first) < toMin(c.open)) fail(label + 'の最初の予約時間は、開店時間以降にしてください。');
    if (toMin(c.last) > toMin(c.close)) fail(label + 'の最後の予約時間は、閉店時間までにしてください。');
    if (keys.filter(x => clean(inSessions[x].name, 20) === label).length > 1) fail('「' + label + '」と同じ名前の時間帯があります。');
    sessions[k] = c;
  });
  const order = keys.slice().sort((a, b) => toMin(sessions[a].first) - toMin(sessions[b].first));
  const weekly = {};
  ALL_WEEK.forEach(d => {
    const list = ((v.weekly || {})[String(d)] || []).filter(k => order.indexOf(k) >= 0);
    weekly[String(d)] = order.filter(k => list.indexOf(k) >= 0);
  });
  const out = {
    seats: num(v.seats, 1, 200, '総席数'),
    maxGuests: num(v.maxGuests, 1, 50, 'ネット予約の最大人数'),
    aheadDays: num(v.aheadDays, 7, 365, '受付の開始'),
    openUntil: (() => {
      if (!v.openUntil) return '';
      if (!isDate(v.openUntil)) fail('予約を受け付ける最終日を選び直してください。');
      return String(v.openUntil);
    })(),
    cancelDays: num(v.cancelDays, 0, 60, 'キャンセルの期限'),
    remindHours: num(v.remindHours, 1, 72, '再通知までの時間'),
    maxActive: num(v.maxActive, 1, 10, '1人が同時に申し込める数'),
    replyHint: clean(v.replyHint, 30) || DEFAULT_SETTINGS.replyHint,
    cutoff: { days: num((v.cutoff || {}).days, 0, 60, '締切の日数'), time: time((v.cutoff || {}).time, '締切の時刻') },
    changeCutoff: {
      days: num((v.changeCutoff || {}).days, 0, 60, '変更の締切の日数'),
      time: time((v.changeCutoff || {}).time, '変更の締切の時刻')
    },
    weekly: weekly,
    sessions: sessions
  };
  await env.DB.prepare("INSERT OR REPLACE INTO kv (k, v) VALUES ('settings', ?)").bind(JSON.stringify(out)).run();
  return { settings: parseSettings({ v: JSON.stringify(out) }) };
}

async function adminSaveCourse(env, c) {
  c = c || {};
  const name = clean(c.name, 40);
  if (!name) fail('メニュー名を入力してください。');
  const price = Math.round(Number(c.price));
  if (!(price >= 0 && price <= 10000000)) fail('料金を入力してください。');
  const priceType = c.price_type === 'from' ? 'from' : 'fixed';
  const settings = await getSettings(env);
  const keys = sessionKeys(settings);
  const sessions = keys.filter(k => (c.sessions || []).indexOf(k) >= 0);
  if (!sessions.length) fail('選べる時間帯を1つ以上選んでください。');
  const weekdays = ALL_WEEK.filter(d => (c.weekdays || []).map(Number).indexOf(d) >= 0);
  if (!weekdays.length) fail('公開する曜日を1つ以上選んでください。');
  const minGuests = Math.round(Number(c.min_guests) || 1);
  if (!(minGuests >= 1 && minGuests <= 50)) fail('最少人数は1〜50で入力してください。');
  const mode = c.cutoff_mode === 'custom' ? 'custom' : 'default';
  const days = Math.round(Number(c.cutoff_days) || 0);
  if (mode === 'custom' && !(days >= 0 && days <= 60)) fail('締切の日数は0〜60で入力してください。');
  if (mode === 'custom' && !isTime(c.cutoff_time)) fail('締切の時刻を「10:00」の形で入力してください。');
  const cutoffTime = isTime(c.cutoff_time) ? c.cutoff_time : '23:59';
  const chgMode = c.chg_mode === 'custom' ? 'custom' : 'default';
  const chgDays = Math.round(Number(c.chg_days) || 0);
  if (chgMode === 'custom' && !(chgDays >= 0 && chgDays <= 60)) fail('変更の締切の日数は0〜60で入力してください。');
  if (chgMode === 'custom' && !isTime(c.chg_time)) fail('変更の締切の時刻を「10:00」の形で入力してください。');
  const chgTime = isTime(c.chg_time) ? c.chg_time : '23:59';
  const cap = c.cap === '' || c.cap === null || c.cap === undefined || Number(c.cap) <= 0 ? null : Math.min(200, Math.round(Number(c.cap)));

  const dup = await env.DB.prepare('SELECT id FROM courses WHERE name = ? AND id != ?').bind(name, String(c.id || '')).first();
  if (dup) fail('同じ名前のメニューがすでにあります。');
  const cur = c.id ? await env.DB.prepare('SELECT id FROM courses WHERE id = ?').bind(String(c.id)).first() : null;
  if (cur) {
    await env.DB.prepare('UPDATE courses SET name = ?, price = ?, price_type = ?, description = ?, sessions = ?, weekdays = ?, min_guests = ?, cutoff_mode = ?, cutoff_days = ?, cutoff_time = ?, chg_mode = ?, chg_days = ?, chg_time = ?, cap = ? WHERE id = ?')
      .bind(name, price, priceType, clean(c.description, 120), sessions.join(','), weekdays.join(','), minGuests, mode, days, cutoffTime, chgMode, chgDays, chgTime, cap, cur.id).run();
  } else {
    const max = await env.DB.prepare('SELECT COALESCE(MAX(sort), 0) AS m FROM courses').first();
    await env.DB.prepare('INSERT INTO courses (id, sort, visible, name, price, price_type, description, sessions, weekdays, min_guests, cutoff_mode, cutoff_days, cutoff_time, chg_mode, chg_days, chg_time, cap) VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .bind(newId('C'), max.m + 1, name, price, priceType, clean(c.description, 120), sessions.join(','), weekdays.join(','), minGuests, mode, days, cutoffTime, chgMode, chgDays, chgTime, cap).run();
  }
  return { courses: await allCourses(env) };
}

async function adminMoveCourse(env, b) {
  const list = await allCourses(env);
  const i = list.findIndex(c => c.id === b.id);
  const j = i + (Number(b.dir) < 0 ? -1 : 1);
  if (i >= 0 && j >= 0 && j < list.length) {
    const tmp = list[i];
    list[i] = list[j];
    list[j] = tmp;
    await env.DB.batch(list.map((c, k) => env.DB.prepare('UPDATE courses SET sort = ? WHERE id = ?').bind(k + 1, c.id)));
  }
  return { courses: await allCourses(env) };
}

function weekdayTotals(rows) {
  const out = [0, 0, 0, 0, 0, 0, 0];
  rows.forEach(r => { out[weekday(r.t_date)] += r.users; });
  return out;
}

// 予約ページの利用状況を集計する
async function adminAnalytics(env, b) {
  const days = [7, 30, 90].indexOf(Number(b.days)) >= 0 ? Number(b.days) : 30;
  const today = jstStamp(Date.now()).slice(0, 10);
  const from = addDays(today, -(days - 1));
  const q = (sql, ...args) => env.DB.prepare(sql).bind(...args);
  const rs = await env.DB.batch([
    q("SELECT date, COUNT(*) AS opens, COUNT(DISTINCT user_id) AS users FROM events WHERE kind = 'open' AND date >= ? GROUP BY date", from),
    q("SELECT kind, COUNT(DISTINCT user_id) AS users FROM events WHERE date >= ? GROUP BY kind", from),
    q("SELECT t_date, COUNT(DISTINCT user_id) AS users FROM events WHERE kind = 'date' AND date >= ? AND t_date IS NOT NULL GROUP BY t_date ORDER BY users DESC LIMIT 10", from),
    q("SELECT t_date, extra, COUNT(DISTINCT user_id) AS users FROM events WHERE kind = 'blocked' AND date >= ? AND t_date IS NOT NULL GROUP BY t_date, extra ORDER BY users DESC LIMIT 10", from),
    q("SELECT course_id, COUNT(DISTINCT user_id) AS users FROM events WHERE kind IN ('course', 'filter') AND date >= ? AND course_id IS NOT NULL GROUP BY course_id ORDER BY users DESC", from),
    q("SELECT course_id, COUNT(*) AS n FROM events WHERE kind = 'request' AND date >= ? AND course_id IS NOT NULL GROUP BY course_id", from),
    q("SELECT src, COUNT(DISTINCT user_id) AS users, COUNT(*) AS opens FROM events WHERE kind = 'open' AND date >= ? GROUP BY src ORDER BY users DESC", from),
    q("SELECT user_id, COUNT(DISTINCT date) AS days, COUNT(*) AS opens, MAX(date) AS last FROM events WHERE kind = 'open' AND date >= ? AND user_id IS NOT NULL GROUP BY user_id", from),
    q('SELECT DISTINCT user_id FROM reservations WHERE user_id IS NOT NULL AND created_at >= ?', from),
    q("SELECT substr(ts, 12, 2) AS h, COUNT(*) AS n FROM events WHERE kind = 'open' AND date >= ? GROUP BY h", from),
    q("SELECT t_date, COUNT(DISTINCT user_id) AS users FROM events WHERE kind = 'date' AND date >= ? AND t_date IS NOT NULL GROUP BY t_date", from),
    q("SELECT t_date, COUNT(DISTINCT user_id) AS users FROM events WHERE kind = 'blocked' AND date >= ? AND t_date IS NOT NULL GROUP BY t_date", from)
  ]);
  const daily = [];
  const byDate = {};
  rs[0].results.forEach(r => { byDate[r.date] = r; });
  for (let d = from; d <= today; d = addDays(d, 1)) daily.push({ date: d, opens: byDate[d] ? byDate[d].opens : 0, users: byDate[d] ? byDate[d].users : 0 });
  const funnel = {};
  rs[1].results.forEach(r => { funnel[r.kind] = r.users; });
  const courses = await allCourses(env);
  const cname = id => { const c = courses.find(x => x.id === id); return c ? c.name : '（削除したメニュー）'; };
  const reqByCourse = {};
  rs[5].results.forEach(r => { reqByCourse[r.course_id] = r.n; });
  // 同じ人が何日見たか
  const viewers = rs[7].results;
  const booked = {};
  rs[8].results.forEach(r => { booked[r.user_id] = true; });
  const repeat = { once: 0, few: 0, many: 0 };
  viewers.forEach(v => { if (v.days <= 1) repeat.once++; else if (v.days <= 3) repeat.few++; else repeat.many++; });
  // 何度も見ているのに、期間内に予約していない人（お客様台帳の名前があれば表示）
  const lookers = viewers.filter(v => v.days >= 3 && !booked[v.user_id]).sort((a, b) => b.days - a.days).slice(0, 10);
  let names = {};
  if (lookers.length) {
    const rows = (await env.DB.prepare('SELECT user_id, name, line_name FROM reservations WHERE user_id IN (' + lookers.map(() => '?').join(',') + ') ORDER BY created_at DESC')
      .bind(...lookers.map(v => v.user_id)).all()).results;
    rows.forEach(r => { if (!names[r.user_id]) names[r.user_id] = r.name || r.line_name; });
  }
  return {
    days: days, from: from, today: today,
    daily: daily,
    totals: { opens: daily.reduce((a, d) => a + d.opens, 0), users: viewers.length },
    funnel: { open: funnel.open || 0, date: funnel.date || 0, time: funnel.time || 0, course: funnel.course || 0, request: funnel.request || 0 },
    topDates: rs[2].results.map(r => ({ date: r.t_date, users: r.users })),
    blocked: rs[3].results.map(r => ({ date: r.t_date, reason: r.extra || '', users: r.users })),
    courses: rs[4].results.map(r => ({ name: cname(r.course_id), users: r.users, requests: reqByCourse[r.course_id] || 0 })),
    sources: rs[6].results.map(r => ({ src: r.src || 'direct', users: r.users, opens: r.opens })),
    repeat: repeat,
    lookers: lookers.map(v => ({ name: names[v.user_id] || '', days: v.days, opens: v.opens, last: v.last })),
    // 示唆のための集計
    hours: rs[9].results.map(r => ({ h: Number(r.h), n: r.n })),
    wantWeekday: weekdayTotals(rs[10].results),
    blockedWeekday: weekdayTotals(rs[11].results),
    updatedAt: jstStamp(Date.now())
  };
}

async function adminQuota(env) {
  if (!env.LINE_TOKEN) return { quota: { ok: false, message: 'LINEの設定がまだです' } };
  try {
    const h = { headers: { authorization: 'Bearer ' + env.LINE_TOKEN } };
    const base = lineBase(env);
    const [q, u] = await Promise.all([
      fetch(base + '/v2/bot/message/quota', h).then(r => r.json()),
      fetch(base + '/v2/bot/message/quota/consumption', h).then(r => r.json())
    ]);
    if (u.totalUsage === undefined) return { quota: { ok: false, message: '送信数を取得できませんでした' } };
    return { quota: { ok: true, limit: q.type === 'limited' ? q.value : null, used: u.totalUsage } };
  } catch (e) {
    return { quota: { ok: false, message: '送信数を取得できませんでした' } };
  }
}

/* =========================================================
 * 定期実行（返事忘れのお知らせ）
 * ========================================================= */

async function runSchedule(env) {
  await ensureSchema(env);
  const s = await getSettings(env);
  const limit = jstStamp(Date.now() - s.remindHours * 3600 * 1000);
  const rows = (await env.DB.prepare(
    "SELECT * FROM reservations WHERE status = '返事待ち' AND reminded_at IS NULL AND created_at <= ? ORDER BY created_at LIMIT 20"
  ).bind(limit).all()).results;
  const url = await adminUrl(env);
  for (const r of rows) {
    const res = await pushOwner(env, '【返事待ちのリクエストがあります】\n' + r.name + ' 様　' + r.guests + '名\n第1希望：' +
      jd(r.date) + ' ' + r.time + '\n受付：' + r.created_at + '\n\n返事をする：' + url);
    if (res.ok) {
      await env.DB.prepare('UPDATE reservations SET reminded_at = ? WHERE id = ?').bind(jstStamp(Date.now()), r.id).run();
    }
  }
  const chg = (await env.DB.prepare(
    "SELECT c.*, r.name AS name FROM change_requests c JOIN reservations r ON r.id = c.res_id WHERE c.status = '返事待ち' AND c.reminded_at IS NULL AND c.created_at <= ? ORDER BY c.created_at LIMIT 20"
  ).bind(limit).all()).results;
  for (const c of chg) {
    const res = await pushOwner(env, '【返事待ちの変更リクエストがあります】\n' + c.name + ' 様\n変更後：' +
      jd(c.date) + ' ' + c.time + '　' + c.guests + '名\n受付：' + c.created_at + '\n\n返事をする：' + url);
    if (res.ok) {
      await env.DB.prepare('UPDATE change_requests SET reminded_at = ? WHERE id = ?').bind(jstStamp(Date.now()), c.id).run();
    }
  }
  await openAlert(env, s, url);
  try { await igSync(env); } catch (e) { console.error('Instagram取り込みエラー', e && e.message); }
  // Squareの売上を取り込み、月曜の朝はお店のLINEに先週のまとめを送る
  try {
    const today = jstStamp(Date.now()).slice(0, 10);
    await sqEnsure(env, monthsBetween(addDays(today, -3), today), 30 * 60000);
  } catch (e) { console.error('Square取り込みエラー', e && e.message); }
  try {
    // 口座の明細が届いたレシートを登録する（1時間に1回まで）
    const at = await kvGet(env, 'rcptMatchAt');
    if (!at || Date.now() - at.at > 3600000) { await kvPut(env, 'rcptMatchAt', { at: Date.now() }); await rcptMatchWaiting(env); }
  } catch (e) { console.error('明細との結びつけのエラー', e && e.message); }
  try { await weeklyReport(env); } catch (e) { console.error('週のまとめのエラー', e && e.message); }
  await env.DB.prepare('DELETE FROM ai_cache WHERE at < ?').bind(addDays(jstStamp(Date.now()).slice(0, 10), -60)).run();
  await env.DB.prepare('DELETE FROM events WHERE date < ?').bind(addDays(jstStamp(Date.now()).slice(0, 10), -180)).run();
  await env.DB.prepare('DELETE FROM login_fail WHERE until < ?').bind(Date.now()).run();
}

/* =========================================================
 * Instagram（自分のお店のアカウントの数値を取り込む）
 * ========================================================= */
function igBase(env) { return env.IG_API_BASE || 'https://graph.instagram.com'; }
const IG_VER = 'v23.0';

// トークン：最初はシークレットのIG_TOKEN、以降は自動更新したものを使う（約60日で期限切れのため20日ごとに更新）
async function igToken(env) {
  const row = await env.DB.prepare("SELECT v FROM kv WHERE k = 'igToken'").first();
  let cur = row ? JSON.parse(row.v) : null;
  if (cur && env.IG_TOKEN && cur.seed !== env.IG_TOKEN.slice(-12)) cur = null; // シークレットを入れ替えたときは、そちらを使う
  if (!cur) {
    if (!env.IG_TOKEN) return null;
    cur = { token: env.IG_TOKEN, at: Date.now(), seed: env.IG_TOKEN.slice(-12) };
    await env.DB.prepare("INSERT OR REPLACE INTO kv (k, v) VALUES ('igToken', ?)").bind(JSON.stringify(cur)).run();
  }
  if (Date.now() - cur.at > 20 * 86400000) {
    try {
      const res = await fetch(igBase(env) + '/refresh_access_token?grant_type=ig_refresh_token&access_token=' + encodeURIComponent(cur.token));
      const j = await res.json();
      if (res.ok && j.access_token) {
        cur = { token: j.access_token, at: Date.now(), seed: cur.seed };
        await env.DB.prepare("INSERT OR REPLACE INTO kv (k, v) VALUES ('igToken', ?)").bind(JSON.stringify(cur)).run();
      }
    } catch (e) { /* 更新に失敗しても今のトークンで続ける */ }
  }
  return cur;
}

async function igGet(env, token, path, params) {
  const q = new URLSearchParams(Object.assign({}, params || {}, { access_token: token }));
  const res = await fetch(igBase(env) + '/' + IG_VER + path + '?' + q.toString());
  let j = {};
  try { j = await res.json(); } catch (e) { /* 何もしない */ }
  if (!res.ok || j.error) {
    const e = new Error((j.error && j.error.message) || ('HTTP ' + res.status));
    e.igCode = j.error ? j.error.code : res.status;
    throw e;
  }
  return j;
}

// 1日分のアカウントの数値（指標ごとに取り、使えない指標は飛ばす）
async function igDayMetric(env, token, metric, since, until) {
  try {
    const j = await igGet(env, token, '/me/insights', { metric: metric, period: 'day', metric_type: 'total_value', since: since, until: until });
    const d = (j.data || [])[0];
    if (!d) return null;
    if (d.total_value && typeof d.total_value.value === 'number') return d.total_value.value;
    if (d.values && d.values.length) return d.values.reduce((a, v) => a + (Number(v.value) || 0), 0);
    return null;
  } catch (e) { return null; }
}

function jstFromIso(iso) {
  const ms = Date.parse(String(iso || '').replace(/\+0000$/, 'Z'));
  return isNaN(ms) ? '' : jstStamp(ms);
}

// 取り込み（定期実行と「今すぐ取り込む」から呼ぶ）
async function igSync(env, manual) {
  const tk = await igToken(env);
  if (!tk) return { ok: false, message: 'IG_TOKENが登録されていません。' };
  const now = jstStamp(Date.now());
  const today = now.slice(0, 10);
  const last = await env.DB.prepare("SELECT v FROM kv WHERE k = 'igSyncAt'").first();
  if (!manual && last && Date.now() - Number(last.v) < 6 * 3600000) return { ok: true, skipped: true };
  let me;
  try {
    me = await igGet(env, tk.token, '/me', { fields: 'user_id,username,followers_count,media_count' });
  } catch (e) {
    await env.DB.prepare("INSERT OR REPLACE INTO kv (k, v) VALUES ('igError', ?)").bind(JSON.stringify({ at: now, message: e.message })).run();
    return { ok: false, message: 'Instagramにつながりませんでした（' + e.message + '）' };
  }
  // アカウントの数値：昨日と今日（今日は途中まで）。初回は過去7日分
  const has = await env.DB.prepare('SELECT COUNT(*) AS n FROM ig_daily').first();
  const back = has && has.n ? 1 : 7;
  const metrics = { reach: 'reach', views: 'views', profile_views: 'profile_views', engaged: 'accounts_engaged', interactions: 'total_interactions', link_taps: 'profile_links_taps' };
  for (let i = back; i >= 0; i--) {
    const day = addDays(today, -i);
    const since = Math.floor((Date.parse(day + 'T00:00:00+09:00')) / 1000);
    const until = since + 86400;
    const vals = {};
    for (const k of Object.keys(metrics)) vals[k] = await igDayMetric(env, tk.token, metrics[k], since, until);
    if (vals.link_taps === null) vals.link_taps = await igDayMetric(env, tk.token, 'website_clicks', since, until);
    await env.DB.prepare('INSERT OR REPLACE INTO ig_daily (date, followers, reach, views, profile_views, engaged, interactions, link_taps, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .bind(day, i === 0 ? (me.followers_count || null) : ((await env.DB.prepare('SELECT followers FROM ig_daily WHERE date = ?').bind(day).first()) || {}).followers || null,
        vals.reach, vals.views, vals.profile_views, vals.engaged, vals.interactions, vals.link_taps, now).run();
  }
  // 投稿・リール・ストーリー（直近30日分の数値を更新）
  const items = [];
  try {
    const m = await igGet(env, tk.token, '/me/media', { fields: 'id,caption,media_type,media_product_type,timestamp,permalink,like_count,comments_count', limit: 25 });
    (m.data || []).forEach(x => items.push(Object.assign({ kind: x.media_product_type === 'REELS' ? 'reel' : 'feed' }, x)));
  } catch (e) { /* 投稿が取れなくても続ける */ }
  try {
    const st = await igGet(env, tk.token, '/me/stories', { fields: 'id,media_type,timestamp,permalink' });
    (st.data || []).forEach(x => items.push(Object.assign({ kind: 'story' }, x)));
  } catch (e) { /* ストーリーがなくても続ける */ }
  const limitDate = addDays(today, -30);
  for (const x of items) {
    const ts = jstFromIso(x.timestamp);
    if (!ts || ts.slice(0, 10) < limitDate) continue;
    const want = x.kind === 'story' ? 'reach,views,replies,shares,total_interactions' : 'reach,views,saved,shares,total_interactions';
    const v = {};
    try {
      const ins = await igGet(env, tk.token, '/' + x.id + '/insights', { metric: want });
      (ins.data || []).forEach(d => { v[d.name] = d.values && d.values[0] ? Number(d.values[0].value) || 0 : (d.total_value ? d.total_value.value : null); });
    } catch (e) {
      try {
        const ins = await igGet(env, tk.token, '/' + x.id + '/insights', { metric: 'reach' });
        (ins.data || []).forEach(d => { v[d.name] = d.values && d.values[0] ? Number(d.values[0].value) || 0 : null; });
      } catch (e2) { /* 数値なし */ }
    }
    const cur = await env.DB.prepare('SELECT * FROM ig_media WHERE id = ?').bind(x.id).first();
    // ストーリーは24時間で数値が消えるので、取れなかったときは前回の値を残す
    const keep = (k, nv) => (nv === undefined || nv === null) ? (cur ? cur[k] : null) : nv;
    await env.DB.prepare('INSERT OR REPLACE INTO ig_media (id, kind, ts, date, caption, permalink, reach, views, likes, comments, saves, shares, interactions, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .bind(x.id, x.kind, ts, ts.slice(0, 10), clean(x.caption, 1000), x.permalink || (cur ? cur.permalink : ''),
        keep('reach', v.reach), keep('views', v.views), keep('likes', x.like_count), keep('comments', x.comments_count),
        keep('saves', v.saved), keep('shares', v.shares), keep('interactions', v.total_interactions), now).run();
  }
  const acc = { username: me.username || '', followers: me.followers_count || 0, media: me.media_count || 0, at: now };
  await env.DB.batch([
    env.DB.prepare("INSERT OR REPLACE INTO kv (k, v) VALUES ('igAccount', ?)").bind(JSON.stringify(acc)),
    env.DB.prepare("INSERT OR REPLACE INTO kv (k, v) VALUES ('igSyncAt', ?)").bind(String(Date.now())),
    env.DB.prepare("DELETE FROM kv WHERE k = 'igError'"),
    env.DB.prepare('DELETE FROM ig_daily WHERE date < ?').bind(addDays(today, -180)),
    env.DB.prepare('DELETE FROM ig_media WHERE date < ?').bind(addDays(today, -180))
  ]);
  return { ok: true, items: items.length };
}

// 管理画面に出すInstagramの集計（予約ページの閲覧や空き状況と合わせる）
async function adminIgStats(env, b) {
  const days = [7, 30, 90].indexOf(Number(b.days)) >= 0 ? Number(b.days) : 30;
  const today = jstStamp(Date.now()).slice(0, 10);
  const from = addDays(today, -(days - 1));
  const kv = {};
  (await env.DB.prepare("SELECT k, v FROM kv WHERE k IN ('igAccount', 'igSyncAt', 'igError', 'igToken')").all()).results.forEach(r => { kv[r.k] = r.v; });
  const connected = !!(env.IG_TOKEN || kv.igToken);
  if (!connected) return { connected: false };
  const rs = await env.DB.batch([
    env.DB.prepare('SELECT * FROM ig_daily WHERE date >= ? ORDER BY date').bind(from),
    env.DB.prepare('SELECT * FROM ig_media WHERE date >= ? ORDER BY ts DESC').bind(addDays(today, -Math.max(days, 30))),
    env.DB.prepare("SELECT date, COUNT(*) AS opens, SUM(CASE WHEN src IN ('instagram','ig-story') THEN 1 ELSE 0 END) AS ig FROM events WHERE kind = 'open' AND date >= ? GROUP BY date").bind(from),
    env.DB.prepare("SELECT ts, src FROM events WHERE kind = 'open' AND date >= ?").bind(addDays(today, -Math.max(days, 30)))
  ]);
  const ig = {};
  rs[0].results.forEach(r => { ig[r.date] = r; });
  const op = {};
  rs[2].results.forEach(r => { op[r.date] = r; });
  const storyDays = {};
  rs[1].results.forEach(m => { if (m.kind === 'story') storyDays[m.date] = (storyDays[m.date] || 0) + 1; });
  const postDays = {};
  rs[1].results.forEach(m => { if (m.kind !== 'story') postDays[m.date] = (postDays[m.date] || 0) + 1; });
  const daily = [];
  for (let d = from; d <= today; d = addDays(d, 1)) {
    const x = ig[d] || {};
    daily.push({ date: d, reach: x.reach, views: x.views, profileViews: x.profile_views, linkTaps: x.link_taps, followers: x.followers,
      opens: op[d] ? op[d].opens : 0, igOpens: op[d] ? op[d].ig : 0, stories: storyDays[d] || 0, posts: postDays[d] || 0 });
  }
  // 投稿のあと24時間に予約ページが開かれた回数
  const opens = rs[3].results;
  const media = rs[1].results.map(m => {
    const end = jstStamp(Date.parse(m.ts.replace(' ', 'T') + ':00+09:00') + 86400000);
    const after = opens.filter(o => o.ts >= m.ts && o.ts < end);
    return { id: m.id, kind: m.kind, ts: m.ts, caption: m.caption, permalink: m.permalink, reach: m.reach, views: m.views,
      likes: m.likes, comments: m.comments, saves: m.saves, shares: m.shares, interactions: m.interactions,
      visits: after.length, igVisits: after.filter(o => o.src === 'instagram' || o.src === 'ig-story').length };
  });
  // これから1週間の空き（ストーリーで告知する候補）
  const s = await getSettings(env);
  const w = await loadWindow(env, today, addDays(today, 7));
  const idx = buildIndex(w.holds, w.blocks, s);
  const nowStamp = jstStamp(Date.now());
  const openings = [];
  for (let i = 0; i <= 7; i++) {
    const d = addDays(today, i);
    if (d > bookingEnd(s, today)) break;
    const per = {};
    daySlots(d, w.rules, s).forEach(x => {
      if (nowStamp >= d + ' ' + x.time) return;
      const left = leftAt(idx, d, x.time, x.session, null, s);
      if (!per[x.session] || per[x.session] < left) per[x.session] = left;
    });
    Object.keys(per).forEach(k => { if (per[k] >= Math.ceil(s.seats / 2)) openings.push({ date: d, session: sessionLabel(s, k), left: per[k] }); });
  }
  const tk = kv.igToken ? JSON.parse(kv.igToken) : null;
  return {
    connected: true,
    account: kv.igAccount ? JSON.parse(kv.igAccount) : null,
    syncedAt: kv.igSyncAt ? jstStamp(Number(kv.igSyncAt)) : '',
    error: kv.igError ? JSON.parse(kv.igError) : null,
    tokenDays: tk ? Math.floor((Date.now() - tk.at) / 86400000) : null,
    days: days, from: from, today: today, daily: daily, media: media, openings: openings.slice(0, 6), seats: s.seats
  };
}

// 予約の受付期間が終わりそうなとき（14・7・3・1・0日前）に、お店に知らせる
async function openAlert(env, s, url) {
  if (!s.openUntil) return;
  const today = jstStamp(Date.now()).slice(0, 10);
  const left = diffDays(today, s.openUntil);
  const stage = left < 0 ? 'over' : [14, 7, 3, 1, 0].find(n => left <= n);
  if (stage === undefined) return;
  const mark = s.openUntil + ':' + stage;
  const sent = await env.DB.prepare("SELECT v FROM kv WHERE k = 'openAlert'").first();
  if (sent && sent.v === mark) return;
  const text = left < 0
    ? '【予約の受付期間が終わっています】\n' + jdLong(s.openUntil) + 'までで受付が止まっています。\n次の期間を開ける場合は、管理画面の「設定」→「受付」から最終日を延ばしてください。\n\n' + url
    : '【予約の受付期間のお知らせ】\nネット予約は ' + jdLong(s.openUntil) + ' までです（あと' + left + '日）。\n次の月の予定が決まったら、管理画面の「設定」→「受付」から最終日を延ばしてください。\n\n' + url;
  const res = await pushOwner(env, text);
  if (res.ok) await env.DB.prepare("INSERT OR REPLACE INTO kv (k, v) VALUES ('openAlert', ?)").bind(mark).run();
}

/* =========================================================
 * LINE
 * ========================================================= */

function lineBase(env) {
  return env.LINE_API_BASE || 'https://api.line.me';
}

async function verifyIdToken(env, idToken) {
  if (!env.LINE_CHANNEL_ID) fail('予約システムの設定が完了していません（LINE_CHANNEL_ID）。', 500);
  if (!idToken) fail('LINEの本人確認の情報を受け取れませんでした。', 401);
  const res = await fetch(lineBase(env) + '/oauth2/v2.1/verify', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ id_token: String(idToken), client_id: String(env.LINE_CHANNEL_ID) })
  });
  if (!res.ok) {
    console.warn('verify failed', res.status, await res.text());
    fail('LINEの本人確認ができませんでした。ページを開き直してください。', 401);
  }
  const body = await res.json();
  if (!body.sub) fail('LINEの本人確認ができませんでした。ページを開き直してください。', 401);
  return { userId: body.sub, name: body.name || '' };
}

function textMsg(text) {
  return { type: 'text', text: String(text).slice(0, 5000) };
}

function appUrl(env, query) {
  return env.LIFF_ID ? SHOP.appUrlBase + env.LIFF_ID + (query || '') : '';
}

function myPageButton(env, text) {
  return {
    type: 'template',
    altText: text,
    template: {
      type: 'buttons',
      text: text.slice(0, 160),
      actions: [{ type: 'uri', label: '予約を確認する', uri: appUrl(env, '?view=mine') }]
    }
  };
}

async function linePush(env, to, messages) {
  if (!env.LINE_TOKEN) return { ok: false, message: 'LINE_TOKENが未設定です' };
  if (!to) return { ok: false, message: '送り先がありません' };
  if (messages.some(m => m.type === 'template') && !env.LIFF_ID) {
    messages = messages.filter(m => m.type !== 'template');
  }
  try {
    const res = await fetch(lineBase(env) + '/v2/bot/message/push', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + env.LINE_TOKEN },
      body: JSON.stringify({ to: to, messages: messages })
    });
    if (res.ok) return { ok: true };
    const detail = await res.text();
    console.error('LINE push error', res.status, detail);
    const hint = res.status === 429 ? '今月の送信数の上限に達した可能性があります' :
      res.status === 401 ? 'LINE_TOKENが正しくありません' :
      res.status === 403 ? 'このアカウントでは送信できません' :
      res.status === 400 ? '送り先か文面に問題があります（お客様がブロックしている可能性があります）' : 'エラーコード ' + res.status;
    return { ok: false, message: hint };
  } catch (e) {
    console.error(e);
    return { ok: false, message: '通信エラー' };
  }
}

async function pushOwner(env, text) {
  const ids = String(env.OWNER_USER_ID || '').split(',').map(x => x.trim()).filter(Boolean);
  if (!ids.length) return { ok: false, message: 'OWNER_USER_IDが未設定です' };
  const results = await Promise.all(ids.map(id => linePush(env, id, [textMsg(text)])));
  return results.find(r => !r.ok) || { ok: true };
}

/*__SERVICES__*/

/* =========================================================
 * 署名付きの通行証
 * ========================================================= */

function secret(env) {
  return env.SESSION_SECRET || env.LINE_TOKEN || env.ADMIN_PASSWORD || '';
}

function b64url(bytes) {
  let s = '';
  bytes.forEach(b => { s += String.fromCharCode(b); });
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromB64url(str) {
  const s = str.replace(/-/g, '+').replace(/_/g, '/');
  return Uint8Array.from(atob(s + '==='.slice((s.length + 3) % 4)), c => c.charCodeAt(0));
}

async function hmac(env, data) {
  if (!secret(env)) fail('サーバーの設定が完了していません（LINE_TOKEN）。', 500);
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret(env)), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(data)));
}

async function signToken(env, payload) {
  const body = b64url(new TextEncoder().encode(JSON.stringify(payload)));
  return body + '.' + b64url(await hmac(env, body));
}

async function verifyToken(env, token) {
  const parts = String(token || '').split('.');
  if (parts.length !== 2) return null;
  const expect = b64url(await hmac(env, parts[0]));
  if (!(await safeEqual(env, expect, parts[1]))) return null;
  try {
    const p = JSON.parse(new TextDecoder().decode(fromB64url(parts[0])));
    return p.e > Date.now() ? p : null;
  } catch (e) {
    return null;
  }
}

async function safeEqual(env, a, b) {
  const [x, y] = await Promise.all([hmac(env, 'cmp:' + a), hmac(env, 'cmp:' + b)]);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}

async function pwTag(env) {
  return b64url(await hmac(env, 'pw:' + (env.ADMIN_PASSWORD || ''))).slice(0, 12);
}

/* =========================================================
 * 共通の部品
 * ========================================================= */

function clean(v, max) {
  return String(v === undefined || v === null ? '' : v)
    .replace(/[\u0000-\u0008\u000B-\u001F\u007F]/g, '').trim().slice(0, max);
}

// その日の予約状況を1つの数にまとめた印（人数が変わっても検知できる）
function holdKey(holds, date, isChange) {
  const list = holds.filter(h => h.date === date && (isChange ? h.chg : !h.chg));
  return list.reduce((sum, h) => sum + (Number(h.guests) || 0), 0) * 1000 + list.length;
}

// 保存のたびに変わる印（同じ分に複数回変更しても見分けが付く）
function rev() {
  return jstStamp(Date.now()) + '#' + crypto.randomUUID().slice(0, 6);
}

function newId(prefix) {
  const d = jstStamp(Date.now());
  return prefix + d.slice(2, 4) + d.slice(5, 7) + d.slice(8, 10) + '-' + crypto.randomUUID().replace(/-/g, '').slice(0, 8).toUpperCase();
}

// 「2026-09-25 18:30」（日本時間）をミリ秒に直す
function stampMs(s) {
  const m = String(s || '').match(/^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})$/);
  if (!m) return 0;
  return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]) - 9 * 3600 * 1000;
}

function diffDays(from, to) {
  const a = String(from).split('-').map(Number);
  const b = String(to).split('-').map(Number);
  return Math.round((Date.UTC(b[0], b[1] - 1, b[2]) - Date.UTC(a[0], a[1] - 1, a[2])) / 86400000);
}

function jd(date) {
  if (!date) return '';
  const p = String(date).split('-').map(Number);
  return p[1] + '/' + p[2] + '（' + WD[weekday(date)] + '）';
}

function jdLong(date) {
  if (!date) return '';
  const p = String(date).split('-').map(Number);
  return p[0] + '年' + p[1] + '月' + p[2] + '日（' + WD[weekday(date)] + '）';
}

/*__ASSETS__*/
