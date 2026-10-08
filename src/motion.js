/* ===== 画面の動き（予約ページと管理画面で共通） =====
 * ・動きはバネの式から計算する（わずかなはね返りのみ。ぴょんぴょん跳ねる動きは使わない）
 * ・選択の印は、前の場所から新しい場所へ「同じ形のまま」移動する（前の端が先に動き、後ろの端が遅れてついてくる）
 * ・ボタンは押すと丸く縮んで読み込み中 → チェックに変わる
 * ・「動きを減らす」設定の端末では、すべての動きを止める
 */
(function () {
  const css = `
  .m-pending, .m-pending * { background-color: var(--m-bg, transparent) !important; color: var(--m-fg, inherit) !important; border-color: var(--m-bd, currentColor) !important; box-shadow: none !important; }
  .m-inv, .m-inv * { color: var(--m-sel-fg) !important; background: transparent !important; border-color: transparent !important; box-shadow: none !important; outline: none !important; opacity: 1 !important; filter: none !important; animation: none !important; transition: none !important; }
  .m-inv svg, .m-inv svg * { stroke: var(--m-sel-fg) !important; }
  .m-busy { position: relative; overflow: hidden; opacity: 1 !important; cursor: default; }
  .m-busy .m-label { display: inline-flex; align-items: center; justify-content: center; gap: 6px; white-space: nowrap; }
  .m-busy .m-spin, .m-busy .m-check { position: absolute; left: 50%; top: 50%; width: 20px; height: 20px; margin: -10px 0 0 -10px; fill: none; stroke: currentColor; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; opacity: 0; }
  .m-busy .m-spin circle { stroke-dasharray: 34 60; transform-box: fill-box; transform-origin: center; animation: m-rot .75s linear infinite; }
  .m-busy .m-check { width: 28px; height: 28px; margin: -14px 0 0 -14px; stroke-width: 2.4; }
  .m-busy .m-check path { stroke-dasharray: 18; }
  @keyframes m-rot { to { transform: rotate(360deg); } }
  .m-tip { position: absolute; z-index: 60; background: #1F1F1F; color: #fff; font-size: 12px; line-height: 1.4; padding: 5px 9px; border-radius: 8px; pointer-events: none; opacity: 0; white-space: nowrap; font-variant-numeric: tabular-nums; }
  .m-tip::after { content: ''; position: absolute; left: var(--ax, 50%); bottom: -5px; margin-left: -5px; border: 5px solid transparent; border-bottom: 0; border-top-color: #1F1F1F; }
  .m-tip.show { opacity: 1; }
  [data-tip] { touch-action: pan-y; -webkit-user-select: none; user-select: none; -webkit-touch-callout: none; }
  [data-tip], :has(> [data-tip]) { touch-action: pan-y; -webkit-user-select: none; user-select: none; -webkit-touch-callout: none; }
  .m-tipping > [data-tip] { opacity: .35; transition: opacity .12s ease-out; }
  .m-tipping > [data-tip].m-tip-on { opacity: 1; }
  .toast { transition: none !important; }
  .toast .m-tt { display: inline-block; }
  .waitbar { display: block; height: 11px; margin: 7px 0; border-radius: 6px; background: linear-gradient(90deg, #E6EFF2 0%, #F6F9FA 45%, #E6EFF2 90%); background-size: 220% 100%; animation: m-shine 1.5s ease-in-out infinite; }
  .waitbar.short { width: 58%; }
  @keyframes m-shine { from { background-position: 110% 0; } to { background-position: -110% 0; } }
  @media (prefers-reduced-motion: reduce) { .m-busy .m-spin circle, .waitbar { animation: none; } }`;
  const st = document.createElement('style');
  st.textContent = css;
  document.head.appendChild(st);
})();

