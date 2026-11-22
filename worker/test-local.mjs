// 本地自测：mock D1（内存数组），不碰线上 Cloudflare / GitHub。
// 用法：cd worker && node test-local.mjs
// 说明：src/index.js 用 Cloudflare 的 Text 规则 import .html，Node 直接 import 会
// 认不出 .html，所以这里读 index.js 源码，把两行 html import 换成文件内容字面量，
// 写到临时文件再 import；除这两行 import 外，跑的是 index.js 本身的逻辑。
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const dir = dirname(fileURLToPath(import.meta.url));
const srcDir = join(dir, 'src');

// ---- mock D1 ----
function makeMockDB() {
  const posts = [];
  let nextId = 1;
  return {
    _posts: posts,
    prepare(sql) {
      const stmt = {
        _sql: sql,
        _params: [],
        bind(...p) { this._params = p; return this; },
        async run() {
          if (/INSERT INTO posts/i.test(sql)) {
            const [title, slug, category, content, excerpt, status, author, created_at, updated_at, published_at] = this._params;
            if (posts.some((p) => p.slug === slug)) throw new Error('UNIQUE constraint failed: posts.slug');
            const row = { id: nextId++, title, slug, category, content, excerpt, status, author, created_at, updated_at, published_at };
            posts.push(row);
            return { success: true, meta: { last_row_id: row.id } };
          }
          if (/UPDATE posts SET/i.test(sql)) {
            const setPart = sql.slice(sql.indexOf('SET ') + 4, sql.indexOf(' WHERE id'));
            const cols = setPart.split(',').map((s) => s.trim());
            let pi = 0;
            const id = this._params[this._params.length - 1];
            const row = posts.find((p) => p.id === id);
            if (!row) return { success: true, meta: {} };
            for (const c of cols) {
              if (/= NULL$/i.test(c)) {
                const col = c.split('=')[0].trim();
                row[col] = null;
              } else {
                const col = c.split('=')[0].trim();
                row[col] = this._params[pi++];
              }
            }
            return { success: true, meta: {} };
          }
          if (/DELETE FROM posts/i.test(sql)) {
            const id = this._params[0];
            const i = posts.findIndex((p) => p.id === id);
            if (i >= 0) posts.splice(i, 1);
            return { success: true, meta: {} };
          }
          return { success: true, meta: {} };
        },
        async all() {
          if (/ORDER BY created_at DESC/i.test(sql)) {
            let out = [...posts];
            let pi = 0;
            if (/status = \?/.test(sql)) { const v = this._params[pi++]; out = out.filter((p) => p.status === v); }
            if (/category = \?/.test(sql)) { const v = this._params[pi++]; out = out.filter((p) => p.category === v); }
            const limit = this._params[pi++]; const offset = this._params[pi++];
            out.sort((a, b) => (b.created_at < a.created_at ? -1 : b.created_at > a.created_at ? 1 : b.id - a.id));
            return { results: out.slice(offset, offset + limit) };
          }
          return { results: [] };
        },
        async first() {
          if (/WHERE slug = \?/.test(sql)) return posts.find((p) => p.slug === this._params[0]) || null;
          if (/WHERE id = \?/.test(sql)) return posts.find((p) => p.id === this._params[0]) || null;
          return null;
        },
      };
      return stmt;
    },
  };
}

// ---- 加载 worker（替换 html import）----
const adminHtml = readFileSync(join(srcDir, 'admin.html'), 'utf8');
const foreverHtml = readFileSync(join(srcDir, 'forever.html'), 'utf8');
let src = readFileSync(join(srcDir, 'index.js'), 'utf8');
src = src.replace(/import adminHtml from '\.\/admin\.html';/, `const adminHtml = ${JSON.stringify(adminHtml)};`);
src = src.replace(/import foreverHtml from '\.\/forever\.html';/, `const foreverHtml = ${JSON.stringify(foreverHtml)};`);
const tmpPath = join(dir, '.test-index.tmp.mjs');
writeFileSync(tmpPath, src);
const worker = (await import(tmpPath)).default;

