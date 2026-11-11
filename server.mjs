#!/usr/bin/env node
// dsh-plugin-price-watcher — vigila precios y alerta cuando bajan.
// Tools: status, add_watch, watches, remove_watch, check, history.

import path from 'node:path';
import os from 'node:os';
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { McpServer } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { z } from 'zod';

const VERSION = '0.1.0';
const DSH_HOME = (() => {
  const v = process.env.DSH_HOME && process.env.DSH_HOME.trim();
  return v || path.join(process.env.USERPROFILE || process.env.HOME || os.homedir(), '.dsh');
})();
const CONFIG_FILE = path.join(DSH_HOME, 'price-watcher', 'config.json');
const WATCHLIST_FILE = path.join(DSH_HOME, 'price-watcher', 'watchlist.json');
const CACHE_DIR = path.join(DSH_HOME, 'cache', 'price-watcher');
const HISTORY_FILE = path.join(CACHE_DIR, 'history.jsonl');
const AUDIT_FILE = path.join(CACHE_DIR, 'audit.jsonl');
const READ_ONLY = String(process.env.DSH_PRICES_MODE || '').toLowerCase() === 'read-only';
const log = (m) => process.stderr.write(`[prices] ${m}\n`);

function loadConfig() {
  const defaults = { allowedHosts: [], webhook: '', timeoutMs: 15_000, userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) dsh-price-watcher/0.1' };
  try { if (existsSync(CONFIG_FILE)) return { ...defaults, ...(JSON.parse(readFileSync(CONFIG_FILE, 'utf8')) || {}) }; } catch (e) { log(`config: ${e.message}`); }
  return defaults;
}
function loadWatches() {
  try { if (existsSync(WATCHLIST_FILE)) { const data = JSON.parse(readFileSync(WATCHLIST_FILE, 'utf8')) || {}; return Array.isArray(data.watches) ? data.watches : []; } } catch (e) { log(`watchlist: ${e.message}`); }
  return [];
}
function saveWatches(watches) { mkdirSync(path.dirname(WATCHLIST_FILE), { recursive: true }); writeFileSync(WATCHLIST_FILE, JSON.stringify({ watches }, null, 2) + '\n', 'utf8'); }
function audit(entry) { try { mkdirSync(CACHE_DIR, { recursive: true }); appendFileSync(AUDIT_FILE, JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\n'); } catch { /* best effort */ } }
function validateUrl(raw) {
  let url;
  try { url = new URL(String(raw || '').trim()); } catch { throw new Error(`URL inválida: ${raw}`); }
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('solo URLs http(s)');
  const config = loadConfig();
  if ((config.allowedHosts || []).length > 0 && !config.allowedHosts.includes(url.hostname)) throw new Error(`host no permitido: ${url.hostname}. allowedHosts: ${config.allowedHosts.join(', ')}`);
  return url;
}
function toNumber(raw) {
  if (raw === null || raw === undefined) return null;
  let value = String(raw).replace(/[^\d.,-]/g, '');
  if (!value) return null;
  if (value.includes(',') && value.includes('.')) value = value.lastIndexOf(',') > value.lastIndexOf('.') ? value.replace(/\./g, '').replace(',', '.') : value.replace(/,/g, '');
  else if (value.includes(',')) value = value.replace(',', '.');
  const number = Number.parseFloat(value);
  return Number.isFinite(number) ? Math.round(number * 100) / 100 : null;
}
function extractPrice(html) {
  for (const match of html.matchAll(/<script[^>]*application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      const data = JSON.parse(match[1].trim());
      const nodes = Array.isArray(data) ? data : [data];
      for (const node of nodes) {
        const offers = node?.offers || node?.offers?.offers;
        const list = Array.isArray(offers) ? offers : offers ? [offers] : [];
        for (const offer of list) {
          const price = toNumber(offer?.price ?? offer?.lowPrice ?? offer?.highPrice);
          if (price !== null) return { price, currency: offer?.priceCurrency || node?.priceCurrency || null, source: 'json-ld' };
        }
      }
    } catch { /* json inválido */ }
  }
  const metaAmount = html.match(/<meta[^>]+(?:property|name)=["'](?:product:price:amount|og:price:amount)["'][^>]+content=["']([\d.,]+)["']/i);
  if (metaAmount) {
    const currency = (html.match(/<meta[^>]+(?:property|name)=["'](?:product:price:currency|og:price:currency)["'][^>]+content=["']([A-Z]{3})["']/i) || [])[1] || null;
    return { price: toNumber(metaAmount[1]), currency, source: 'meta' };
  }
  const inline = html.match(/(?:USD|EUR|MXN|ARS|COP|CLP)\s*\$?\s*([\d.,]+\d)|([\d.,]+\d)\s*(?:USD|EUR|MXN|ARS|COP|CLP)/i);
  if (inline) return { price: toNumber(inline[1] || inline[2]), currency: null, source: 'regex' };
  return null;
}
async function fetchPrice(config, url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeoutMs || 15_000);
  try {
    const response = await fetch(url, { signal: controller.signal, redirect: 'follow', headers: { 'user-agent': config.userAgent } });
    const html = await response.text();
    return { httpStatus: response.status, ...(extractPrice(html) || { price: null, currency: null, source: null }) };
  } catch (error) {
    return { httpStatus: null, price: null, currency: null, source: null, error: error.name === 'AbortError' ? 'timeout' : error.message };
  } finally { clearTimeout(timer); }
}
function record(entry) { try { mkdirSync(CACHE_DIR, { recursive: true }); appendFileSync(HISTORY_FILE, JSON.stringify(entry) + '\n'); } catch { /* best effort */ } }
async function sendAlert(config, alerts) {
  if (!config.webhook) throw new Error(`no hay webhook configurado en ${CONFIG_FILE}`);
  const lines = alerts.map((alert) => `- ${alert.name}: ${alert.price} ${alert.currency || ''} (objetivo ${alert.targetPrice}) en ${alert.url}`);
  const response = await fetch(config.webhook, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ content: `💸 Price Watcher: ${alerts.length} precio(s) en objetivo\n${lines.join('\n')}` }) });
  if (!response.ok) throw new Error(`webhook respondió ${response.status}`);
}
function textResult(t) { return { content: [{ type: 'text', text: t }] }; }

function buildInstructions() {
  return [
    'Price Watcher: vigila precios de productos y avisa cuando bajan del objetivo.',
    '',
    `Lista: ${WATCHLIST_FILE}`,
    '',
    'Herramientas: status, add_watch, watches, remove_watch, check, history.',
    '',
    'Reglas:',
    '- add_watch/remove_watch requieren confirm:true; check solo lee.',
    '- Las alertas por webhook se envían solo con notify:true y confirm:true.',
    '- Extrae precios de JSON-LD/OpenGraph; si no puede, dilo (no inventes precios).',
    '- Respeta allowedHosts.',
  ].join('\n');
}

function buildServer() {
  const server = new McpServer({ name: 'dsh-plugin-price-watcher', version: VERSION }, { capabilities: { tools: {} }, instructions: buildInstructions() });

  server.registerTool(
    'status',
    { title: 'Estado', description: 'Productos vigilados, webhook y modo.', inputSchema: z.object({}) },
    async () => {
      const config = loadConfig();
      const watches = loadWatches();
      return textResult([`Modo: ${READ_ONLY ? 'read-only' : 'normal'}`, `Productos: ${watches.length} (${watches.map((w) => w.name).join(', ') || 'ninguno'})`, `Alertas: ${config.webhook ? 'webhook configurado' : 'sin webhook'}`, `Hosts permitidos: ${(config.allowedHosts || []).length ? config.allowedHosts.join(', ') : 'todos'}`, `Config: ${CONFIG_FILE}`].join('\n'));
    },
  );

  server.registerTool(
    'add_watch',
    {
      title: 'Vigilar producto',
      description: 'Agrega un producto a la lista de vigilancia. Requiere confirm:true.',
      inputSchema: z.object({ name: z.string().min(1).max(80), url: z.string().min(6), targetPrice: z.number().positive().optional(), confirm: z.boolean().optional() }),
    },
    async (args) => {
      if (READ_ONLY) throw new Error('modo read-only: add_watch deshabilitado');
      if (args.confirm !== true) throw new Error('add_watch requiere confirm:true');
      const url = validateUrl(args.url);
      const watches = loadWatches();
      if (watches.some((watch) => watch.name === args.name)) throw new Error(`ya existe un producto con nombre ${args.name}`);
      const watch = { name: args.name, url: url.toString(), targetPrice: args.targetPrice ?? null, addedAt: new Date().toISOString() };
      watches.push(watch);
      saveWatches(watches);
      audit({ tool: 'add_watch', name: watch.name, url: watch.url, ok: true });
      return textResult(`Vigilando ${watch.name} → ${watch.url}${watch.targetPrice ? ` (objetivo ${watch.targetPrice})` : ''}.`);
    },
  );

  server.registerTool(
    'watches',
    { title: 'Listar productos', description: 'Lista los productos vigilados con objetivo.', inputSchema: z.object({}) },
    async () => {
      const watches = loadWatches();
      if (watches.length === 0) return textResult('Sin productos vigilados.');
      return textResult(watches.map((watch) => `- ${watch.name}: ${watch.url}${watch.targetPrice ? ` · objetivo ${watch.targetPrice}` : ''}`).join('\n'));
    },
  );

  server.registerTool(
    'remove_watch',
    { title: 'Quitar producto', description: 'Elimina un producto de la lista. Requiere confirm:true.', inputSchema: z.object({ name: z.string().min(1), confirm: z.boolean().optional() }) },
    async (args) => {
      if (READ_ONLY) throw new Error('modo read-only: remove_watch deshabilitado');
      if (args.confirm !== true) throw new Error('remove_watch requiere confirm:true');
      const watches = loadWatches();
      const filtered = watches.filter((watch) => watch.name !== args.name);
      if (filtered.length === watches.length) throw new Error(`producto no encontrado: ${args.name}`);
      saveWatches(filtered);
      audit({ tool: 'remove_watch', name: args.name, ok: true });
      return textResult(`Producto ${args.name} eliminado.`);
    },
  );

  server.registerTool(
    'check',
    {
      title: 'Comprobar precios',
      description: 'Consulta los precios actuales, guarda historial y opcionalmente alerta por webhook (confirm:true).',
      inputSchema: z.object({ name: z.string().optional(), notify: z.boolean().optional(), confirm: z.boolean().optional() }),
    },
    async (args) => {
      const config = loadConfig();
      const watches = loadWatches();
      const selected = args.name ? watches.filter((watch) => watch.name === args.name) : watches;
      if (selected.length === 0) throw new Error(args.name ? `producto no encontrado: ${args.name}` : 'sin productos vigilados');
      if (args.notify === true && args.confirm !== true) throw new Error('enviar alertas requiere confirm:true');
      const results = [];
      for (const watch of selected) {
        const result = await fetchPrice(config, watch.url);
        const entry = { ts: new Date().toISOString(), name: watch.name, url: watch.url, targetPrice: watch.targetPrice, ...result };
        record(entry);
        results.push(entry);
      }
      const alerts = results.filter((result) => result.price !== null && result.targetPrice !== null && result.price <= result.targetPrice);
      const lines = results.map((result) => result.price === null
        ? `❌ ${result.name}: no se pudo extraer el precio${result.error ? ` (${result.error})` : ''}`
        : `${alerts.includes(result) ? '🎯' : '•'} ${result.name}: ${result.price} ${result.currency || ''} (${result.source})${result.targetPrice ? ` · objetivo ${result.targetPrice}` : ''}`);
      if (args.notify === true && alerts.length > 0) { await sendAlert(config, alerts); lines.push('', `Alerta enviada por ${alerts.length} precio(s) en objetivo.`); }
      audit({ tool: 'check', count: results.length, alerts: alerts.length, ok: true });
      return textResult(lines.join('\n'));
    },
  );

  server.registerTool(
    'history',
    { title: 'Historial', description: 'Últimos precios guardados.', inputSchema: z.object({ name: z.string().optional(), limit: z.number().int().min(1).max(200).optional() }) },
    async (args) => {
      let lines = [];
      try { lines = readFileSync(HISTORY_FILE, 'utf8').trim().split(/\r?\n/).filter(Boolean); } catch { /* vacío */ }
      let rows = lines.map((line) => { try { return JSON.parse(line); } catch { return null; } }).filter(Boolean);
      if (args.name) rows = rows.filter((row) => row.name === args.name);
      rows = rows.slice(-(args.limit ?? 20));
      if (rows.length === 0) return textResult('Sin historial. Usa check.');
      return textResult(rows.map((row) => `${row.ts} ${row.name}: ${row.price ?? '?'} ${row.currency || ''}${row.targetPrice ? ` (objetivo ${row.targetPrice})` : ''}`).join('\n'));
    },
  );

  return server;
}

try {
  mkdirSync(CACHE_DIR, { recursive: true });
  if (!existsSync(CONFIG_FILE)) {
    mkdirSync(path.dirname(CONFIG_FILE), { recursive: true });
    writeFileSync(CONFIG_FILE, JSON.stringify({ allowedHosts: [], webhook: '', timeoutMs: 15000 }, null, 2) + '\n', 'utf8');
  }
  if (!existsSync(WATCHLIST_FILE)) saveWatches([]);
} catch (e) { log(`init: ${e.message}`); }
log(`modo ${READ_ONLY ? 'read-only' : 'normal'} · config: ${CONFIG_FILE}`);
serveStdio(buildServer, { onerror: (e) => log(`serveStdio: ${e.message}`) });
process.on('uncaughtException', (e) => log(`excepción: ${e.message}`));
process.on('unhandledRejection', (e) => log(`rechazo: ${e && e.message ? e.message : String(e)}`));
