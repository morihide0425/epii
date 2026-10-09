/* ===== 共通の計算（サーバーと予約ページの両方で使います） ===== */
// 時間帯（モーニング・ランチ・ディナーなど）は、お店ごとに増やせます
function sessionKeys(s) {
  const list = Object.keys(s.sessions || {});
  return list.sort((a, b) => toMin(s.sessions[a].first) - toMin(s.sessions[b].first));
}

function sessionLabel(s, key) {
  const c = s.sessions ? s.sessions[key] : null;
  return (c && c.name) || key;
}

// カレンダーでの短い表示（1〜2文字）
function sessionShort(s, key) {
  const c = s.sessions ? s.sessions[key] : null;
  return (c && (c.short || (c.name || '').slice(0, 1))) || String(key).slice(0, 1);
}

function sessionEn(s, key) {
  const c = s.sessions ? s.sessions[key] : null;
  if (c && c.en) return c.en;
  const table = {
    'モーニング': 'Morning', '朝食': 'Breakfast', 'ブランチ': 'Brunch', 'ランチ': 'Lunch',
    'ティータイム': 'Tea time', 'カフェ': 'Cafe', 'ディナー': 'Dinner', 'ディナーセット': 'Dinner set',
    'ディナーコース': 'Dinner course', '夜の部': 'Dinner', '昼の部': 'Lunch'
  };
  return table[(c && c.name) || ''] || '';
}

function pad(n) { return String(n).padStart(2, '0'); }
function toMin(t) { const p = String(t).split(':'); return Number(p[0]) * 60 + Number(p[1]); }
function toHM(m) { return pad(Math.floor(m / 60)) + ':' + pad(m % 60); }
// 形だけでなく、実在する日付かどうかも確かめる（2026-13-45 などをはじく）
function isDate(s) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(s))) return false;
  const p = String(s).split('-').map(Number);
  const d = new Date(Date.UTC(p[0], p[1] - 1, p[2]));
  return d.getUTCFullYear() === p[0] && d.getUTCMonth() === p[1] - 1 && d.getUTCDate() === p[2];
}
function isTime(s) { return /^([01]\d|2[0-3]):[0-5]\d$/.test(String(s)); }

function addDays(date, n) {
  const p = String(date).split('-').map(Number);
  const d = new Date(Date.UTC(p[0], p[1] - 1, p[2] + n));
  return d.getUTCFullYear() + '-' + pad(d.getUTCMonth() + 1) + '-' + pad(d.getUTCDate());
}

function weekday(date) {
  const p = String(date).split('-').map(Number);
  return new Date(Date.UTC(p[0], p[1] - 1, p[2])).getUTCDay();
}

// 日本時間の「日付 時刻」の文字列（例：2026-09-15 18:30）
function jstStamp(epochMs) {
  const d = new Date(epochMs + 9 * 3600 * 1000);
  return d.getUTCFullYear() + '-' + pad(d.getUTCMonth() + 1) + '-' + pad(d.getUTCDate()) + ' ' +
    pad(d.getUTCHours()) + ':' + pad(d.getUTCMinutes());
}

// 時間帯ごとの予約時間の一覧
function sessionSlots(s, key) {
  const c = s.sessions[key];
  const out = [];
  if (!c) return out;
  const step = Math.max(10, Number(c.interval) || 30);
  for (let m = toMin(c.first); m <= toMin(c.last); m += step) out.push({ time: toHM(m), session: key });
  return out;
}

// その日にどの時間帯を営業するか
function dayPlan(date, rules, s) {
  const r = rules[date];
  if (r) {
    if (r.kind === 'off' || r.kind === 'private') return { kind: r.kind, sessions: [], custom: true };
    return { kind: 'open', sessions: r.sessions, custom: true };
  }
  const w = s.weekly[String(weekday(date))] || [];
  return { kind: w.length ? 'open' : 'off', sessions: w, custom: false };
}

function daySlots(date, rules, s) {
  const plan = dayPlan(date, rules, s);
  const out = [];
  sessionKeys(s).forEach(k => {
    if (plan.sessions.indexOf(k) >= 0) sessionSlots(s, k).forEach(x => out.push(x));
  });
  return out.sort((a, b) => toMin(a.time) - toMin(b.time));
}

// その時刻に予約を受け付けている時間帯（重なっている場合は複数）
function sessionsAt(date, time, rules, s) {
  return daySlots(date, rules, s).filter(x => x.time === time).map(x => x.session);
}

// メニューに合う時間帯を選ぶ（メニュー未指定なら最初のもの）
function sessionFor(date, time, rules, s, course) {
  const list = sessionsAt(date, time, rules, s);
  if (!list.length) return '';
  if (!course) return list[0];
  return list.find(k => course.sessions.indexOf(k) >= 0) || '';
}

// 予約を受け付ける最終日（日付を決めて開ける／今日から◯日先まで）
function bookingEnd(s, today) {
  return s.openUntil ? s.openUntil : addDays(today, Number(s.aheadDays) || 60);
}

// メニューごとの締切
function cutoffRule(c, s) {
  return c.cutoff_mode === 'custom' ? { days: Number(c.cutoff_days), time: c.cutoff_time } : s.cutoff;
}

