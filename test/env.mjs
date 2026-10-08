import http from 'node:http';
import { Miniflare } from 'miniflare';
export const pushes = [];
export let failPush = false;
export function setFailPush(v) { failPush = v; }
export async function start({ port = 8787, linePort = 8790, extra = {} } = {}) {
  const line = http.createServer((req, res) => {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      if (req.url === '/oauth2/v2.1/verify') {
        const p = new URLSearchParams(body);
        const t = p.get('id_token');
        if (t === 'bad' || p.get('client_id') !== '2011619064') { res.writeHead(400); res.end('{"error":"invalid_request"}'); return; }
        res.end(JSON.stringify({ sub: 'U_' + t, name: 'LINE ' + t, aud: p.get('client_id') }));
        return;
      }
      if (req.url === '/v2/bot/message/push') {
        const j = JSON.parse(body);
        if (failPush) { res.writeHead(400); res.end('{"message":"bad"}'); return; }
        pushes.push(j); res.end('{}'); return;
      }
      if (req.url === '/v2/bot/message/quota') { res.end('{"type":"limited","value":200}'); return; }
      if (req.url === '/v2/bot/message/quota/consumption') { res.end(JSON.stringify({ totalUsage: pushes.length })); return; }
      res.writeHead(404); res.end();
    });
  }).listen(linePort);
  const mf = new Miniflare({
    modules: true, scriptPath: new URL('../dist/worker.js', import.meta.url).pathname,
    compatibilityDate: '2025-09-01', d1Databases: ['DB'], port, host: '127.0.0.1',
    bindings: {
      ADMIN_PASSWORD: 'pw-test-123', LINE_TOKEN: 'tok', OWNER_USER_ID: 'Uowner',
      LINE_CHANNEL_ID: '2011619064', LIFF_ID: '2011619064-letOFBEZ', LINE_ID: '@784oxjnq',
      LINE_API_BASE: 'http://127.0.0.1:' + linePort,
      ...extra
    }
  });
  await mf.ready;
  return { mf, stop: async () => { await mf.dispose(); line.close(); } };
}
