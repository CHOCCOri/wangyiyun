import http from 'node:http';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const VERSION = 'meting-bridge-1.0.0';
const PORT = Math.max(1, Math.min(65535, Number(process.env.PORT) || 3000));
const SESSION_HOURS = Math.max(1, Math.min(168, Number(process.env.METING_SESSION_HOURS) || 12));
const RATE_LIMIT = Math.max(10, Math.min(1000, Number(process.env.METING_RATE_LIMIT) || 120));
const SECRET = String(process.env.METING_SESSION_SECRET || '');
const ALLOWED = new Set(String(process.env.METING_ALLOWED_ORIGINS || '').split(',').map(x => x.trim()).filter(Boolean));
if (SECRET.length < 32) throw new Error('METING_SESSION_SECRET must contain at least 32 characters');
if (!ALLOWED.size) throw new Error('METING_ALLOWED_ORIGINS is required');
const KEY = crypto.createHash('sha256').update(SECRET).digest();
const limits = new Map();
let mcpClient = null;
let mcpTransport = null;
let connecting = null;

function json(res, status, body, origin = '') {
  const data = Buffer.from(JSON.stringify(body));
  const headers = {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(data.length),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    'content-security-policy': "default-src 'none'; frame-ancestors 'none'",
  };
  if (origin && ALLOWED.has(origin)) {
    headers['access-control-allow-origin'] = origin;
    headers['vary'] = 'Origin';
  }
  res.writeHead(status, headers); res.end(data);
}
function ipOf(req) { return String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim(); }
function rateOk(req) {
  const now = Date.now(), key = ipOf(req), old = limits.get(key);
  if (!old || now - old.start >= 60000) { limits.set(key, { start: now, count: 1 }); return true; }
  old.count += 1; return old.count <= RATE_LIMIT;
}
function validOrigin(req) {
  const origin = String(req.headers.origin || '');
  return origin && ALLOWED.has(origin) ? origin : '';
}
async function readJson(req, max = 65536) {
  const chunks = []; let size = 0;
  for await (const chunk of req) { size += chunk.length; if (size > max) throw Object.assign(new Error('body_too_large'), { status: 413 }); chunks.push(chunk); }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); }
  catch { throw Object.assign(new Error('invalid_json'), { status: 400 }); }
}
function b64url(buf) { return Buffer.from(buf).toString('base64url'); }
function seal(cookie) {
  const iv = crypto.randomBytes(12), cipher = crypto.createCipheriv('aes-256-gcm', KEY, iv);
  const now = Date.now();
  const plain = Buffer.from(JSON.stringify({ cookie, iat: now, exp: now + SESSION_HOURS * 3600000 }));
  const encrypted = Buffer.concat([cipher.update(plain), cipher.final()]);
  return [b64url(iv), b64url(cipher.getAuthTag()), b64url(encrypted)].join('.');
}
function unseal(token) {
  try {
    const [a,b,c] = String(token || '').split('.'); if (!a || !b || !c) return null;
    const decipher = crypto.createDecipheriv('aes-256-gcm', KEY, Buffer.from(a, 'base64url'));
    decipher.setAuthTag(Buffer.from(b, 'base64url'));
    const data = JSON.parse(Buffer.concat([decipher.update(Buffer.from(c, 'base64url')), decipher.final()]).toString('utf8'));
    if (!data || typeof data.cookie !== 'string' || Date.now() > Number(data.exp)) return null;
    return data;
  } catch { return null; }
}
function sessionFrom(req) {
  const h = String(req.headers.authorization || '');
  return h.startsWith('Bearer ') ? unseal(h.slice(7).trim()) : null;
}
function sanitizeCookie(raw) {
  const cookie = String(raw || '').trim();
  if (!cookie || cookie.length > 16384 || /[\r\n\0]/.test(cookie)) return '';
  return cookie;
}
async function connectMcp() {
  if (mcpClient) return mcpClient;
  if (connecting) return connecting;
  connecting = (async () => {
    const entry = import.meta.resolve('@eldment/meting-agent');
    const bin = fileURLToPath(new URL('./index.js', entry));
    const env = { ...process.env };
    for (const key of Object.keys(env)) if (/^METING_(?:NETEASE|TENCENT|KUGOU|KUWO|COOKIE)/.test(key)) delete env[key];
    mcpTransport = new StdioClientTransport({ command: process.execPath, args: [bin], env, stderr: 'pipe' });
    const client = new Client({ name: 'clear-glass-meting-bridge', version: VERSION });
    await client.connect(mcpTransport);
    mcpClient = client;
    return client;
  })().finally(() => { connecting = null; });
  return connecting;
}
async function callAgent(name, args) {
  let client = await connectMcp();
  let result;
  try { result = await client.callTool({ name, arguments: args }); }
  catch (error) { mcpClient = null; try { await mcpTransport?.close(); } catch {} mcpTransport = null; client = await connectMcp(); result = await client.callTool({ name, arguments: args }); }
  const text = result?.content?.find(x => x.type === 'text')?.text;
  if (!text) throw new Error('empty_agent_response');
  const parsed = JSON.parse(text);
  if (!parsed.ok) throw new Error(parsed.message || 'agent_error');
  return parsed.data;
}
function cleanId(value) { const out = String(value ?? '').trim(); return out && out.length <= 128 ? out : ''; }
function cleanInt(value, fallback, min, max) { const n = Number(value); return Number.isInteger(n) && n >= min && n <= max ? n : fallback; }
async function apiCall(operation, body, cookie) {
  const common = { platform: 'netease', cookie };
  if (operation === 'search') {
    const keyword = String(body.keyword || '').trim().slice(0, 120); if (!keyword) throw Object.assign(new Error('keyword_required'), { status: 400 });
    return callAgent('search', { ...common, keyword, page: cleanInt(body.page, 1, 1, 100), limit: cleanInt(body.limit, 20, 1, 50) });
  }
  const id = cleanId(body.id); if (!id) throw Object.assign(new Error('id_required'), { status: 400 });
  if (operation === 'url') return callAgent('url', { ...common, id, br: cleanInt(body.br, 320, 64, 999) });
  if (operation === 'pic') return callAgent('pic', { ...common, id, size: cleanInt(body.size, 500, 64, 2000) });
  if (['song','playlist','lyric','album','artist'].includes(operation)) return callAgent(operation, { ...common, id });
  throw Object.assign(new Error('operation_not_found'), { status: 404 });
}

