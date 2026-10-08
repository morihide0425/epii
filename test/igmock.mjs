// Instagram Graph APIの代わりに応答するテスト用サーバー
import http from 'node:http';
export const calls = [];
export function startIgMock(port) {
  const now = Date.now();
  const iso = ms => new Date(ms).toISOString().replace('.000Z', '+0000');
  const day = 86400000;
  // 直近の投稿：リールは伸びる、投稿は普通。ストーリーは数日おき
  const media = [];
  for (let i = 1; i <= 8; i++) media.push({ id: 'p' + i, caption: (i % 2 ? '季節の薬膳ランチ' : '秋の一皿') + ' #' + i, media_type: 'IMAGE', media_product_type: i % 2 ? 'REELS' : 'FEED', timestamp: iso(now - i * 3 * day - 3600000 * (i % 2 ? 2 : 6)), permalink: 'https://www.instagram.com/p/x' + i, like_count: 30 + i, comments_count: i });
  const stories = [{ id: 's1', media_type: 'IMAGE', timestamp: iso(now - 5 * 3600000), permalink: 'https://www.instagram.com/stories/x/1' }];
  const srv = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    calls.push(u.pathname);
    const send = j => { if (!res.headersSent) res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(j)); };
    if (u.searchParams.get('access_token') === 'expired') { res.writeHead(400); return send({ error: { message: 'Error validating access token', code: 190 } }); }
    if (u.pathname === '/refresh_access_token') return send({ access_token: 'refreshed-token', expires_in: 5184000 });
    if (u.pathname === '/v23.0/me') return send({ user_id: '17841', username: 'epii_osaka', followers_count: 1234, media_count: 200 });
    if (u.pathname === '/v23.0/me/insights') {
      const m = u.searchParams.get('metric');
      const v = { reach: 300, views: 900, profile_views: 40, accounts_engaged: 25, total_interactions: 60, profile_links_taps: 1 }[m];
      if (v === undefined) { res.writeHead(400); return send({ error: { message: 'unsupported metric', code: 100 } }); }
      return send({ data: [{ name: m, period: 'day', total_value: { value: v } }] });
    }
    if (u.pathname === '/v23.0/me/media') return send({ data: media });
    if (u.pathname === '/v23.0/me/stories') return send({ data: stories });
    const mm = u.pathname.match(/^\/v23\.0\/(\w+)\/insights$/);
    if (mm) {
      const id = mm[1];
      const reel = media.find(x => x.id === id && x.media_product_type === 'REELS');
      const names = u.searchParams.get('metric').split(',');
      return send({ data: names.map(n => ({ name: n, values: [{ value: n === 'reach' ? (id === 's1' ? 150 : reel ? 800 : 300) : n === 'saved' ? 12 : 5 }] })) });
    }
    res.writeHead(404); send({ error: { message: 'not found' } });
  }).listen(port);
  return srv;
}