// ---- 测试小框架 ----
let pass = 0, fail = 0;
const failures = [];
async function t(name, fn) {
  try { await fn(); pass++; console.log(`PASS ${name}`); }
  catch (e) { fail++; failures.push(name); console.log(`FAIL ${name}: ${e.message}`); }
}
function assert(cond, msg) { if (!cond) throw new Error(msg || 'assert failed'); }
function assertEq(a, b, msg) { if (a !== b) throw new Error(`${msg || ''} expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`); }

async function call(env, path, opts = {}) {
  const req = new Request(`https://our.mikufans.site${path}`, opts);
  return worker.fetch(req, env, {});
}
async function callJson(env, path, opts = {}) {
  const r = await call(env, path, opts);
  let d = null; try { d = await r.json(); } catch {}
  return { status: r.status, headers: r.headers, body: d, text: d ? null : null };
}
function cookieFrom(res) {
  const c = res.headers.get('Set-Cookie') || '';
  return c.split(';')[0]; // session=...
}

const env = { DB: makeMockDB(), ADMIN_PASSWORD: 'test-password-123', MIKU_API_KEY: 'test-key-abc' };
let sessionCookie = '';
let draftId, draftSlug, pubId, pubSlug;

// 1 健康检查
await t('health', async () => {
  const r = await callJson(env, '/api/health');
  assertEq(r.status, 200); assertEq(r.body.ok, true);
});
// 2 未登录写操作 401
await t('unauth POST 401', async () => {
  const r = await callJson(env, '/api/posts', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: 'x', category: 'essays' }) });
  assertEq(r.status, 401);
});
// 3 登录错误密码 401
await t('login wrong password 401', async () => {
  const r = await callJson(env, '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: 'wrong' }) });
  assertEq(r.status, 401);
});
// 4 登录正确密码 200 + HttpOnly cookie，且 cookie 不是明文密码
await t('login correct 200 + session cookie', async () => {
  const r = await callJson(env, '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: 'test-password-123' }) });
  assertEq(r.status, 200);
  sessionCookie = cookieFrom(r);
  assert(sessionCookie.startsWith('session='), 'no session cookie');
  assert(!sessionCookie.includes('test-password-123'), 'cookie contains password');
  assert((r.headers.get('Set-Cookie') || '').includes('HttpOnly'), 'cookie not HttpOnly');
});
// 5 /api/me 未登录 false / 已登录 true
await t('me unauth false / authed true', async () => {
  const a = await callJson(env, '/api/me');
  assertEq(a.body.authed, false);
  const b = await callJson(env, '/api/me', { headers: { Cookie: sessionCookie } });
  assertEq(b.body.authed, true);
});
// 6 创建草稿：excerpt 自动取正文前 120 字，slug 自动生成
await t('create draft auto excerpt+slug', async () => {
  const content = 'a'.repeat(200);
  const r = await callJson(env, '/api/posts', { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: sessionCookie }, body: JSON.stringify({ title: '草稿一篇', category: 'essays', content }) });
  assertEq(r.status, 201, 'create status');
  assertEq(r.body.status, 'draft');
  assertEq(r.body.excerpt.length, 120);
  assert(r.body.slug && r.body.slug.startsWith('post-'), 'slug not auto');
  assertEq(r.body.published_at, null);
  draftId = r.body.id; draftSlug = r.body.slug;
});
// 7 公开列表看不到草稿
await t('public list hides draft', async () => {
  const r = await callJson(env, '/api/posts');
  assertEq(r.status, 200);
  assertEq(r.body.posts.length, 0);
});
// 8 未登录读草稿单篇 404
await t('unauth get draft 404', async () => {
  const r = await callJson(env, `/api/posts/${draftSlug}`);
  assertEq(r.status, 404);
});
// 9 创建已发布文章
await t('create published', async () => {
  const r = await callJson(env, '/api/posts', { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: sessionCookie }, body: JSON.stringify({ title: '已发布', category: 'moods', content: '你好', status: 'published' }) });
  assertEq(r.status, 201);
  assertEq(r.body.status, 'published');
  assert(r.body.published_at, 'published_at should be set');
  pubId = r.body.id; pubSlug = r.body.slug;
});
// 10 公开列表能看到已发布
await t('public list sees published', async () => {
  const r = await callJson(env, '/api/posts');
  assertEq(r.body.posts.length, 1);
  assertEq(r.body.posts[0].slug, pubSlug);
});
// 11 未登录读已发布单篇 200
await t('unauth get published 200', async () => {
  const r = await callJson(env, `/api/posts/${pubSlug}`);
  assertEq(r.status, 200); assertEq(r.body.title, '已发布');
});
// 12 PUT 把草稿改成已发布，published_at 补上
await t('PUT draft -> published fills published_at', async () => {
  const r = await callJson(env, `/api/posts/${draftId}`, { method: 'PUT', headers: { 'Content-Type': 'application/json', Cookie: sessionCookie }, body: JSON.stringify({ title: '草稿改名', status: 'published' }) });
  assertEq(r.status, 200);
  assertEq(r.body.title, '草稿改名');
  assert(r.body.published_at, 'published_at not filled');
  assert(r.body.updated_at, 'updated_at not set');
});
// 13 slug 冲突 409
await t('slug conflict 409', async () => {
  const r = await callJson(env, '/api/posts', { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: sessionCookie }, body: JSON.stringify({ title: '重复', category: 'essays', slug: pubSlug }) });
  assertEq(r.status, 409);
});
// 14 category 非法 400
await t('invalid category 400', async () => {
  const r = await callJson(env, '/api/posts', { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: sessionCookie }, body: JSON.stringify({ title: '坏栏目', category: 'nope' }) });
  assertEq(r.status, 400);
});
// 15 标题必填 400
await t('missing title 400', async () => {
  const r = await callJson(env, '/api/posts', { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: sessionCookie }, body: JSON.stringify({ title: '  ', category: 'essays' }) });
  assertEq(r.status, 400);
});
// 16 X-Miku-Key 鉴权可用
await t('X-Miku-Key auth', async () => {
  const r = await callJson(env, '/api/posts?status=all', { headers: { 'X-Miku-Key': 'test-key-abc' } });
  assertEq(r.status, 200);
  assert(r.body.posts.length >= 2, 'should see drafts with api key');
});
// 17 limit 钳制 1..100
await t('limit clamped to 100', async () => {
  const r = await callJson(env, '/api/posts?limit=999');
  assertEq(r.body.limit, 100);
});
// 18 DELETE 删行，之后再读 404
await t('DELETE then 404', async () => {
  const r = await callJson(env, `/api/posts/${pubId}`, { method: 'DELETE', headers: { Cookie: sessionCookie } });
  assertEq(r.status, 200); assertEq(r.body.ok, true);
  const g = await callJson(env, `/api/posts/${pubSlug}`);
  assertEq(g.status, 404);
});
// 19 未设置 ADMIN_PASSWORD 时登录 503，且写操作仍 401
await t('no ADMIN_PASSWORD -> login 503, write 401', async () => {
  const env2 = { DB: makeMockDB() };
  const r = await callJson(env2, '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: 'x' }) });
  assertEq(r.status, 503); assertEq(r.body.error, 'admin_password_not_set');
  const w = await callJson(env2, '/api/posts', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: 'x', category: 'essays' }) });
  assertEq(w.status, 401);
});
// 20 logout 清 cookie
await t('logout clears cookie', async () => {
  const r = await callJson(env, '/api/logout', { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: sessionCookie }, body: '{}' });
  assertEq(r.status, 200);
  assert((r.headers.get('Set-Cookie') || '').includes('Max-Age=0'), 'logout did not clear');
});

console.log(`\n${pass} passed, ${fail} failed`);
if (failures.length) console.log('Failed:', failures.join(', '));
process.exit(fail ? 1 : 0);
