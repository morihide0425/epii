import { start } from './env.mjs';
import { startIgMock } from './igmock.mjs';
startIgMock(8836);
const env = await start({ extra: { IG_TOKEN: 'first-token-abcdefghijkl', IG_API_BASE: 'http://127.0.0.1:8836' } });
console.log('ready');
process.on('SIGTERM', async () => { await env.stop(); process.exit(0); });
setInterval(() => {}, 1000);
