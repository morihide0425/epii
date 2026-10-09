// Claude・Square・マネーフォワードの代わりに応答するテスト用サーバー
import http from 'node:http';
export const calls = { ai: [], sq: [], mf: [], g: [] };
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
  { id: 'A%3D11', name: '事業主貸', account_group: 'ASSET', available: true },
  { id: 'A%3D12', name: '買掛金', account_group: 'LIABILITY', available: true },
  { id: 'A%3D13', name: '雑収入', account_group: 'REVENUE', available: true },
  { id: 'A%3D14', name: '未収金', account_group: 'ASSET', available: true },
  { id: 'A%3D15', name: '売上値引・返品', account_group: 'REVENUE', available: true },
  { id: 'A%3D16', name: '損害保険料', account_group: 'EXPENSE', available: true },
  { id: 'A%3D17', name: '支払手数料', account_group: 'EXPENSE', available: true },
  { id: 'A%3D18', name: '雑損失', account_group: 'EXPENSE', available: true },
  { id: 'A%3D19', name: '事業主借', account_group: 'LIABILITY', available: true }
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
  // 帳簿のチェック用：CSVで見つかったようなまちがい
  const jb = (id, d, b) => journals.push({ id: id, transaction_date: d, journal_type: 'journal_entry', memo: '', branches: b.map(x => ({ debitor: { account_id: x[0], value: x[1], tax_value: 0 }, creditor: { account_id: x[2], value: x[1], tax_value: 0 }, remark: x[3] || '' })) });
  jb('BK1', today, [['A%3D5', 3472, 'A%3D5', '八百鮮　仕入れ']]);
  jb('BK2', today, [['A%3D5', 7000, 'A%3D5', '事業主貸　生計']]);
  jb('BK3', today, [['A%3D11', 820, 'A%3D6', '']]);
  jb('BK4', today, [['A%3D10', 550, 'A%3D9', 'V630291 SUBLINE']]);
  jb('BK5', today, [['A%3D9', 550, 'A%3D13', 'Vｻｶﾞｸ630291']]);
  jb('BK6', addDays(today, -20), [['A%3D1', 970, 'A%3D12', '近鉄　仕入れ']]);
  jb('BK7', addDays(today, -12), [['A%3D14', 3410, 'A%3D7', '総売上高 お取引 No.DXFn']]);
  jb('BK8', today, [['A%3D2', 1200, 'A%3D5', 'アベノセイカ 野菜']]);
  jb('BK9', today, [['A%3D2', 120000, 'A%3D9', 'ノートパソコン']]);
  jb('BK10', today, [['A%3D11', 10000, 'A%3D9', '振込 タキグチ ナホ']]);
  // au損害保険の引き落としと、その差額の返金（番号と金額が一致）。番号が合わない返金・金額が違う返金
  jb('BK11', addDays(today, -6), [['A%3D16', 340, 'A%3D9', 'V312703 AUINSURANCECO,LTD']]);
  jb('BK12', today, [['A%3D9', 340, 'A%3D13', 'Vサガク312703']]);
  jb('BK13', today, [['A%3D9', 500, 'A%3D13', 'Vｻｶﾞｸ999999']]);
  jb('BK14', addDays(today, -5), [['A%3D10', 1000, 'A%3D9', 'V777777 SOFTBANK']]);
  jb('BK15', today, [['A%3D9', 300, 'A%3D13', 'Vサガク777777']]);
  // 本物の免税事業者の仕訳は、インボイス区分が「対象外」で返ってくる
  journals.push({ id: 'BK18', transaction_date: today, journal_type: 'journal_entry', memo: '', branches: [{ debitor: { account_id: 'A%3D9', value: 947, tax_value: 0, invoice_kind: 'INVOICE_KIND_NOT_TARGET' }, creditor: { account_id: 'A%3D9', value: 947, tax_value: 0, invoice_kind: 'INVOICE_KIND_NOT_TARGET' }, remark: 'V510367 イズミヤ仕入れ' }] });
  // 1回の入金を、1つの仕訳で2行に分けて登録（現金から＋自分のお金から）。銀行の明細は合計の1回分
  journals.push({ id: 'BK19', transaction_date: addDays(today, -10), journal_type: 'journal_entry', memo: '', branches: [
    { debitor: { account_id: 'A%3D9', value: 22807, tax_value: 0 }, creditor: { account_id: 'A%3D5', value: 22807, tax_value: 0 }, remark: 'カード' },
    { debitor: { account_id: 'A%3D9', value: 32193, tax_value: 0 }, creditor: { account_id: 'A%3D6', value: 32193, tax_value: 0 }, remark: '' }] });
  txs.push({ id: 'TXS1', date: addDays(today, -10), value: 55000, side: 'INCOME', content: 'ｶｰﾄﾞ', journalizing_status: 'registered' });
  // 請求書の売上：登録した日から20日あとに入金
  journals.push({ id: 'BK20', transaction_date: addDays(today, -30), journal_type: 'journal_entry', memo: '', branches: [{ debitor: { account_id: 'A%3D9', value: 4600, tax_value: 0 }, creditor: { account_id: 'A%3D7', value: 4600, tax_value: 0 }, remark: 'No.1 il Centrino' }] });
  txs.push({ id: 'TXS2', date: addDays(today, -10), value: 4600, side: 'INCOME', content: 'ﾌﾘｺﾐ ｲﾙｾﾝﾄﾘﾉ', journalizing_status: 'registered' });
  // 振込手数料を引かれて入金（帳簿6,000円／銀行5,560円）
  journals.push({ id: 'BK21', transaction_date: addDays(today, -25), journal_type: 'journal_entry', memo: '', branches: [{ debitor: { account_id: 'A%3D9', value: 6000, tax_value: 0 }, creditor: { account_id: 'A%3D7', value: 6000, tax_value: 0 }, remark: 'No.3 il Centrino' }] });
  txs.push({ id: 'TXS3', date: addDays(today, -15), value: 5560, side: 'INCOME', content: 'ﾌﾘｺﾐ ｲﾙｾﾝﾄﾘﾉ', journalizing_status: 'ignored' });
  // 2件の請求が、まとめて1回で入金
  journals.push({ id: 'BK22', transaction_date: addDays(today, -20), journal_type: 'journal_entry', memo: '', branches: [{ debitor: { account_id: 'A%3D9', value: 3000, tax_value: 0 }, creditor: { account_id: 'A%3D7', value: 3000, tax_value: 0 }, remark: 'No.4 il Centrino' }] });
  journals.push({ id: 'BK23', transaction_date: addDays(today, -19), journal_type: 'journal_entry', memo: '', branches: [{ debitor: { account_id: 'A%3D9', value: 2000, tax_value: 0 }, creditor: { account_id: 'A%3D7', value: 2000, tax_value: 0 }, remark: 'No.5 il Centrino' }] });
  txs.push({ id: 'TXS4', date: addDays(today, -12), value: 5000, side: 'INCOME', content: 'ﾌﾘｺﾐ ｲﾙｾﾝﾄﾘﾉ', journalizing_status: 'ignored' });
  // カードの売上（未収金）。このうち入金された分を、2回登録してしまった（Squareの明細から：手数料の行あり／銀行の明細から）。銀行の明細は1回分
  journals.push({ id: 'SQC1', transaction_date: addDays(today, -8), journal_type: 'journal_entry', memo: '', branches: [{ debitor: { account_id: 'A%3D14', value: 17940, tax_value: 0 }, creditor: { account_id: 'A%3D7', value: 17940, tax_value: 0 }, remark: 'カード売上' }] });
  journals.push({ id: 'SQD1', transaction_date: addDays(today, -6), journal_type: 'journal_entry', memo: '', branches: [
    { debitor: { account_id: 'A%3D9', value: 8820, tax_value: 0 }, creditor: { account_id: 'A%3D14', value: 8820, tax_value: 0 }, remark: addDays(today, -6).replace(/-/g, '/') + ' 09:30 入金 po_dup1' },
    { debitor: { account_id: 'A%3D17', value: 300, tax_value: 0 }, creditor: { account_id: 'A%3D14', value: 300, tax_value: 0 }, remark: '手数料' }] });
  journals.push({ id: 'SQD2', transaction_date: addDays(today, -5), journal_type: 'journal_entry', memo: '', branches: [{ debitor: { account_id: 'A%3D9', value: 8820, tax_value: 0 }, creditor: { account_id: 'A%3D14', value: 8820, tax_value: 0 }, remark: 'ｽｸｴｱ' }] });
  txs.push({ id: 'TXS5', date: addDays(today, -5), value: 8820, side: 'INCOME', content: 'ｽｸｴｱ', journalizing_status: 'registered' });
  // 銀行の入金（Square）を売上高で登録
  journals.push({ id: 'SQS1', transaction_date: addDays(today, -15), journal_type: 'journal_entry', memo: '', branches: [{ debitor: { account_id: 'A%3D9', value: 7700, tax_value: 0 }, creditor: { account_id: 'A%3D7', value: 7700, tax_value: 0 }, remark: 'ｽｸｴｱ ﾌﾘｺﾐ' }] });
  txs.push({ id: 'TXS6', date: addDays(today, -15), value: 7700, side: 'INCOME', content: 'ｽｸｴｱ ﾌﾘｺﾐ', journalizing_status: 'registered' });
  // 口座の仕訳が二重（銀行の明細は1回分）
  jb('BK16', today, [['A%3D2', 2200, 'A%3D9', 'ﾃｽﾄ ﾁｭｳﾌｸ']]);
  jb('BK17', today, [['A%3D2', 2200, 'A%3D9', 'ﾃｽﾄ ﾁｭｳﾌｸ']]);
  txs.push({ id: 'TX%3D90', date: today, value: 2200, side: 'EXPENSE', content: 'ﾃｽﾄ ﾁｭｳﾌｸ', journalizing_status: 'registered' });
  // Squareの「未入力」の明細：3日前の会計（カード・現金）、入金、Squareにない会計
  const d3 = addDays(today, -3);
  const sl = d3.replace(/-/g, '/');
  txs.push({ id: 'SQT1', date: d3, value: 9900, side: 'INCOME', content: sl + ' 12:40 お取引 No.PAY2', journalizing_status: 'none' });
  txs.push({ id: 'SQT2', date: d3, value: 9900, side: 'INCOME', content: sl + ' 20:10 お取引 No.PAY2', journalizing_status: 'none' });
  txs.push({ id: 'SQT3', date: today, value: 10150, side: 'INCOME', content: today.replace(/-/g, '/') + ' 09:30 入金 po_test1', journalizing_status: 'none' });
  txs.push({ id: 'SQT4', date: d3, value: 1234, side: 'INCOME', content: sl + ' 15:00 お取引 No.ZZZZ', journalizing_status: 'none' });
  // 帳簿の口座の動きに合う銀行の明細（登録済み）。BK4 だけは銀行にない
  [['BK5', 550, 'INCOME', today], ['BK9', 120000, 'EXPENSE', today], ['BK10', 10000, 'EXPENSE', today], ['BK11', 340, 'EXPENSE', addDays(today, -6)], ['BK12', 340, 'INCOME', today], ['BK13', 500, 'INCOME', today], ['BK14', 1000, 'EXPENSE', addDays(today, -5)], ['BK15', 300, 'INCOME', today]]
    .forEach((x, i) => txs.push({ id: 'TXB' + i, date: x[3], value: x[1], side: x[2], content: x[0], journalizing_status: 'registered' }));
  journals.push({ id: 'S1', transaction_date: today, journal_type: 'journal_entry', branches: [{ debitor: { account_id: 'A%3D5', value: 1000, tax_value: 0 }, creditor: { account_id: 'A%3D7', value: 1000, tax_value: 0 } }] });
  // 口座の明細（まだ登録していないもの）：デビットカードの支払い、引き落とし、入金
  txs.push({ id: 'TX%3D1', date: today, value: 6580, side: 'EXPENSE', content: 'VISAデビット アベノセイカ', journalizing_status: 'none', connected_account_id: 'CA1' });
  txs.push({ id: 'TX%3D2', date: addDays(today, -3), value: 5500, side: 'EXPENSE', content: 'NTTﾋｶﾞｼﾆﾎﾝ', journalizing_status: 'none', connected_account_id: 'CA1' });
  txs.push({ id: 'TX%3D3', date: addDays(today, -5), value: 33000, side: 'EXPENSE', content: 'ｶﾝｻｲﾃﾞﾝﾘﾖｸ', journalizing_status: 'none', connected_account_id: 'CA1' });
  txs.push({ id: 'TX%3D11', date: addDays(today, -4), value: 16980, side: 'EXPENSE', content: 'ｺｸﾐﾝﾈﾝｷﾝ', journalizing_status: 'none', connected_account_id: 'CA1' });
  txs.push({ id: 'TX%3D4', date: addDays(today, -2), value: 120000, side: 'INCOME', content: 'ｽｸｴｱ', journalizing_status: 'none', connected_account_id: 'CA1' });
  // 銀行への入金：Squareの入金（SQT3：手数料を引いて9,820円）と同じお金、預金の利息
  txs.push({ id: 'TXI1', date: today, value: 9820, side: 'INCOME', content: 'ｽｸｴｱ ﾌﾘｺﾐ', journalizing_status: 'none', connected_account_id: 'CA1' });
  txs.push({ id: 'TXI2', date: addDays(today, -1), value: 15, side: 'INCOME', content: 'ﾘｿｸ', journalizing_status: 'none', connected_account_id: 'CA1' });
}

