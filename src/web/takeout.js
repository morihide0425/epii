// テイクアウト（店頭受取）の注文画面と、お支払いのあとの確認画面
(() => {
  'use strict';
  const root = document.getElementById('checkout-root');
  const data = JSON.parse(document.getElementById('checkout-data').textContent || '{}');
  if (!root) return;
  const esc = v => String(v == null ? '' : v).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const yen = v => '¥' + Number(v || 0).toLocaleString('ja-JP');
  const WD = '日月火水木金土';
  const dLabel = d => { const p = d.split('-').map(Number); const w = new Date(Date.UTC(p[0], p[1] - 1, p[2])).getUTCDay(); return p[1] + '月' + p[2] + '日（' + WD[w] + '）'; };
  const pad = n => String(n).padStart(2, '0');
  const KEY = 'epii-takeout-token';
  const store = { get: () => { try { return localStorage.getItem(KEY) || ''; } catch (e) { return ''; } }, set: v => { try { localStorage.setItem(KEY, v); } catch (e) { /* 保存できなくても続ける */ } } };
  const newToken = () => Array.from(crypto.getRandomValues(new Uint8Array(32)), n => n.toString(16).padStart(2, '0')).join('');
  async function post(name, body) {
    const r = await fetch('/api/takeaway/' + name, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || j.ok === false) throw new Error(j.message || '通信を確かめて、もう一度お試しください。');
    return j;
  }

  /* ---------- 注文 ---------- */
  if (data.page === 'order') {
    const P = data.product, slots = data.slots || [];
    const st = { date: '', time: '', qty: 1, name: '', email: '', phone: '', agreed: false, review: false, busy: false, err: '', month: '' };
    const dates = [...new Set(slots.map(s => s.date))].sort();
    st.month = dates.length ? dates[0].slice(0, 7) : '';
    const sel = () => slots.find(s => s.date === st.date && s.time === st.time);
    function calendar() {
      if (!dates.length) return '<p class="checkout-error">いま選べる受取日がありません。</p>';
      const first = dates[0].slice(0, 7), last = dates[dates.length - 1].slice(0, 7);
      const [y, m] = st.month.split('-').map(Number);
      const off = new Date(Date.UTC(y, m - 1, 1)).getUTCDay(), len = new Date(Date.UTC(y, m, 0)).getUTCDate();
      let days = '';
      for (let i = 0; i < off; i++) days += '<span></span>';
      for (let i = 1; i <= len; i++) {
        const d = st.month + '-' + pad(i);
        const op = slots.filter(s => s.date === d), left = op.reduce((a, s) => a + s.left, 0);
        const cls = !op.length ? 'unavailable' : !left ? 'full' : left <= 3 ? 'few' : 'available';
        days += '<button type="button" data-date="' + d + '" class="' + (st.date === d ? 'selected ' : '') + cls + '"' + (left ? '' : ' disabled') + ' aria-pressed="' + (st.date === d) + '"><span>' + i + '</span><small>' + (!op.length ? '—' : !left ? '満枠' : left <= 3 ? '△' : '○') + '</small></button>';
      }
      const times = st.date ? slots.filter(s => s.date === st.date).map(s => '<button type="button" data-time="' + s.time + '" class="' + (st.time === s.time ? 'selected' : '') + '"' + (s.left ? '' : ' disabled') + ' aria-pressed="' + (st.time === s.time) + '"><span>' + s.time + '</span><small>' + (!s.left ? '満枠' : s.left <= 3 ? '残りわずか' : '空きあり') + '</small></button>').join('') : '';
      return '<div class="pickup-calendar"><div class="calendar-heading"><span class="calendar-field-label">受取日 <b>必須</b></span></div>' +
        '<div class="calendar-month"><button type="button" data-month="-1"' + (st.month <= first ? ' disabled' : '') + ' aria-label="前の月">‹</button><h3>' + y + '年 <strong>' + m + '</strong>月</h3><button type="button" data-month="1"' + (st.month >= last ? ' disabled' : '') + ' aria-label="次の月">›</button></div>' +
        '<div class="calendar-week" aria-hidden="true">' + WD.split('').map(d => '<span>' + d + '</span>').join('') + '</div><div class="calendar-days">' + days + '</div>' +
        '<div class="calendar-legend"><span>○ 空きあり</span><span>△ 残りわずか</span><span>満枠・— 選べません</span></div>' +
        '<div class="calendar-time-heading"><span class="calendar-field-label">受取時間 <b>必須</b></span>' + (st.date ? '<p>' + dLabel(st.date) + '</p>' : '') + '</div>' +
        (st.date ? '<div class="calendar-times">' + times + '</div>' : '<p class="calendar-empty">カレンダーから受取日を選んでください。</p>') +
        (st.date && st.time ? '<p class="calendar-selection">' + dLabel(st.date) + ' ' + st.time + ' に店頭でお受け取り</p>' : '') + '</div>';
    }
    function form() {
      const s = sel();
      const max = Math.min(P.max || 5, s ? s.left : 1);
      return '<ol class="checkout-steps"><li class="current"><span>01</span>受取日時</li><li><span>02</span>内容の確認</li><li><span>03</span>Squareでお支払い</li></ol>' +
        '<section class="checkout-form-card">' + calendar() +
        '<label for="tk-qty">数量</label><select id="tk-qty">' + Array.from({ length: Math.max(1, max) }, (_, i) => '<option value="' + (i + 1) + '"' + (st.qty === i + 1 ? ' selected' : '') + '>' + (i + 1) + 'セット</option>').join('') + '</select>' +
        '<div class="checkout-rule"></div><h2>ご連絡先</h2><p>お渡しと、ご注文についての連絡に使います。</p>' +
        '<label for="tk-name">お名前 <b>必須</b></label><input id="tk-name" autocomplete="name" maxlength="60" value="' + esc(st.name) + '">' +
        '<label for="tk-email">メールアドレス <b>必須</b></label><input id="tk-email" type="email" autocomplete="email" maxlength="120" value="' + esc(st.email) + '">' +
        '<label for="tk-phone">電話番号 <b>必須</b></label><input id="tk-phone" type="tel" autocomplete="tel" maxlength="20" value="' + esc(st.phone) + '">' +
        '<label class="checkout-agree"><input type="checkbox" id="tk-agree"' + (st.agreed ? ' checked' : '') + '><span>上の原材料・アレルギーと、変更・キャンセルのご案内を確かめました。事前のお支払いのみであることに同意します。</span></label>' +
        (st.err ? '<p class="checkout-error" role="alert">' + esc(st.err) + '</p>' : '') +
        '<button class="pickup-order" type="button" data-act="review">ご注文内容を確かめる <span>→</span></button><p class="checkout-hint">この時点では、注文・お支払いは確定しません。</p></section>';
    }
    function review() {
      return '<ol class="checkout-steps"><li><span>01</span>受取日時</li><li class="current"><span>02</span>内容の確認</li><li><span>03</span>Squareでお支払い</li></ol>' +
        '<section class="checkout-form-card"><p class="overline">YOUR ORDER</p><h2 tabindex="-1" id="tk-review">ご注文内容の確認</h2><dl class="order-review">' +
        '<div><dt>商品・数量</dt><dd>' + esc(P.title) + '<br>' + st.qty + 'セット</dd></div><div><dt>受取日時</dt><dd>' + dLabel(st.date) + ' ' + st.time + '</dd></div>' +
        '<div><dt>お名前</dt><dd>' + esc(st.name) + ' 様</dd></div><div><dt>ご連絡先</dt><dd>' + esc(st.email) + '<br>' + esc(st.phone) + '</dd></div>' +
        '<div class="order-total"><dt>合計（税込）</dt><dd>' + yen(P.price * st.qty) + '</dd></div></dl>' +
        '<div class="order-payment-note"><strong>お支払いが済むと、ご注文が確定します。</strong><p>Squareのお支払い画面に移ります。15分以内にお支払いください。過ぎると取り消しになります。店頭払いはありません。</p></div>' +
        (st.err ? '<p class="checkout-error" role="alert">' + esc(st.err) + '</p>' : '') +
        '<button type="button" class="pickup-order" data-act="pay"' + (st.busy ? ' disabled' : '') + '>' + (st.busy ? 'お支払い画面を準備しています…' : 'Squareで ' + yen(P.price * st.qty) + ' を支払う ↗') + '</button>' +
        '<button class="checkout-back" type="button" data-act="back"' + (st.busy ? ' disabled' : '') + '>← 日時・内容を変える</button></section>';
    }
    function render() { root.innerHTML = st.review ? review() : form(); if (st.review) { const h = document.getElementById('tk-review'); if (h) h.focus(); } }
    function readForm() {
      const v = id => { const el = document.getElementById(id); return el ? el.value.trim() : ''; };
      if (document.getElementById('tk-name')) { st.name = v('tk-name'); st.email = v('tk-email'); st.phone = v('tk-phone'); st.qty = Number(v('tk-qty')) || 1; st.agreed = document.getElementById('tk-agree').checked; }
    }
    root.addEventListener('click', async e => {
      const b = e.target.closest('button');
      if (!b || b.disabled) return;
      readForm();
      if (b.dataset.date) { st.date = b.dataset.date; st.time = ''; st.qty = 1; st.err = ''; render(); return; }
      if (b.dataset.time) { st.time = b.dataset.time; st.qty = 1; st.err = ''; render(); return; }
      if (b.dataset.month) { const [y, m] = st.month.split('-').map(Number); const d = new Date(Date.UTC(y, m - 1 + Number(b.dataset.month), 1)); st.month = d.getUTCFullYear() + '-' + pad(d.getUTCMonth() + 1); render(); return; }
      if (b.dataset.act === 'review') {
        st.err = !st.date || !st.time ? '受取日と受取時間を選んでください。' : !st.name ? 'お名前を入れてください。' : !/^\S+@[^\s@]+\.[^\s@]+$/.test(st.email) ? 'メールアドレスを確かめてください（お支払いの控えが届きます）。'
          : st.phone.replace(/\D/g, '').length < 8 ? 'つながる電話番号を入れてください。' : !st.agreed ? 'ご案内を確かめて、チェックを入れてください。' : '';
        if (!st.err) st.review = true;
        render(); return;
      }
      if (b.dataset.act === 'back') { st.review = false; st.err = ''; render(); return; }
      if (b.dataset.act === 'pay') {
        st.busy = true; st.err = ''; render();
        // 同じ注文を2回作らないように、合言葉を先に決めて覚えておく
        if (!st.token) { st.token = newToken(); store.set(st.token); }
        try {
          const r = await post('order', { token: st.token, test: data.test, date: st.date, time: st.time, quantity: st.qty, name: st.name, email: st.email, phone: st.phone, agreed: st.agreed });
          if (r.order.payUrl) { location.assign(r.order.payUrl); return; }
          location.assign('/takeaway/done#' + st.token);
        } catch (err) { st.busy = false; st.err = err.message; render(); }
      }
    });
    root.addEventListener('change', e => { if (e.target.id === 'tk-qty') st.qty = Number(e.target.value) || 1; });
    render();
    return;
  }

  /* ---------- お支払いのあとの確認 ---------- */
  if (data.page === 'status') {
    const token = (location.hash || '').slice(1) || store.get();
    if (!/^[a-f0-9]{64}$/.test(token)) { root.innerHTML = '<section class="pickup-empty"><h2>ご注文が見つかりません。</h2><p>お支払いの控えのメールをご確認ください。</p><a class="text-link" href="/takeaway">店頭受取のページへ ↗</a></section>'; return; }
    let tries = 0;
    async function check(cancel) {
      let o;
      try { o = (await post(cancel ? 'cancel' : 'status', { token: token })).order; }
      catch (err) { root.innerHTML = '<p class="checkout-error">' + esc(err.message) + '</p>'; return; }
      const head = { paid: ['ご注文を承りました。', '受取日に、店頭でお待ちしています。'], picked: ['お受け取りありがとうございました。', ''], review: ['お支払いを確認しています。', 'お店から確認のご連絡をすることがあります。'],
        pending: ['お支払いがまだ確認できません。', 'お支払いが済んでいれば、少しすると切り替わります。'], expired: ['お支払いの期限が過ぎました。', 'もう一度ご注文ください。'], cancelled: ['ご注文を取り消しました。', ''], failed: ['ご注文を作れませんでした。', 'もう一度お試しください。'] }[o.status] || ['ご注文の状況', ''];
      root.innerHTML = '<section class="checkout-form-card">' + (o.test ? '<p class="pickup-sample"><span>テストのご注文</span></p>' : '') + '<p class="overline">ORDER ' + esc(o.id).toUpperCase() + '</p><h2>' + head[0] + '</h2>' + (head[1] ? '<p>' + head[1] + '</p>' : '') +
        '<dl class="order-review"><div><dt>商品・数量</dt><dd>' + esc(o.title) + '<br>' + o.quantity + 'セット</dd></div><div><dt>受取日時</dt><dd>' + dLabel(o.date) + ' ' + esc(o.time) + '</dd></div><div><dt>お名前</dt><dd>' + esc(o.name) + ' 様</dd></div><div class="order-total"><dt>合計（税込）</dt><dd>' + yen(o.amount) + '</dd></div></dl>' +
        (o.status === 'pending' && o.payUrl ? '<a class="pickup-order" href="' + esc(o.payUrl) + '">Squareでお支払いを続ける ↗</a><button class="checkout-back" type="button" id="tk-cancel">この注文を取り消す</button>' : '') +
        '<p><a class="text-link" href="/home">ホームページへ ↗</a></p></section>';
      const c = document.getElementById('tk-cancel');
      if (c) c.addEventListener('click', () => { if (confirm('お支払い前のご注文を取り消します。よろしいですか？')) check(true); });
      // 支払いの直後は、Squareの確認が届くまで少し待って読み直す
      if (o.status === 'pending' && !cancel && tries < 8) { tries++; setTimeout(() => check(false), 3000); }
    }
    check(false);
  }
})();
