// Test end-to-end de price-watcher con páginas HTML locales y webhook mock.
import path from 'node:path';
import http from 'node:http';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

const packageDir = path.resolve(import.meta.dirname, '..');
const tmpDir = path.join(packageDir, 'test', 'tmp');
rmSync(tmpDir, { recursive: true, force: true });
mkdirSync(path.join(tmpDir, 'dsh-home', 'price-watcher'), { recursive: true });

const product1 = `<html><head><title>Bot</title>
<script type="application/ld+json">{"@context":"https://schema.org","@type":"Product","name":"Bot WENDIGO","offers":{"@type":"Offer","price":"89.99","priceCurrency":"USD"}}</script>
</head><body>Bot</body></html>`;
const product2 = `<html><head>
<meta property="product:price:amount" content="120.50" />
<meta property="product:price:currency" content="EUR" />
</head><body>Web</body></html>`;

const site = http.createServer((req, res) => {
  if (req.url === '/product1') { res.writeHead(200, { 'content-type': 'text/html' }); res.end(product1); }
  else if (req.url === '/product2') { res.writeHead(200, { 'content-type': 'text/html' }); res.end(product2); }
  else { res.writeHead(404); res.end('no'); }
});
await new Promise((r) => site.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${site.address().port}`;

let webhookBody = null;
const webhook = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => { webhookBody = Buffer.concat(chunks).toString('utf8'); res.writeHead(204); res.end(); });
});
await new Promise((r) => webhook.listen(0, '127.0.0.1', r));
const configFile = path.join(tmpDir, 'dsh-home', 'price-watcher', 'config.json');
writeFileSync(configFile, JSON.stringify({ allowedHosts: ['127.0.0.1'], webhook: '', timeoutMs: 10000 }, null, 2), 'utf8');

function makeClient(extraEnv = {}) {
  const entry = process.env.PRICES_SERVER ? path.resolve(process.env.PRICES_SERVER) : path.join(packageDir, 'server.mjs');
  const transport = new StdioClientTransport({ command: process.execPath, args: [entry], env: { SystemRoot: process.env.SystemRoot || 'C:\\Windows', PATH: process.env.PATH, USERPROFILE: process.env.USERPROFILE, HOME: process.env.HOME || process.env.USERPROFILE, TEMP: process.env.TEMP, TMP: process.env.TMP, DSH_HOME: path.join(tmpDir, 'dsh-home'), ...extraEnv }, stderr: 'pipe' });
  transport.stderr?.on('data', (c) => process.stderr.write(`[server] ${c}`));
  const client = new Client({ name: 'prices-test', version: '1.0.0' }, { capabilities: {}, versionNegotiation: { mode: 'auto' } });
  return client.connect(transport).then(() => ({ client, transport }));
}
const textOf = (r) => (r.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n');

const { client, transport } = await makeClient();
console.log('tools:', (await client.listTools()).tools.map((t) => t.name).join(', '));
console.log('--- status ---'); console.log(textOf(await client.callTool({ name: 'status', arguments: {} })));
const noConfirm = await client.callTool({ name: 'add_watch', arguments: { name: 'bot', url: `${base}/product1` } });
console.log('add sin confirm isError:', noConfirm.isError === true);
const a1 = await client.callTool({ name: 'add_watch', arguments: { name: 'bot', url: `${base}/product1`, targetPrice: 100, confirm: true } });
const a2 = await client.callTool({ name: 'add_watch', arguments: { name: 'web', url: `${base}/product2`, confirm: true } });
console.log('--- add ---'); console.log(textOf(a1)); console.log(textOf(a2));
console.log('--- watches ---'); console.log(textOf(await client.callTool({ name: 'watches', arguments: {} })));
const check = await client.callTool({ name: 'check', arguments: {} });
console.log('--- check ---'); console.log(textOf(check));
const checkText = textOf(check);
console.log('precio 89.99:', checkText.includes('89.99'), '| precio 120.5:', checkText.includes('120.5'), '| objetivo detectado:', checkText.includes('🎯'));
console.log('--- history ---'); console.log(textOf(await client.callTool({ name: 'history', arguments: {} })));
// alerta con webhook
const cfg = JSON.parse((await import('node:fs')).readFileSync(configFile, 'utf8'));
cfg.webhook = `http://127.0.0.1:${webhook.address().port}/hook`;
writeFileSync(configFile, JSON.stringify(cfg, null, 2), 'utf8');
const alertCheck = await client.callTool({ name: 'check', arguments: { name: 'bot', notify: true, confirm: true } });
console.log('--- check con alerta ---'); console.log(textOf(alertCheck));
console.log('webhook recibió alerta:', Boolean(webhookBody) && webhookBody.includes('89.99'));
const blocked = await client.callTool({ name: 'add_watch', arguments: { name: 'x', url: 'https://example.com/p', confirm: true } });
console.log('host no permitido isError:', blocked.isError === true);
const removed = await client.callTool({ name: 'remove_watch', arguments: { name: 'web', confirm: true } });
console.log('--- remove ---'); console.log(textOf(removed));
await client.close(); try { await transport.close?.(); } catch {}
const { client: roClient, transport: roTransport } = await makeClient({ DSH_PRICES_MODE: 'read-only' });
const roAdd = await roClient.callTool({ name: 'add_watch', arguments: { name: 'x', url: `${base}/product1`, confirm: true } });
console.log('read-only add isError:', roAdd.isError === true);
const roCheck = await roClient.callTool({ name: 'check', arguments: { name: 'bot' } });
console.log('read-only check permitido:', roCheck.isError !== true);
await roClient.close(); try { await roTransport.close?.(); } catch {}
site.close(); webhook.close();
console.log('OK');