// Claude：system の内容で何の依頼かを見分けて、それらしい JSON を返す
function aiAnswer(body) {
  const sys = typeof body.system === 'string' ? body.system : JSON.stringify(body.system || '');
  const text = JSON.stringify(body.messages);
  if (sys.includes('帳簿の気になる仕訳1件')) {
    const t = String(body.messages[0].content[0].text);
    if (t.includes('手数料の候補')) return { choice: 'fee', why: '近い日に440円少ない入金があります' };
    return { choice: '', why: '前後の通帳に同じ金額の入金がないか見てください' };
  }
  if (sys.includes('帳簿を確定申告の前に見直す')) {
    const lines = String(body.messages[0].content[0].text).split('\n').filter(l => l.includes('消耗品費') && l.includes('野菜'));
    return { items: lines.map(l => { const p = l.split('｜'); return { id: p[0], bi: Number(p[1]), from: '消耗品費', to: '仕入高', title: '食材なので仕入高', why: 'アベノセイカは青果店' }; }) };
  }
  if (text.includes('現金で払ったものの摘要')) {
    const ids = [...String(body.messages[0].content[0].text).matchAll(/^(\d+)｜/gm)].map(m => m[1]);
    return { items: ids.map(id => ({ id: id, account: '仕入高', rate: '8', reason: '食材', unsure: false, sure: true })) };
  }
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
    return { items: ids.map(id => ({ id: id, account: id === 'TX%3D2' ? '通信費' : id === 'TX%3D3' ? '水道光熱費' : id === 'TX%3D11' ? '事業主貸' : '仕入高', rate: id === 'TX%3D1' ? '8' : id === 'TX%3D11' ? 'none' : '10', reason: id === 'TX%3D2' ? '電話・インターネット代なので' : '電気代なので', unsure: false, sure: id !== 'TX%3D1' })) };
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
      // Google（ビジネスプロフィール）
      if (u.pathname.startsWith('/g/')) {
        calls.g.push(req.method + ' ' + u.pathname);
        if (u.pathname === '/g/token') {
          const f = new URLSearchParams(raw);
          if (f.get('client_id') !== 'gid' || f.get('client_secret') !== 'gsec') return send({ error: 'invalid_client' }, 401);
          if (f.get('grant_type') === 'authorization_code') return f.get('code') === 'good' ? send({ access_token: 'gat', refresh_token: 'grt', expires_in: 3600 }) : send({ error: 'invalid_grant' }, 400);
          if (f.get('grant_type') === 'refresh_token') return f.get('refresh_token') === 'grt' ? send({ access_token: 'gat2', expires_in: 3600 }) : send({ error: 'invalid_grant' }, 400);
          return send({ error: 'unsupported_grant_type' }, 400);
        }
        if (!/^Bearer gat2?$/.test(req.headers.authorization || '')) return send({ error: { code: 401, message: 'Request had invalid authentication credentials.' } }, 401);
        const gp = u.pathname.slice(3);
        if (gp === 'mybusinessaccountmanagement.googleapis.com/v1/accounts') return send({ accounts: [{ name: 'accounts/111', accountName: 'épii' }] });
        if (gp === 'mybusinessbusinessinformation.googleapis.com/v1/accounts/111/locations') return send({ locations: [{ name: 'locations/222', title: '薬膳レストラン épii' }] });
        if (gp === 'businessprofileperformance.googleapis.com/v1/locations/222:fetchMultiDailyMetricsTimeSeries') {
          const q = u.searchParams;
          const d0 = new Date(Date.UTC(+q.get('dailyRange.start_date.year'), +q.get('dailyRange.start_date.month') - 1, +q.get('dailyRange.start_date.day')));
          const d1 = new Date(Date.UTC(+q.get('dailyRange.end_date.year'), +q.get('dailyRange.end_date.month') - 1, +q.get('dailyRange.end_date.day')));
          const series = q.getAll('dailyMetrics').map(m => {
            const vals = [];
            for (let d = new Date(d0), i = 0; d <= d1; d.setUTCDate(d.getUTCDate() + 1), i++) {
              const v = m === 'BUSINESS_IMPRESSIONS_MOBILE_MAPS' ? 20 + (i % 7) : m === 'BUSINESS_IMPRESSIONS_MOBILE_SEARCH' ? 8 : m === 'BUSINESS_DIRECTION_REQUESTS' ? (i % 3 ? 0 : 2) : m === 'CALL_CLICKS' ? (i % 10 ? 0 : 1) : 0;
              vals.push(Object.assign({ date: { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() } }, v ? { value: String(v) } : {}));
            }
            return { dailyMetric: m, timeSeries: { datedValues: vals } };
          });
          return send({ multiDailyMetricTimeSeries: [{ dailyMetricTimeSeries: series }] });
        }
        if (gp === 'businessprofileperformance.googleapis.com/v1/locations/222/searchkeywords/impressions/monthly') return send({ searchKeywordsCounts: [{ searchKeyword: '阿倍野 ランチ', insightsValue: { value: '64' } }, { searchKeyword: '薬膳 大阪', insightsValue: { value: '120' } }, { searchKeyword: '薬膳 カレー 阿倍野', insightsValue: { threshold: '15' } }] });
        if (gp === 'mybusiness.googleapis.com/v4/accounts/111/locations/222/reviews') {
          if (opts.noReviews) return send({ error: { code: 403, message: 'Google My Business API has not been used in project 1 before or it is disabled.' } }, 403);
          return send({ averageRating: 4.6, totalReviewCount: 23, reviews: [
            { reviewId: 'r1', reviewer: { displayName: '山田 花子' }, starRating: 'FIVE', comment: '体にやさしいランチでした。連絡は090-1234-5678まで', createTime: new Date(Date.now() - 3 * 86400000).toISOString() },
            { reviewId: 'r2', reviewer: { displayName: '佐藤' }, starRating: 'FOUR', comment: 'スープがおいしい', createTime: new Date(Date.now() - 20 * 86400000).toISOString(), reviewReply: { comment: 'ありがとうございます' } }] });
        }
        return send({ error: { code: 404, message: 'not found ' + gp } }, 404);
      }
      // Square
      const pom = u.pathname.match(/^\/v2\/payouts\/([^/]+)(\/payout-entries)?$/);
      if (pom) {
        if (pom[1] !== 'po_test1') return send({ errors: [{ code: 'NOT_FOUND' }] }, 404);
        if (pom[2]) return send({ payout_entries: [{ type: 'CHARGE', gross_amount_money: { amount: 10150 }, fee_amount_money: { amount: -330 }, net_amount_money: { amount: 9820 } }] });
        return send({ payout: { id: 'po_test1', amount_money: { amount: 9820, currency: 'JPY' } } });
      }
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
        // 本物と同じく、免税事業者にはインボイス区分を送るとエラーにする
        if (opts.exempt && /invoice_kind/.test(raw)) return send({ errors: [{ code: 'invalid', message: '免税事業者にインボイス区分を登録できません Target: invoice_kind TargetValue: INVOICE_KIND_NOT_TARGET' }] }, 400);
        if (p === '/accounts') return send({ accounts: ACCOUNTS });
        if (p === '/taxes') return send({ taxes: TAXES });
        if (p === '/term_settings') return send({ term_settings: [{ fiscal_year: 2026, start_date: '2026-01-01', end_date: '2026-12-31', accounting_method: 'TAX_INCLUDED' }].concat(opts.oldTerm ? [{ fiscal_year: 2025, start_date: '2025-01-01', end_date: '2025-12-31', accounting_method: 'TAX_INCLUDED' }] : []) });
        // 残高試算表（貸借対照表）：科目の木。values は columns の順
        if (p === '/reports/trial_balance_bs') {
          if (opts.noTb) return send({ errors: [{ message: 'not found' }] }, 404);
          const s0 = u.searchParams.get('start_date') || '2026-01-01';
          const cols = ['opening_balance', 'debit_amount', 'credit_amount', 'closing_balance', 'ratio'];
          return send({ columns: cols, start_date: s0, end_date: u.searchParams.get('end_date') || '2026-12-31', report_type: 'trial_balance_bs', created_at: '2026-10-08T00:00:00+09:00', rows: [
            { name: '資産', type: 'financial_statement_item', values: [500000, 0, 0, 500000, 100], rows: [
              { name: '流動資産', type: 'financial_statement_item', values: [500000, 0, 0, 500000, 100], rows: [
                { name: '現金及び預金', type: 'financial_statement_item', values: [500000, 0, 0, 500000, 100], rows: [
                  { name: '現金', type: 'account', values: [opts.tbCash === undefined ? 42000 : opts.tbCash, 0, 0, 42000, 8], rows: [] },
                  { name: '普通預金', type: 'account', values: [458000, 0, 0, 458000, 92], rows: [] }] }] }] }] });
        }
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
        // 明細を対象外にする（本物の形は分からないので、1つめに試す形だけ受ける。opts.noExclude なら無い扱い）
        const tm = p.match(/^\/transactions\/([^/]+)$/);
        if (tm && req.method === 'PUT' && tm[1] !== 'journalize') {
          if (opts.noExclude) return send({ errors: [{ message: 'not found' }] }, 404);
          const t = txs.find(x => x.id === decodeURIComponent(tm[1]));
          const b = JSON.parse(raw || '{}');
          if (!t || b.journalizing_status !== 'excluded') return send({ errors: [{ message: 'bad request' }] }, 400);
          t.journalizing_status = 'excluded';
          return send({ transaction: t });
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
  MF_API_KEY: 'mf-test', MF_AUTH_BASE: 'http://127.0.0.1:' + port, MF_API_BASE: 'http://127.0.0.1:' + port + '/api/v3',
  GOOGLE_CLIENT_ID: 'gid', GOOGLE_CLIENT_SECRET: 'gsec', GOOGLE_API_BASE: 'http://127.0.0.1:' + port + '/g', GOOGLE_TOKEN_URL: 'http://127.0.0.1:' + port + '/g/token', GOOGLE_AUTH_BASE: 'http://127.0.0.1:' + port + '/g/auth'
});
