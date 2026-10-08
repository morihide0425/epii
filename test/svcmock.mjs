// Claude・Square・マネーフォワードの代わりに応答するテスト用サーバー
import http from 'node:http';
export const calls = { ai: [], sq: [], mf: [] };
export const journals = [];
export const txs = [];
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
  { id: 'A%3D8', name: '未払金', account_group: 'LIABILITY', available: true },
  { id: 'A%3D9', name: '普通預金', account_group: 'ASSET', available: true },
  { id: 'A%3D10', name: '通信費', account_group: 'EXPENSE', available: true },
  { id: 'A%3D11', name: '事業主貸', account_group: 'ASSET', available: true }
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
  // 口座の明細（まだ登録していないもの）：デビットカードの支払い、引き落とし、入金
  txs.push({ id: 'TX%3D1', date: today, value: 6580, side: 'EXPENSE', content: 'VISAデビット アベノセイカ', journalizing_status: 'none', connected_account_id: 'CA1' });
  txs.push({ id: 'TX%3D2', date: addDays(today, -3), value: 5500, side: 'EXPENSE', content: 'NTTﾋｶﾞｼﾆﾎﾝ', journalizing_status: 'none', connected_account_id: 'CA1' });
  txs.push({ id: 'TX%3D3', date: addDays(today, -5), value: 33000, side: 'EXPENSE', content: 'ｶﾝｻｲﾃﾞﾝﾘﾖｸ', journalizing_status: 'none', connected_account_id: 'CA1' });
  txs.push({ id: 'TX%3D11', date: addDays(today, -4), value: 16980, side: 'EXPENSE', content: 'ｺｸﾐﾝﾈﾝｷﾝ', journalizing_status: 'none', connected_account_id: 'CA1' });
  txs.push({ id: 'TX%3D4', date: addDays(today, -2), value: 120000, side: 'INCOME', content: 'ｽｸｴｱ', journalizing_status: 'none', connected_account_id: 'CA1' });
}

