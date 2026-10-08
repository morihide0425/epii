// Claude・Square・マネーフォワードの代わりに応答するテスト用サーバー
import http from 'node:http';
export const calls = { ai: [], sq: [], mf: [] };
export const journals = [];
export const opts = { aiDelay: 0, aiFail: 0 };

const jst = (ms = Date.now()) => new Date(ms + 9 * 3600e3).toISOString().slice(0, 10);
const addDays = (s, n) => { const d = new Date(s + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
// JSTの日時 → ISO（Squareの created_at の形）
const iso = (date, hm) => new Date(Date.parse(date + 'T' + hm + ':00+09:00')).toISOString();

// Square：今日と過去60日の会計。昼と夜に数件ずつ
function payments() {
  const out = [];
  const today = jst();
  for (let i = 0; i <= 60; i++) {
    const d = addDays(today, -i);
    const times = i === 0 ? ['12:55', '13:20', '14:05'] : ['12:40', '13:30', '20:10', '20:45'];
    times.forEach((t, k) => {
      const amt = (k % 2 ? 4800 : 9600) + (i % 5) * 100;
      out.push({
        id: 'PAY' + d.replace(/-/g, '') + k, created_at: iso(d, t), status: i === 1 && k === 3 ? 'FAILED' : 'COMPLETED',
        source_type: k === 2 ? 'CASH' : 'CARD', total_money: { amount: amt, currency: 'JPY' },
        refunded_money: i === 2 && k === 0 ? { amount: 1000, currency: 'JPY' } : undefined
      });
    });
  }
  return out;
}

// マネーフォワード：科目・税区分・仕訳
const ACCOUNTS = [
  { id: 'A%3D1', name: '仕入高', account_group: 'EXPENSE', available: true },
  { id: 'A%3D2', name: '消耗品費', account_group: 'EXPENSE', available: true },
  { id: 'A%3D3', name: '水道光熱費', account_group: 'EXPENSE', available: true },
  { id: 'A%3D4', name: '地代家賃', account_group: 'EXPENSE', available: true },
  { id: 'A%3D5', name: '現金', account_group: 'ASSET', available: true },
  { id: 'A%3D6', name: '事業主借', account_group: 'CAPITAL', available: true },
  { id: 'A%3D7', name: '売上高', account_group: 'REVENUE', available: true },
  { id: 'A%3D8', name: '未払金', account_group: 'LIABILITY', available: true }
];
const TAXES = [
  { id: 'T1', name: '課仕 10%', available: true }, { id: 'T2', name: '課税仕入 10%', available: true },
  { id: 'T3', name: '課税仕入 (軽)8%', available: true }, { id: 'T4', name: '対象外', available: true },
  { id: 'T5', name: '輸入仕入 10%', available: true }
];
function seedJournals() {
  const today = jst();
  for (let i = 0; i < 60; i += 3) {
    const d = addDays(today, -i);
    journals.push({ id: 'J' + i, transaction_date: d, journal_type: 'journal_entry', branches: [{ debitor: { account_id: 'A%3D1', value: 7400, tax_value: 592 }, creditor: { account_id: 'A%3D5', value: 7992, tax_value: 0 } }] });
    if (i % 9 === 0) journals.push({ id: 'K' + i, transaction_date: d, journal_type: 'journal_entry', branches: [{ debitor: { account_id: 'A%3D2', value: 2000, tax_value: 200 }, creditor: { account_id: 'A%3D6', value: 2200, tax_value: 0 } }] });
  }
  journals.push({ id: 'S1', transaction_date: today, journal_type: 'journal_entry', branches: [{ debitor: { account_id: 'A%3D5', value: 1000, tax_value: 0 }, creditor: { account_id: 'A%3D7', value: 1000, tax_value: 0 } }] });
}

// Claude：system の内容で何の依頼かを見分けて、それらしい JSON を返す
function aiAnswer(body) {
  const sys = body.system || '';
  const text = JSON.stringify(body.messages);
  if (sys.includes('ひと言')) {
    if (text.includes('返事の種類：お断り')) return { add: 'せっかく｜ご連絡を｜いただいたのに、｜申し訳ございません。' };
    if (text.includes('結婚記念日')) return { add: '結婚記念日との｜こと、｜おめでとう｜ございます。｜くるみの｜アレルギーも｜承りました。' };
    return { add: '' };
  }
  if (sys.includes('来店前メモ')) return { memo: '2回目。｜前回も｜ランチ。｜辛いものが｜苦手。' };
  if (sys.includes('レシート')) {
    return { readable: true, date: jst(), total: 6480, payee: '阿倍野青果', items: 'にんじん・れんこん他', rate: '8', amount8: 0, amount10: 0, payment: 'cash', account: '仕入高', unsure: ['date'], note: '日付の数字がかすれています' };
  }
  if (sys.includes('相談役')) {
    return { items: [
      { tone: 'warn', title: '食材費の｜割合が｜31%から｜35%に｜上がっています', body: '売上は｜8%増えましたが、｜仕入れは｜21%増えています。', todo: '土曜ディナーの｜変更の｜締切を｜3日前に｜する（設定＞受付）' },
      { tone: 'info', title: '予約なしの｜お客様は｜平日ランチに｜集中しています', body: '予約なしの｜売上の｜7割が｜12時台です。', todo: '平日の｜11時ごろ、｜ストーリーで｜空きを｜知らせる' },
      { tone: 'good', title: '1人あたりの｜売上が｜上がりました', body: 'おまかせの｜予約が｜増えています。', todo: '今のまま' }
    ] };
  }
  if (sys.includes('Instagram')) {
    return { style: ['最初の｜一文は｜短く', '絵文字は｜使わない', 'ハッシュタグは｜最後に｜3〜5個'],
      story: '明日の｜ランチ、｜まだ｜お席が｜あります。\n\nご予約は｜リンクから。',
      post: '十月の｜養生ランチ。\n\nれんこんと｜白きくらげの｜スープ。\n\nご予約は｜プロフィールの｜リンクから。\n#阿倍野ランチ #薬膳 #épii',
      reel: '秋の｜薬膳。\n#薬膳 #épii' };
  }
  return {};
}

export function startSvcMock(port) {
  seedJournals();
  const all = payments();
  return http.createServer((req, res) => {
    let raw = '';
    req.on('data', c => { raw += c; });
    req.on('end', async () => {
      const u = new URL(req.url, 'http://x');
      const send = (j, st = 200) => { res.writeHead(st, { 'content-type': 'application/json' }); res.end(JSON.stringify(j)); };
      // Claude
      if (u.pathname === '/v1/messages') {
        const body = JSON.parse(raw || '{}');
        calls.ai.push({ headers: req.headers, body: body });
        if (opts.aiDelay) await new Promise(r => setTimeout(r, opts.aiDelay));
        if (opts.aiFail) { opts.aiFail--; return send({ type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } }, 529); }
        if (req.headers['x-api-key'] !== 'sk-test') return send({ type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } }, 401);
        return send({ id: 'msg_1', type: 'message', role: 'assistant', model: body.model, stop_reason: 'end_turn',
          content: [{ type: 'thinking', thinking: '', signature: 'x' }, { type: 'text', text: JSON.stringify(aiAnswer(body)) }], usage: { input_tokens: 10, output_tokens: 10 } });
      }
      // Square
      if (u.pathname === '/v2/payments') {
        calls.sq.push(u.search);
        if (req.headers.authorization !== 'Bearer sq-test') return send({ errors: [{ code: 'UNAUTHORIZED', detail: 'bad token' }] }, 401);
        const b = Date.parse(u.searchParams.get('begin_time')), e = Date.parse(u.searchParams.get('end_time'));
        const list = all.filter(p => { const t = Date.parse(p.created_at); return t >= b && t < e; });
        const start = Number(u.searchParams.get('cursor') || 0);
        const page = list.slice(start, start + 100);
        return send(Object.assign({ payments: page }, start + 100 < list.length ? { cursor: String(start + 100) } : {}));
      }
      // マネーフォワード
      if (u.pathname === '/auth/exchange') {
        calls.mf.push('exchange');
        if (req.headers.authorization !== 'Bearer mf-test') return send({ error: 'invalid' }, 401);
        return send({ access_token: 'jwt-1', expires_in: 3600 });
      }
      if (u.pathname === '/v2/tenant/tenant_user') return send({ items: [{ tenant_code: '1234-5678', tenant_name: 'épii' }] });
      if (u.pathname.startsWith('/api/v3/')) {
        const p = u.pathname.slice(7);
        calls.mf.push(req.method + ' ' + p + u.search);
        if (req.headers.authorization !== 'Bearer jwt-1') return send({ errors: [{ message: 'unauthorized' }] }, 401);
        if (u.searchParams.get('office_code') !== '1234-5678') return send({ errors: [{ message: 'missing office_code' }] }, 400);
        if (p === '/accounts') return send({ accounts: ACCOUNTS });
        if (p === '/taxes') return send({ taxes: TAXES });
        if (p === '/term_settings') return send({ term_settings: [{ fiscal_year: 2026, start_date: '2026-01-01', end_date: '2026-12-31', accounting_method: 'TAX_INCLUDED' }] });
        if (p === '/journals' && req.method === 'GET') {
          const s = u.searchParams.get('start_date'), e = u.searchParams.get('end_date');
          const list = journals.filter(j => j.transaction_date >= s && j.transaction_date <= e);
          return send({ journals: list, metadata: { total_count: list.length, total_pages: list.length ? 1 : 0 } });
        }
        if (p === '/journals' && req.method === 'POST') {
          const j = JSON.parse(raw).journal;
          const id = 'NEW%2B' + journals.length;
          // 税込で送られた value を、取り出すときは税抜と税に分ける
          const stored = { id: id, transaction_date: j.transaction_date, journal_type: j.journal_type, memo: j.memo, branches: j.branches.map(b => {
            const rate = b.debitor.tax_id === 'T3' ? 8 : b.debitor.tax_id === 'T2' ? 10 : 0;
            const tax = rate ? Math.floor(b.debitor.value * rate / (100 + rate)) : 0;
            return { debitor: Object.assign({}, b.debitor, { value: b.debitor.value - tax, tax_value: tax }), creditor: Object.assign({ tax_value: 0 }, b.creditor), remark: b.remark };
          }) };
          journals.push(stored);
          return send({ journal: { id: id } }, 201);
        }
        const m = p.match(/^\/journals\/(.+)$/);
        if (m) {
          const id = decodeURIComponent(m[1]);
          const j = journals.find(x => x.id === id);
          if (!j) return send({ errors: [{ message: 'not found' }] }, 404);
          if (req.method === 'DELETE') { journals.splice(journals.indexOf(j), 1); return send({}); }
          return send({ journal: j });
        }
        if (p === '/vouchers' && req.method === 'POST') {
          const v = JSON.parse(raw);
          if (!v.journal_id || !v.voucher_files || !v.voucher_files[0].file_data) return send({ errors: [{ message: 'bad' }] }, 400);
          return send({ voucher_files: [{ id: 'F1' }] }, 201);
        }
      }
      send({ error: 'not found' }, 404);
    });
  }).listen(port);
}

export const SVC_ENV = port => ({
  ANTHROPIC_API_KEY: 'sk-test', ANTHROPIC_API_BASE: 'http://127.0.0.1:' + port,
  SQUARE_ACCESS_TOKEN: 'sq-test', SQUARE_API_BASE: 'http://127.0.0.1:' + port,
  MF_API_KEY: 'mf-test', MF_AUTH_BASE: 'http://127.0.0.1:' + port, MF_API_BASE: 'http://127.0.0.1:' + port + '/api/v3'
});
