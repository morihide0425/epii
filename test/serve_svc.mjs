// 画面テスト用：Claude・Square・マネーフォワード・Instagramの仮のサーバーとつないで起動する
import { start } from './env.mjs';
import { startSvcMock, SVC_ENV } from './svcmock.mjs';
import { startIgMock } from './igmock.mjs';
startSvcMock(8841);
startIgMock(8836);
const env = await start({ extra: Object.assign(SVC_ENV(8841), { IG_TOKEN: 'first-token-abcdefghijkl', IG_API_BASE: 'http://127.0.0.1:8836' }) });
console.log('ready');
process.on('SIGTERM', async () => { await env.stop(); process.exit(0); });
setInterval(() => {}, 1000);