const server = http.createServer(async (req, res) => {
  const origin = validOrigin(req);
  if (req.method === 'GET' && req.url === '/health') return json(res, 200, { ok: true, version: VERSION, agent: '@eldment/meting-agent@1.6.11', platform: 'netease' }, origin);
  if (!origin) return json(res, 403, { ok: false, error: 'origin_not_allowed' });
  if (req.method === 'OPTIONS') { res.writeHead(204, { 'access-control-allow-origin': origin, 'access-control-allow-methods': 'GET,POST,OPTIONS', 'access-control-allow-headers': 'content-type,authorization', 'access-control-max-age': '600', vary: 'Origin' }); return res.end(); }
  if (!rateOk(req)) return json(res, 429, { ok: false, error: 'rate_limited' }, origin);
  try {
    if (req.method === 'POST' && req.url === '/api/session') {
      const body = await readJson(req); const cookie = sanitizeCookie(body.cookie);
      if (!cookie) return json(res, 400, { ok: false, error: 'cookie_required' }, origin);
      // A harmless account-bound request verifies that the encrypted session can call the provider.
      await callAgent('search', { platform: 'netease', cookie, keyword: '测试', page: 1, limit: 1 });
      return json(res, 200, { ok: true, token: seal(cookie), expiresIn: SESSION_HOURS * 3600 }, origin);
    }
    const match = req.method === 'POST' && req.url?.match(/^\/api\/(search|song|album|artist|playlist|url|lyric|pic)$/);
    if (match) {
      const session = sessionFrom(req); if (!session) return json(res, 401, { ok: false, error: 'session_invalid' }, origin);
      const body = await readJson(req); const data = await apiCall(match[1], body, session.cookie);
      return json(res, 200, { ok: true, data }, origin);
    }
    return json(res, 404, { ok: false, error: 'not_found' }, origin);
  } catch (error) {
    const status = Number(error.status) || 502;
    return json(res, status, { ok: false, error: error.message || 'upstream_failed' }, origin);
  }
});
server.listen(PORT, '0.0.0.0', () => console.log(`${VERSION} listening on 0.0.0.0:${PORT}`));
async function shutdown() { server.close(); try { await mcpClient?.close(); } catch {} process.exit(0); }
process.once('SIGINT', shutdown); process.once('SIGTERM', shutdown);