// 予約の変更をいつまで受け付けるか（メニューごと）
function changeRule(c, s) {
  return c.chg_mode === 'custom' ? { days: Number(c.chg_days), time: c.chg_time } : s.changeCutoff;
}

function deadlineOf(date, rule) {
  return addDays(date, -Number(rule.days)) + ' ' + rule.time;
}

// 期間限定のメニュー：「10/1〜10/31」「10/1から」「10/31まで」（決めていなければ空）
function periodText(c) {
  const md = d => Number(d.slice(5, 7)) + '/' + Number(d.slice(8, 10));
  if (c.date_from && c.date_to) return md(c.date_from) + '〜' + md(c.date_to);
  if (c.date_from) return md(c.date_from) + 'から';
  if (c.date_to) return md(c.date_to) + 'まで';
  return '';
}
function inPeriod(c, date) { return !(c.date_from && date < c.date_from) && !(c.date_to && date > c.date_to); }

// このメニューを、この日時・人数で予約できるか（できない場合は理由を返す）
function courseCheck(c, date, time, session, guests, now, s, ignoreDeadline) {
  if (!inPeriod(c, date)) return 'period';
  if (c.sessions.indexOf(session) < 0) return 'session';
  if (c.weekdays.indexOf(weekday(date)) < 0) return 'weekday';
  if (guests < c.min_guests) return 'guests';
  if (now >= date + ' ' + time) return 'past';
  if (!ignoreDeadline && now > deadlineOf(date, cutoffRule(c, s))) return 'deadline';
  return '';
}

// 席の計算に使う一覧を、日付ごとにまとめる
function buildIndex(holds, blocks, s) {
  const idx = {};
  const get = d => idx[d] || (idx[d] = { items: [], stops: [] });
  holds.forEach(h => {
    const a = toMin(h.time);
    const c = s.sessions[h.session];
    // 予約ごとに「何時まで」を決めている場合は、その長さを使う
    const len = Number(h.stay) > 0 ? Number(h.stay) : (c ? Number(c.stay) : 120);
    get(h.date).items.push({ id: h.id, a: a, b: a + len, g: Number(h.guests) || 0 });
  });
  blocks.forEach(b => {
    if (b.type === 'stop') {
      get(b.date).stops.push({ a: toMin(b.start), b: toMin(b.end) });
    } else {
      const g = b.seats === null || b.seats === undefined || b.seats === '' ? s.seats : Number(b.seats);
      get(b.date).items.push({ id: b.id, a: toMin(b.start), b: toMin(b.end), g: g });
    }
  });
  return idx;
}

function usedAt(idx, date, minute, excludeId) {
  const d = idx[date];
  if (!d) return 0;
  const skip = excludeId === null || excludeId === undefined ? [] : (Array.isArray(excludeId) ? excludeId : [excludeId]);
  let u = 0;
  d.items.forEach(i => { if (skip.indexOf(i.id) < 0 && i.a <= minute && minute < i.b) u += i.g; });
  return u;
}

function stoppedAt(idx, date, minute) {
  const d = idx[date];
  return !!d && d.stops.some(x => x.a <= minute && minute < x.b);
}

// 滞在時間のあいだで、いちばん少ない空席数
// 人数が増えるのは「ほかの予約やブロックが始まる時刻」だけなので、その時刻だけを調べる
function leftAt(idx, date, time, session, excludeId, s, stay) {
  const c = s.sessions[session];
  const start = toMin(time);
  if (!c || stoppedAt(idx, date, start)) return 0;
  const end = start + (Number(stay) > 0 ? Number(stay) : Number(c.stay));
  const points = [start];
  const d = idx[date];
  const skip = excludeId === null || excludeId === undefined ? [] : (Array.isArray(excludeId) ? excludeId : [excludeId]);
  if (d) {
    d.items.forEach(i => {
      if (skip.indexOf(i.id) < 0 && i.a > start && i.a < end) points.push(i.a);
    });
  }
  let left = s.seats;
  points.forEach(m => { left = Math.min(left, s.seats - usedAt(idx, date, m, excludeId)); });
  return Math.max(0, left);
}
// メニューごとの上限人数（同じ時間に重なるそのメニューの予約の合計）。上限なしなら大きな数を返す
function courseLeft(holds, s, course, date, time, session, excludeId) {
  if (!course || !course.cap) return 9999;
  const idx = buildIndex(holds.filter(h => h.course === course.id), [], s);
  const c = s.sessions[session];
  if (!c) return 0;
  const start = toMin(time);
  const end = start + Number(c.stay);
  const skip = excludeId === null || excludeId === undefined ? [] : (Array.isArray(excludeId) ? excludeId : [excludeId]);
  const points = [start];
  const d = idx[date];
  if (d) d.items.forEach(i => { if (skip.indexOf(i.id) < 0 && i.a > start && i.a < end) points.push(i.a); });
  let left = Number(course.cap);
  points.forEach(m => { left = Math.min(left, Number(course.cap) - usedAt(idx, date, m, excludeId)); });
  return Math.max(0, left);
}
/* ===== 共通の計算ここまで ===== */
