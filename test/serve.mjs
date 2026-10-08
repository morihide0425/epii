import { start } from './env.mjs';
const env = await start();
console.log('ready');
process.on('SIGTERM', async () => { await env.stop(); process.exit(0); });
setInterval(() => {}, 1000);