// Claude：system の内容で何の依頼かを見分けて、それらしい JSON を返す
function aiAnswer(body) {
  const sys = typeof body.system === 'string' ? body.system : JSON.stringify(body.system || '');
  const text = JSON.stringify(body.messages);
  if (sys.includes('仕込みメモ')) {
    const rows = String(body.messages[0].content[0].text).split('\n').filter(l => /^[A-Z]\d*｜/.test(l));
    const ref = l => l.split('｜')[0];
    return {
      cautions: rows.filter(l => l.includes('アレルギー')).map(l => ({ ref: ref(l), text: 'くるみ｜アレルギー' })),
      celebrations: rows.filter(l => l.includes('記念日')).map(l => ({ ref: ref(l), text: '結婚記念日' })),
      guests: rows.filter(l => /\d+回目/.test(l)).map(l => ({ ref: ref(l), text: '2回目。｜前回も｜ランチ' })),
      prep: rows.some(l => l.includes('アレルギー')) ? ['くるみを｜使わない皿を｜1名分'] : [],
      custom: [...String(body.messages[0].content[0].text).matchAll(/^(c[a-z0-9]+)｜/gm)].map(m => ({ id: m[1], lines: [rows.length ? ref(rows[0]) + '：ノンアル｜1名' : 'なし'] })),
      cheer: '明日は｜ゆったりした日です。｜今夜は｜早めに｜休んでくださいね。'
    };
  }
  if (sys.includes('週のはじめに送るLINE')) return { cheer: '先週も｜おつかれさまでした。｜今週も｜無理せずに。' };
  if (sys.includes('月の目標をどのくらい')) return { profit: 300000, sales: 820000, text: '食材費の｜割合が｜30%ほどなので、｜売上 ¥820,000で｜利益 ¥300,000が｜目安です。' };
  if (sys.includes('ひと言')) {
    if (text.includes('返事の種類：お断り')) return { add: 'せっかく｜ご連絡を｜いただいたのに、｜申し訳ございません。' };
    if (text.includes('結婚記念日')) return { add: '結婚記念日との｜こと、｜おめでとう｜ございます。｜くるみの｜アレルギーも｜承りました。' };
    return { add: '' };
  }
  if (sys.includes('口座から出たお金の明細')) {
    const ids = [...text.matchAll(/(TX%3D\d+)｜/g)].map(m => m[1]);
    return { items: ids.map(id => ({ id: id, account: id === 'TX%3D2' ? '通信費' : id === 'TX%3D3' ? '水道光熱費' : id === 'TX%3D11' ? '事業主貸' : '仕入高', rate: id === 'TX%3D1' ? '8' : id === 'TX%3D11' ? 'none' : '10', reason: id === 'TX%3D2' ? '電話・インターネット代なので' : '電気代なので', unsure: false })) };
  }
  if (sys.includes('相談相手')) return { answer: 'お店で使う｜洗剤なら｜消耗品費で｜大丈夫です。', account: '消耗品費' };
  if (sys.includes('来店前メモ')) return { memo: '2回目。｜前回も｜ランチ。｜辛いものが｜苦手。' };
  if (sys.includes('レシート')) {
    // 1枚目は日付に自信がない、2枚目からは自信あり（金額も少しずつ変える）
    const n = calls.ai.filter(c => (c.body.system || '').includes('レシート')).length;
    return { readable: true, date: jst(), total: 6480 + (n - 1) * 100, payee: '阿倍野青果', items: 'にんじん・れんこん他', invoice_no: 'T1234567890123', rate: '8', amount8: 0, amount10: 0, payment: n === 1 ? 'cash' : 'card', account: '仕入高', reason: '料理に使う｜野菜なので', unsure: n === 1 ? ['date'] : [], note: n === 1 ? '日付の数字がかすれています' : '' };
  }
  if (sys.includes('質問に答えます')) {
    const last = body.messages[body.messages.length - 1].content;
    return { answer: '今月の｜売上は｜先月の｜同じ期間より｜少し｜減っています。', remember: String(last).includes('火曜') ? '仕入れは毎週火曜にまとめて市場で' : '' };
  }
  if (sys.includes('相談役') && !text.includes('今週いちばん大事なこと')) {
    const sec = text.includes('売上と経費だけ') ? '売上' : text.includes('予約と予約ページだけ') ? '予約' : 'Instagram';
    return { items: [
      { tone: 'info', title: sec + 'の｜気づき｜その1', body: sec + 'の｜数字の｜根拠。', todo: sec + 'で｜やること' },
      { tone: 'good', title: sec + 'の｜気づき｜その2', body: '根拠。', todo: '今のまま' }
    ] };
  }
  if (sys.includes('相談役')) {
    return { items: [
      { tone: 'warn', title: '食材費の｜割合が｜31%から｜35%に｜上がっています', body: '売上は｜8%増えましたが、｜仕入れは｜21%増えています。', todo: '土曜ディナーの｜変更の｜締切を｜3日前に｜する（設定＞受付）' },
      { tone: 'info', title: '予約なしの｜お客様は｜平日ランチに｜集中しています', body: '予約なしの｜売上の｜7割が｜12時台です。', todo: '平日の｜11時ごろ、｜ストーリーで｜空きを｜知らせる' },
      { tone: 'good', title: '1人あたりの｜売上が｜上がりました', body: 'おまかせの｜予約が｜増えています。', todo: '今のまま' }
    ] };
  }
  if (sys.includes('Instagram')) {
    const n = calls.ai.filter(c => JSON.stringify(c.body.system || '').includes('Instagram')).length;
    const style = text.includes('style（書き方の特徴）も') ? ['最初の｜一文は｜短く', '絵文字は｜使わない', 'ハッシュタグは｜最後に｜3〜5個'] : [];
    if (text.includes('書く文：投稿')) return { text: '十月の｜養生ランチ。\n\nれんこんと｜白きくらげの｜スープ。\n\nご予約は｜プロフィールの｜リンクから。\n#阿倍野ランチ #薬膳 #épii', style: style };
    if (text.includes('書く文：リール')) return { text: '秋の｜薬膳。\n#薬膳 #épii', style: style };
    return { text: ['明日の｜ランチ、', '今週の｜ランチ、', 'この週末の｜ランチ、'][n % 3] + '｜まだ｜お席が｜あります。\n\nご予約は｜リンクから。', style: style };
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
        if (p === '/transactions' && req.method === 'GET') {
          const q = u.searchParams;
          if (!q.get('start_date') || !q.get('end_date')) return send({ errors: [{ message: 'start_date and end_date required' }] }, 400);
          let list = txs.filter(t => t.date >= q.get('start_date') && t.date <= q.get('end_date'));
          if (q.get('side')) list = list.filter(t => t.side === q.get('side'));
          if (q.get('journalizing_statuses')) list = list.filter(t => q.getAll('journalizing_statuses').includes(t.journalizing_status));
          if (q.get('value_min')) list = list.filter(t => t.value >= Number(q.get('value_min')));
          if (q.get('value_max')) list = list.filter(t => t.value <= Number(q.get('value_max')));
          return send({ transactions: list, metadata: { total_count: list.length, total_pages: 1 } });
        }
        if (p === '/transactions/journalize' && req.method === 'POST') {
          const b = JSON.parse(raw);
          const t = txs.find(x => x.id === b.transaction_id);
          if (!t || t.journalizing_status !== 'none' || !b.account_id) return send({ errors: [{ message: 'bad transaction' }] }, 400);
          t.journalizing_status = 'registered';
          const rate = b.tax_id === 'T3' ? 8 : b.tax_id === 'T2' ? 10 : 0;
          const tax = rate ? Math.floor(t.value * rate / (100 + rate)) : 0;
          const id = 'TXJ%2B' + journals.length;
          journals.push({ id: id, transaction_id: t.id, transaction_date: t.date, journal_type: 'journal_entry', memo: '', branches: [{ debitor: { account_id: b.account_id, tax_id: b.tax_id, value: t.value - tax, tax_value: tax, invoice_kind: b.invoice_kind }, creditor: { account_id: 'A%3D9', value: t.value, tax_value: 0 }, remark: b.remark }] });
          return send({ journal: { id: id } }, 201);
        }
        if (p === '/journals' && req.method === 'GET') {
          const s = u.searchParams.get('start_date'), e = u.searchParams.get('end_date');
          let list = journals.filter(j => j.transaction_date >= s && j.transaction_date <= e);
          if (u.searchParams.get('transaction_ids')) list = list.filter(j => j.transaction_id === u.searchParams.get('transaction_ids'));
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
          if (req.method === 'DELETE') {
            journals.splice(journals.indexOf(j), 1);
            const t = txs.find(x => x.id === j.transaction_id);
            if (t) t.journalizing_status = 'none';
            return send({});
          }
          if (req.method === 'PUT') {
            const nj = JSON.parse(raw).journal;
            j.branches = nj.branches.map(b => {
              const rate = b.debitor.tax_id === 'T3' ? 8 : b.debitor.tax_id === 'T2' ? 10 : 0;
              const tax = rate ? Math.floor(b.debitor.value * rate / (100 + rate)) : 0;
              return { debitor: Object.assign({}, b.debitor, { value: b.debitor.value - tax, tax_value: tax }), creditor: Object.assign({ tax_value: 0 }, b.creditor), remark: b.remark };
            });
            return send({ journal: { id: j.id } });
          }
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