const M = (() => {
  const reduce = () => !!(window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches);
  const hasLinear = !!(window.CSS && CSS.supports && CSS.supports('animation-timing-function', 'linear(0, 1)'));

  // バネの動き（閉じた式）。response＝おおよその所要時間（秒）、zeta＝減衰の強さ（1に近いほどはね返らない）
  function springFn(response, zeta) {
    const w = 2 * Math.PI / response;
    if (zeta >= 1) return t => 1 - (1 + w * t) * Math.exp(-w * t);
    const wd = w * Math.sqrt(1 - zeta * zeta);
    return t => 1 - Math.exp(-zeta * w * t) * (Math.cos(wd * t) + (zeta * w / wd) * Math.sin(wd * t));
  }
  function settle(f) {
    let last = 0.05;
    for (let t = 0; t < 3; t += 1 / 240) if (Math.abs(1 - f(t)) > 0.002) last = t;
    return last + 1 / 60;
  }
  const cache = {};
  function spring(response, zeta) {
    const key = response + ':' + zeta;
    if (cache[key]) return cache[key];
    const f = springFn(response, zeta);
    const dur = settle(f);
    const pts = [];
    for (let i = 0; i <= 40; i++) pts.push(Math.round(f(dur * i / 40) * 1000) / 1000);
    pts[40] = 1;
    return (cache[key] = { f: f, ms: Math.round(dur * 1000), easing: hasLinear ? 'linear(' + pts.join(', ') + ')' : 'cubic-bezier(.22, 1, .36, 1)' });
  }
  const SNAP = () => spring(0.34, 0.86);   // 標準
  const LEAD = () => spring(0.26, 0.9);    // 前の端（速い）
  const TRAIL = () => spring(0.44, 0.84);  // 後ろの端（遅れてついてくる）

  function run(el, frames, opt) {
    if (!el || !el.animate) return null;
    try { return el.animate(frames, opt); } catch (e) { return null; }
  }

  // 2つの端を別々のバネで動かすキーフレーム（左右・上下）。from/to は {l,t,r,b}
  function liquidFrames(from, to) {
    const dx = (to.l + to.r) / 2 - (from.l + from.r) / 2;
    const dy = (to.t + to.b) / 2 - (from.t + from.b) / 2;
    const lead = LEAD(), trail = TRAIL();
    const pick = (edge, forward) => (forward ? lead : trail);
    const fn = {
      l: dx < 0 ? lead : trail, r: dx > 0 ? lead : trail,
      t: dy < 0 ? lead : trail, b: dy > 0 ? lead : trail
    };
    if (Math.abs(dx) < 1) { fn.l = SNAP(); fn.r = SNAP(); }
    if (Math.abs(dy) < 1) { fn.t = SNAP(); fn.b = SNAP(); }
    const ms = Math.max(fn.l.ms, fn.r.ms, fn.t.ms, fn.b.ms);
    const n = Math.max(12, Math.round(ms / 16));
    const frames = [];
    for (let i = 0; i <= n; i++) {
      const s = (ms * i / n) / 1000;
      const at = k => from[k] + (to[k] - from[k]) * (s * 1000 >= fn[k].ms ? 1 : fn[k].f(s));
      const l = at('l'), r = at('r'), t = at('t'), b = at('b');
      frames.push({ left: l + 'px', top: t + 'px', width: Math.max(1, r - l) + 'px', height: Math.max(1, b - t) + 'px' });
    }
    void pick;
    return { frames: frames, ms: ms };
  }

  /* ---------- 選択の印の移動 ----------
   * 外枠に data-mg="名前" と data-mgs="選択中の要素のセレクタ" を付けておく。
   * 描き替えの前に capture()、後に play() を呼ぶ。
   */
  let before = {};
  const switches = {};
  const inflight = {};   // 移動中の形（描き替えが重なっても引き継ぐ）
  function pageRect(el) {
    const r = el.getBoundingClientRect();
    return { l: r.left + scrollX, t: r.top + scrollY, r: r.right + scrollX, b: r.bottom + scrollY };
  }
  const scrolls = {};
  function capture(root) {
    before = {};
    (root || document).querySelectorAll('[data-mg]').forEach(g => { if (g.scrollWidth > g.clientWidth) scrolls[g.dataset.mg] = g.scrollLeft; });
    if (reduce()) return;
    (root || document).querySelectorAll('[data-mg]').forEach(g => {
      const sel = g.querySelector(g.dataset.mgs || '.sel, .on');
      if (sel) before[g.dataset.mg] = pageRect(sel);
    });
    (root || document).querySelectorAll('[data-msw]').forEach(sw => {
      switches[sw.dataset.msw] = { on: sw.classList.contains('on'), bg: getComputedStyle(sw).backgroundColor };
    });
  }
  function play(root) {
    const scope = root || document;
    // 横スクロールを元の位置に戻す。選んだものが枠の外にあるときだけ、見える位置まで寄せる
    scope.querySelectorAll('[data-mg]').forEach(g => {
      if (g.scrollWidth <= g.clientWidth) return;
      if (scrolls[g.dataset.mg] !== undefined) g.scrollLeft = scrolls[g.dataset.mg];
      const sel = g.querySelector(g.dataset.mgs || '.sel, .on');
      if (!sel) return;
      const gr = g.getBoundingClientRect(), sr = sel.getBoundingClientRect();
      if (sr.left < gr.left) g.scrollLeft -= gr.left - sr.left + 8;
      else if (sr.right > gr.right) g.scrollLeft += sr.right - gr.right + 8;
    });
    if (reduce()) { before = {}; return; }
    scope.querySelectorAll('[data-mg]').forEach(g => {
      const sel = g.querySelector(g.dataset.mgs || '.sel, .on');
      if (!sel) return;
      const from = before[g.dataset.mg];
      const to = pageRect(sel);
      if (!from) return;
      const moved = Math.abs(from.l - to.l) + Math.abs(from.t - to.t) + Math.abs(from.r - to.r) + Math.abs(from.b - to.b);
      const fly = inflight[g.dataset.mg];
      if (moved < 2) {
        // 移動の途中で描き替えられた：新しい要素を、着くまで仮の見た目にしておく
        if (fly && fly.sel !== sel) { fly.sel.classList.remove('m-pending'); fly.sel = sel; hold(sel); }
        return;
      }
      if (fly) fly.cancel();
      if (Math.abs(from.t - to.t) > 700) { pop(sel); return; }
      slideTo(g.dataset.mg, sel, from, to);
    });
    // 新しく選ばれた（前は何も選ばれていなかった）ときは、その場で軽く出す
    scope.querySelectorAll('[data-mg]').forEach(g => {
      const sel = g.querySelector(g.dataset.mgs || '.sel, .on');
      if (sel && !before[g.dataset.mg] && g.dataset.mgPrev !== '1') pop(sel);
      g.dataset.mgPrev = sel ? '1' : '';
    });
    // スイッチ
    scope.querySelectorAll('[data-msw]').forEach(sw => {
      const prev = switches[sw.dataset.msw];
      const on = sw.classList.contains('on');
      if (prev && prev.on !== on) flipSwitch(sw, prev.bg, on);
    });
    // 伸びて出るバー
    scope.querySelectorAll('[data-grow]').forEach(c => grow(c));
    // 新しく届いた文（Claudeの下書きなど）
    scope.querySelectorAll('[data-appear]').forEach(appear);
    before = {};
  }

  // 新しい場所の見た目をまねた形を、前の場所から動かす
  function hold(sel) {
    sel.classList.add('m-pending');
    const sib = sel.parentElement && Array.prototype.find.call(sel.parentElement.children, x => x !== sel && x.tagName === sel.tagName && !x.disabled && !x.classList.contains('x') && x.getAttribute('aria-disabled') !== 'true');
    if (sib) {
      const ss = getComputedStyle(sib);
      sel.style.setProperty('--m-bg', ss.backgroundColor);
      sel.style.setProperty('--m-fg', ss.color);
      sel.style.setProperty('--m-bd', ss.borderTopColor);
    }
  }
  /* 選択の移動：塗りつぶしたボタンそのものが動く。
   * 塗りの中には「選ばれたときの文字色で描いた写し」を入れておき、塗りが重なった部分の文字だけがその場で反転して見える。
   */
  function slideTo(key, sel0, from, to) {
    const fly = { sel: sel0 };
    const sel = sel0;
    const group = sel.closest('[data-mg]') || sel.parentElement;
    const cs = getComputedStyle(sel);
    const selFg = cs.color;
    const bw = parseFloat(cs.borderTopWidth) || 0;
    const ghost = document.createElement('div');
    ghost.className = 'm-ghost';
    ghost.style.cssText = 'position:absolute;z-index:40;pointer-events:none;box-sizing:border-box;overflow:hidden;' +
      'border-radius:' + cs.borderRadius + ';background:' + cs.backgroundColor + ';' +
      'border:' + cs.borderTopWidth + ' ' + cs.borderTopStyle + ' ' + cs.borderTopColor + ';box-shadow:' + cs.boxShadow + ';';
    // 写し：グループ全体を、選ばれたときの文字色で描く（ボタンの枠や背景は描かない）
    const g = pageRect(group);
    const copy = group.cloneNode(true);
    copy.removeAttribute('data-mg');
    copy.querySelectorAll('[id]').forEach(el => el.removeAttribute('id'));
    copy.querySelectorAll('[data-mg]').forEach(el => el.removeAttribute('data-mg'));
    copy.classList.add('m-inv');
    copy.setAttribute('aria-hidden', 'true');
    // 横スクロール中の枠は、写しを中身の幅で描いて、スクロールした分だけずらす（見えている並びとぴったり重ねる）
    const sx = group.scrollLeft || 0, sy = group.scrollTop || 0;
    copy.style.cssText = 'position:absolute;margin:0;box-sizing:border-box;overflow:visible;width:' + Math.max(group.scrollWidth, g.r - g.l) + 'px;height:' + Math.max(group.scrollHeight, g.b - g.t) + 'px;--m-sel-fg:' + selFg + ';';
    ghost.appendChild(copy);
    // 見えてよい範囲：横スクロールする枠があればその中、なければ画面の幅の中
    const clip = clipRect(group, from, to);
    const box = document.createElement('div');
    box.className = 'm-ghost-box';
    box.style.cssText = 'position:absolute;z-index:40;pointer-events:none;overflow:hidden;left:' + clip.l + 'px;top:' + clip.t + 'px;width:' + (clip.r - clip.l) + 'px;height:' + (clip.b - clip.t) + 'px;';
    box.appendChild(ghost);
    document.body.appendChild(box);
    hold(sel);
    const lf = liquidFrames(from, to);
    // 写しは塗りと逆向きに動かして、元の文字とぴったり重なったままにする
    const copyFrames = lf.frames.map(f => ({ left: (g.l - sx - parseFloat(f.left) - bw) + 'px', top: (g.t - sy - parseFloat(f.top) - bw) + 'px' }));
    const frames = lf.frames.map(f => Object.assign({}, f, { left: (parseFloat(f.left) - clip.l) + 'px', top: (parseFloat(f.top) - clip.t) + 'px' }));
    const a = run(ghost, frames, { duration: lf.ms, easing: 'linear', fill: 'forwards' });
    run(copy, copyFrames, { duration: lf.ms, easing: 'linear', fill: 'forwards' });
    let ended = false;
    const finish = () => {
      if (ended) return;
      ended = true;
      if (inflight[key] === fly) delete inflight[key];
      fly.sel.classList.remove('m-pending');
      // 着いた時点で、塗りと本物の見た目は同じ。重ねていた塗りを外す
      box.remove();
    };
    fly.cancel = () => { if (ended) return; ended = true; fly.sel.classList.remove('m-pending'); box.remove(); if (inflight[key] === fly) delete inflight[key]; };
    inflight[key] = fly;
    if (a) a.onfinish = finish; else finish();
  }

  // 塗りが見えてよい範囲（ページ上の位置）。周りの影（3px）が切れないよう少しだけ広げる
  function clipRect(group, from, to) {
    const pad = 4;
    const vw = document.documentElement.clientWidth;
    let l = scrollX, r = scrollX + vw;
    let t = Math.min(from.t, to.t) - 40, b = Math.max(from.b, to.b) + 40;
    for (let el = group; el && el !== document.body; el = el.parentElement) {
      const st = getComputedStyle(el);
      if (st.overflowX !== 'visible' || st.overflowY !== 'visible') {
        const gr = el.getBoundingClientRect();
        if (st.overflowX !== 'visible') { l = Math.max(l, gr.left + scrollX - pad); r = Math.min(r, gr.right + scrollX + pad); }
        if (st.overflowY !== 'visible' && el.scrollHeight <= el.clientHeight + 1) { t = Math.max(t, gr.top + scrollY - pad); b = Math.min(b, gr.bottom + scrollY + pad); }
        break;
      }
    }
    return { l: l, r: r, t: t, b: b };
  }

  // 色の明るさ（0＝黒〜1＝白）
  function luminance(css) {
    const m = String(css).match(/\d+(\.\d+)?/g);
    if (!m || m.length < 3) return 1;
    if (m.length >= 4 && Number(m[3]) === 0) return 1;
    const lin = v => { v = Number(v) / 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
    return 0.2126 * lin(m[0]) + 0.7152 * lin(m[1]) + 0.0722 * lin(m[2]);
  }

  function pop(el) {
    const sp = SNAP();
    run(el, [{ transform: 'scale(.94)' }, { transform: 'scale(1)' }], { duration: sp.ms, easing: sp.easing });
  }

  function flipSwitch(sw, fromBg, on) {
    const knob = sw.querySelector('.knob');
    const W = sw.clientWidth, K = knob ? knob.offsetWidth : 22, pad = 3;
    const offL = pad, onL = W - pad - K;
    const fl = on ? offL : onL, tl = on ? onL : offL;
    if (knob) {
      const lf = liquidFrames({ l: fl, r: fl + K, t: pad, b: pad + K }, { l: tl, r: tl + K, t: pad, b: pad + K });
      run(knob, lf.frames, { duration: lf.ms, easing: 'linear' });
    }
    run(sw, [{ backgroundColor: fromBg }, { backgroundColor: getComputedStyle(sw).backgroundColor }], { duration: 200, easing: 'ease-out' });
  }

  // バーやグラフは、その内容を初めて表示したときだけ伸ばす
  const grown = {};
  function grow(c) {
    const key = c.dataset.grow;
    if (!key || grown[key]) return;
    grown[key] = true;
    const sp = SNAP();
    const items = c.querySelectorAll('[data-g]');
    items.forEach((el, i) => {
      const dir = el.dataset.g;
      const from = dir === 'up' ? 'inset(100% 0 0 0)' : 'inset(0 100% 0 0)';
      run(el, [{ clipPath: from }, { clipPath: 'inset(0 0 0 0)' }], { duration: sp.ms, easing: sp.easing, delay: Math.min(i * 16, 320), fill: 'backwards' });
    });
  }

  /* ---------- 新しく届いたもの：ぼかしから、ふわっと浮かび上がる（同じ内容は一度だけ） ---------- */
  const appeared = {};
  function appear(el) {
    const key = el.dataset.appear;
    if (!key || appeared[key]) return;
    appeared[key] = true;
    if (reduce()) return;
    const sp = SNAP();
    const block = getComputedStyle(el).display !== 'inline';
    run(el, [
      { opacity: 0, filter: 'blur(6px)', transform: block ? 'translateY(6px)' : 'none' },
      { opacity: 1, filter: 'blur(0)', transform: 'none' }
    ], { duration: sp.ms + 120, easing: sp.easing, fill: 'backwards' });
  }

  /* ---------- 片付いたもの：高さを縮めながら、ぼけて消える ---------- */
  function collapse(el) {
    if (!el || !el.isConnected || reduce() || !el.animate) return Promise.resolve();
    const cs = getComputedStyle(el);
    const sp = SNAP();
    el.style.overflow = 'hidden';
    const a = run(el, [
      { height: el.offsetHeight + 'px', opacity: 1, filter: 'blur(0)', paddingTop: cs.paddingTop, paddingBottom: cs.paddingBottom, marginTop: cs.marginTop, marginBottom: cs.marginBottom },
      { height: '0px', opacity: 0, filter: 'blur(3px)', paddingTop: '0px', paddingBottom: '0px', marginTop: '0px', marginBottom: '0px' }
    ], { duration: sp.ms, easing: sp.easing, fill: 'forwards' });
    return a ? a.finished.then(() => {}, () => {}) : Promise.resolve();
  }

  /* ---------- ボタン：押すと丸く縮んで読み込み中 → チェック ---------- */
  function busy(btn) {
    const noop = { ok: async () => {}, fail: () => { if (btn) btn.disabled = false; } };
    if (!btn) return noop;
    btn.disabled = true;
    if (reduce() || !btn.animate) return noop;
    const r = btn.getBoundingClientRect();
    const h = r.height;
    const saved = { html: btn.innerHTML, style: btn.getAttribute('style') || '' };
    const morph = r.width > h * 2.2;
    const started = performance.now();
    btn.classList.add('m-busy');
    btn.style.width = r.width + 'px';
    btn.style.height = h + 'px';
    // 横いっぱいのボタンは、真ん中に向かって縮める
    if (morph) {
      const par = btn.parentElement;
      const pw = par ? par.clientWidth - parseFloat(getComputedStyle(par).paddingLeft) - parseFloat(getComputedStyle(par).paddingRight) : 0;
      if (getComputedStyle(btn).display.indexOf('inline') < 0 || r.width >= pw - 2) {
        btn.style.display = 'flex';
        btn.style.marginLeft = 'auto';
        btn.style.marginRight = 'auto';
      }
    }
    btn.innerHTML = '<span class="m-label">' + saved.html + '</span>' +
      '<svg class="m-spin" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8.5"/></svg>' +
      '<svg class="m-check" viewBox="0 0 24 24" aria-hidden="true"><path d="M6.5 12.5l3.8 3.8 7.2-8"/></svg>';
    btn.setAttribute('aria-busy', 'true');
    const label = btn.querySelector('.m-label'), spin = btn.querySelector('.m-spin'), check = btn.querySelector('.m-check');
    run(label, [{ opacity: 1, filter: 'blur(0)' }, { opacity: 0, filter: 'blur(4px)' }], { duration: 110, easing: 'ease-in', fill: 'forwards' });
    const sp = SNAP();
    let shape = null;
    if (morph) shape = run(btn, [{ width: r.width + 'px', borderRadius: '999px' }, { width: h + 'px', borderRadius: '999px' }], { duration: sp.ms, easing: sp.easing, delay: 50, fill: 'forwards' });
    run(spin, [{ opacity: 0, filter: 'blur(3px)' }, { opacity: 1, filter: 'blur(0)' }], { duration: 160, delay: 120, easing: 'ease-out', fill: 'both' });
    let done = false;
    return {
      ok: async () => {
        if (done || !btn.isConnected) return;
        done = true;
        const wait = Math.max(0, 300 - (performance.now() - started));
        if (wait) await new Promise(res => setTimeout(res, wait));
        run(spin, [{ opacity: 1 }, { opacity: 0 }], { duration: 90, easing: 'ease-in', fill: 'forwards' });
        const cs = spring(0.3, 0.8);
        run(check, [{ opacity: 0, strokeDashoffset: 18, transform: 'scale(.8)' }, { opacity: 1, strokeDashoffset: 0, transform: 'scale(1)' }], { duration: cs.ms, delay: 60, easing: cs.easing, fill: 'both' });
        await new Promise(res => setTimeout(res, 60 + cs.ms + 160));
      },
      fail: () => {
        if (done) return;
        done = true;
        if (shape) shape.cancel();
        if (!btn.isConnected) return;
        btn.innerHTML = saved.html;
        btn.setAttribute('style', saved.style);
        btn.classList.remove('m-busy');
        btn.removeAttribute('aria-busy');
        btn.disabled = false;
        if (morph) run(btn, [{ width: h + 'px' }, { width: r.width + 'px' }], { duration: sp.ms, easing: sp.easing });
      }
    };
  }

  /* ---------- お知らせ（トースト）：丸から伸びて出て、縮んで消える ---------- */
  let toastTimer = null;
  function toast(el, msg, ms) {
    if (!el) return;
    clearTimeout(toastTimer);
    el.getAnimations && el.getAnimations().forEach(a => a.cancel());
    el.innerHTML = '<span class="m-tt"></span>';
    el.firstChild.textContent = msg;
    el.classList.add('show');
    const hide = () => el.classList.remove('show');
    if (reduce() || !el.animate) { toastTimer = setTimeout(hide, ms || 2400); return; }
    const w = el.offsetWidth, h = el.offsetHeight, ins = Math.max(0, (w - h) / 2), rad = Math.min(h / 2, 20);
    const sp = SNAP();
    run(el, [
      { clipPath: 'inset(0 ' + ins + 'px round ' + rad + 'px)', transform: 'translateX(-50%) translateY(14px)', opacity: 0 },
      { clipPath: 'inset(0 ' + ins + 'px round ' + rad + 'px)', transform: 'translateX(-50%) translateY(0)', opacity: 1, offset: 0.25 },
      { clipPath: 'inset(0 0px round ' + rad + 'px)', transform: 'translateX(-50%) translateY(0)', opacity: 1 }
    ], { duration: sp.ms + 120, easing: sp.easing, fill: 'forwards' });
    run(el.firstChild, [{ opacity: 0, filter: 'blur(4px)' }, { opacity: 1, filter: 'blur(0)' }], { duration: 180, delay: 140, easing: 'ease-out', fill: 'both' });
    toastTimer = setTimeout(() => {
      run(el.firstChild, [{ opacity: 1, filter: 'blur(0)' }, { opacity: 0, filter: 'blur(4px)' }], { duration: 110, easing: 'ease-in', fill: 'forwards' });
      const out = run(el, [
        { clipPath: 'inset(0 0px round ' + rad + 'px)', transform: 'translateX(-50%) translateY(0)', opacity: 1 },
        { clipPath: 'inset(0 ' + ins + 'px round ' + rad + 'px)', transform: 'translateX(-50%) translateY(0)', opacity: 1, offset: 0.7 },
        { clipPath: 'inset(0 ' + ins + 'px round ' + rad + 'px)', transform: 'translateX(-50%) translateY(10px)', opacity: 0 }
      ], { duration: 300, delay: 80, easing: 'cubic-bezier(.4, 0, .6, 1)', fill: 'forwards' });
      if (out) out.onfinish = () => { hide(); el.getAnimations().forEach(a => a.cancel()); }; else hide();
    }, ms || 2400);
  }

  /* ---------- 下の印（タブ）：前の端が先に伸び、後ろの端があとからついてくる ---------- */
  function indicator(ind, target, width) {
    if (!ind || !target) return;
    const box = ind.offsetParent ? ind.offsetParent.getBoundingClientRect() : { left: 0 };
    const tr = target.getBoundingClientRect();
    const w = width || 28;
    const l = tr.left - box.left + (tr.width - w) / 2;
    const to = { l: l, r: l + w, t: 0, b: ind.offsetHeight || 3 };
    const prev = ind._pos;
    ind._pos = to;
    ind.style.left = to.l + 'px';
    ind.style.width = w + 'px';
    if (!prev || reduce() || Math.abs(prev.l - to.l) < 1) return;
    const lf = liquidFrames(prev, to);
    run(ind, lf.frames.map(f => ({ left: f.left, width: f.width })), { duration: lf.ms, easing: 'linear' });
  }

  /* ---------- 吹き出し（グラフに触れたとき） ----------
   * ・選んでいる棒だけを濃く、ほかを薄くする。吹き出しの矢印がその棒を指す
   * ・触れたまま左右に指をすべらせると、選ぶ棒が変わる
   */
  let tip = null, tipFor = null, tipGroup = null, dragging = false;
  function tipEl() {
    if (!tip) { tip = document.createElement('div'); tip.className = 'm-tip'; tip.innerHTML = '<span></span>'; document.body.appendChild(tip); }
    return tip;
  }
  function showTip(el) {
    if (!el || el === tipFor) return;
    const t = tipEl();
    const first = !t.classList.contains('show');
    if (tipFor) tipFor.classList.remove('m-tip-on');
    const group = el.parentElement;
    if (tipGroup && tipGroup !== group) tipGroup.classList.remove('m-tipping');
    tipGroup = group;
    group.classList.add('m-tipping');
    el.classList.add('m-tip-on');
    tipFor = el;
    t.firstChild.textContent = el.dataset.tip;
    t.classList.add('show');
    const r = el.getBoundingClientRect();
    const gr = group.getBoundingClientRect();
    const tw = t.offsetWidth, th = t.offsetHeight;
    const cx = r.left + r.width / 2;
    const x = Math.max(8, Math.min(innerWidth - tw - 8, cx - tw / 2));
    t.style.left = (x + scrollX) + 'px';
    t.style.top = (Math.min(r.top, gr.top) + scrollY - th - 8) + 'px';
    t.style.setProperty('--ax', Math.max(10, Math.min(tw - 10, cx - x)) + 'px');
    if (first && !reduce()) {
      const sp = SNAP();
      run(t, [{ opacity: 0, transform: 'translateY(4px) scale(.96)' }, { opacity: 1, transform: 'none' }], { duration: sp.ms, easing: sp.easing });
    }
  }
  function hideTip() {
    if (tip) tip.classList.remove('show');
    if (tipFor) tipFor.classList.remove('m-tip-on');
    if (tipGroup) tipGroup.classList.remove('m-tipping');
    tipFor = null; tipGroup = null; dragging = false;
  }
  // 指の左右の位置から、いちばん近い棒を選ぶ（指が棒の上下にずれても選べる）
  function nearest(group, x) {
    const items = group.querySelectorAll(':scope > [data-tip]');
    let best = null, bd = Infinity;
    items.forEach(it => {
      const r = it.getBoundingClientRect();
      const d = x < r.left ? r.left - x : x > r.right ? x - r.right : 0;
      if (d < bd) { bd = d; best = it; }
    });
    return best;
  }
  document.addEventListener('pointerover', e => {
    if (e.pointerType !== 'mouse' || dragging) return;
    const el = e.target.closest && e.target.closest('[data-tip]');
    if (el) showTip(el);
    else if (tipGroup && !(e.target.closest && e.target.closest('.m-tipping'))) hideTip();
  });
  document.addEventListener('pointerdown', e => {
    const el = e.target.closest && e.target.closest('[data-tip]');
    if (!el) { hideTip(); return; }
    dragging = true;
    tipFor = tipFor === el ? null : tipFor;
    showTip(el);
  });
  document.addEventListener('pointermove', e => {
    if (!dragging || !tipGroup) return;
    const el = nearest(tipGroup, e.clientX);
    if (el) showTip(el);
  });
  // 指（ペン）を離したら元に戻す。マウスは、棒の上にある間は表示したまま
  const endDrag = e => {
    const wasDragging = dragging;
    dragging = false;
    if (wasDragging && e.pointerType !== 'mouse') hideTip();
  };
  document.addEventListener('pointerup', endDrag);
  document.addEventListener('pointercancel', endDrag);
  addEventListener('scroll', () => { if (!dragging) hideTip(); }, { passive: true });

  addEventListener('resize', () => { const ind = document.getElementById('tabind'); const on = document.querySelector('.tab.on'); if (ind && on) { ind._pos = null; indicator(ind, on, 28); } });

  /* 画面の描き直し：まるごと作り直さず、変わったところだけ書き換える。
   * 要素がそのまま残るので、横スクロールの位置・動いている途中の形・押した場所がずれない。
   * id か data-key が付いた要素は、前後に要素が増えたり減ったりしても同じ要素として残す（入力中の欄が作り直されない）。
   */
  function patch(root, html) {
    const tpl = document.createElement('template');
    tpl.innerHTML = html;
    patchChildren(root, tpl.content);
  }
  function keyOf(n) { return n.nodeType === 1 ? (n.id || n.getAttribute('data-key') || '') : ''; }
  function findKey(n, k) { for (; n; n = n.nextSibling) if (keyOf(n) === k) return n; return null; }
  function sameNode(a, b) {
    if (a.nodeType !== b.nodeType) return false;
    if (a.nodeType !== 1) return true;
    if (a.tagName !== b.tagName) return false;
    if (keyOf(a) !== keyOf(b)) return false;
    if ((a.getAttribute('data-mg') || '') !== (b.getAttribute('data-mg') || '')) return false;
    if (a.tagName === 'INPUT' && a.type !== b.type) return false;
    // 送信中の形になったボタンは、新しく作り直す
    if (a.classList.contains('m-busy')) return false;
    return true;
  }
  function patchChildren(a, b) {
    let ac = a.firstChild, bc = b.firstChild;
    while (bc) {
      const next = bc.nextSibling;
      if (!ac) { a.appendChild(bc); bc = next; continue; }
      if (sameNode(ac, bc)) { patchNode(ac, bc); ac = ac.nextSibling; bc = next; continue; }
      // 目印のある要素が後ろにずれただけなら、その前に新しい要素を足す
      const ka = keyOf(ac);
      if (ka && findKey(next, ka)) { a.insertBefore(bc, ac); bc = next; continue; }
      // 目印のある要素が前に詰まっただけなら、あいだの消えた要素を取り除く
      const kb = keyOf(bc);
      const m = kb && findKey(ac.nextSibling, kb);
      if (m && sameNode(m, bc)) { while (ac !== m) { const n = ac.nextSibling; a.removeChild(ac); ac = n; } continue; }
      a.insertBefore(bc, ac); a.removeChild(ac); ac = bc.nextSibling; bc = next;
    }
    while (ac) { const n = ac.nextSibling; a.removeChild(ac); ac = n; }
  }
  // 選択肢のうち、HTMLで選ばれているもの
  function selectedOf(sel) {
    const o = sel.querySelector('option[selected]') || sel.querySelector('option');
    return o ? (o.getAttribute('value') !== null ? o.getAttribute('value') : o.textContent) : '';
  }
  const KEEP_VARS = ['--m-bg', '--m-fg', '--m-bd'];
  function patchNode(a, b) {
    if (a.nodeType !== 1) { if (a.nodeValue !== b.nodeValue) a.nodeValue = b.nodeValue; return; }
    const tag = a.tagName;
    const check = tag === 'INPUT' && (a.type === 'checkbox' || a.type === 'radio');
    // 入力欄は、描き直す内容の値が変わったときだけ書き換える（打ちかけの文字や、選びかけの値を消さない）
    const before = check ? a.hasAttribute('checked') : tag === 'INPUT' ? (a.getAttribute('value') || '')
      : tag === 'TEXTAREA' ? a.textContent : tag === 'SELECT' ? selectedOf(a) : null;
    // 動きのために付けている印（m-…）は残す
    const keepCls = Array.prototype.filter.call(a.classList, c => c.indexOf('m-') === 0);
    const keepVars = KEEP_VARS.map(v => [v, a.style.getPropertyValue(v)]).filter(x => x[1]);
    Array.prototype.slice.call(a.attributes).forEach(at => {
      if (!b.hasAttribute(at.name) && at.name !== 'data-mg-prev') a.removeAttribute(at.name);
    });
    Array.prototype.forEach.call(b.attributes, at => {
      if (a.getAttribute(at.name) !== at.value) a.setAttribute(at.name, at.value);
    });
    keepCls.forEach(c => a.classList.add(c));
    keepVars.forEach(x => a.style.setProperty(x[0], x[1]));
    if (tag === 'INPUT') {
      if (check) { const now = b.hasAttribute('checked'); if (now !== before) a.checked = now; }
      else {
        const now = b.getAttribute('value') || '';
        if (now !== before && a !== document.activeElement && a.value !== now) a.value = now;
      }
      return;
    }
    if (tag === 'TEXTAREA') {
      const now = b.textContent;
      if (now !== before) { a.textContent = now; if (a !== document.activeElement) a.value = now; }
      return;
    }
    const nowSel = tag === 'SELECT' ? selectedOf(b) : null;
    patchChildren(a, b);
    if (tag === 'SELECT' && nowSel !== before && a.value !== nowSel) a.value = nowSel;
  }

  return { capture: capture, play: play, patch: patch, busy: busy, toast: toast, indicator: indicator, reduce: reduce, collapse: collapse };
})();
