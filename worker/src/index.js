// MikuFans CMS Worker — ES Module, 无 npm 依赖，只用 Web 标准 API + env.DB (D1)
// 路由按 hostname 分流：
//   our.mikufans.site     -> 根路径就是管理后台
//   forever.mikufans.site -> / 是公开 FOREVER 纪念页，/admin 是管理后台
//   其他 host（含 workers.dev）-> / 是路由说明页，/admin 是管理后台，/api 照常工作
// 自定义域名不要只做 CNAME，见 wrangler.toml 注释。

import adminHtml from './admin.html';
import foreverHtml from './forever.html';

const CATEGORIES = ['covers', 'essays', 'moods', 'blog'];
const CATEGORY_LABEL = { covers: '翻唱', essays: '随笔', moods: '心情', blog: '折腾日记' };
const SLUG_PREFIX = { covers: 'c', essays: 'e', moods: 'm', blog: 'a' };
const POST_COLUMNS = 'id, title, slug, category, content, excerpt, status, author, tags, created_at, updated_at, published_at';

// ---------- 小工具 ----------
function nowSql() {
  // 与 D1 默认 datetime('now') 同格式：YYYY-MM-DD HH:MM:SS (UTC)
  return new Date().toISOString().slice(0, 19).replace('T', ' ');
}
function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...extraHeaders },
  });
}
function err(code, status) { return json({ error: code }, status); }

function b64urlEncode(buf) {
  const bytes = buf instanceof Uint8Array ? buf : new TextEncoder().encode(buf);
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function b64urlDecode(str) {
  const s = str.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(s + '='.repeat((4 - (s.length % 4)) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}
function getCookie(request, name) {
  const h = request.headers.get('Cookie') || '';
  for (const part of h.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return null;
}
async function hmacSign(keyStr, dataStr) {
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(keyStr),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(dataStr));
  return b64urlEncode(new Uint8Array(sig));
}
function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

// ---------- 鉴权 ----------
// 通过任一即通过：
// (a) session cookie 签名验证通过且未过期；
// (b) 请求头 X-Miku-Key 与 env.MIKU_API_KEY 相等（未设置则此路不通）；
// (c) 请求头 Cf-Access-Jwt-Assertion 存在（表示 Cloudflare Access 已放行，
//     Worker 只认存在性，不自己验 JWT；后续可加 JWT 验签）。
async function isAuthed(request, env) {
  const apiKey = env.MIKU_API_KEY;
  if (apiKey && request.headers.get('X-Miku-Key')) {
    if (safeEqual(request.headers.get('X-Miku-Key'), apiKey)) return true;
  }
  if (request.headers.get('Cf-Access-Jwt-Assertion')) return true;

  const session = getCookie(request, 'session');
  const password = env.ADMIN_PASSWORD;
  if (session && password) {
    const [payload, sig] = session.split('.');
    if (payload && sig) {
      try {
        const expect = await hmacSign(password, payload);
        if (!safeEqual(sig, expect)) return false;
        const data = JSON.parse(new TextDecoder().decode(b64urlDecode(payload)));
        if (typeof data.exp === 'number' && data.exp > Date.now()) return true;
      } catch { return false; }
    }
  }
  return false;
}

// ---------- 操作日志（audit log）----------
// actor 按鉴权方式区分：API 密钥 / Cloudflare Access（只解码 JWT payload 取 email，不验签）/ 密码登录的 session。
function actorFromRequest(request, env) {
  const apiKey = env.MIKU_API_KEY;
  if (apiKey && request.headers.get('X-Miku-Key') && safeEqual(request.headers.get('X-Miku-Key'), apiKey)) {
    return 'API 密钥';
  }
  const assertion = request.headers.get('Cf-Access-Jwt-Assertion');
  if (assertion) {
    try {
      const parts = assertion.split('.');
      if (parts.length >= 2) {
        const payload = JSON.parse(new TextDecoder().decode(b64urlDecode(parts[1])));
        if (payload && typeof payload.email === 'string' && payload.email) return payload.email;
      }
    } catch { /* 解码失败则回落为通用名 */ }
    return 'Cloudflare Access';
  }
  return '后台管理员';
}
// best-effort 写日志：失败时吞掉，绝不能影响主操作。
async function writeAudit(env, request, action, postId, postTitle, detail) {
  try {
    await env.DB.prepare(
      'INSERT INTO audit_log (actor, action, post_id, post_title, detail, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    ).bind(actorFromRequest(request, env), action, postId ?? null, postTitle ?? null, detail ?? null, nowSql()).run();
  } catch { /* 日志失败不影响主操作 */ }
}
// 按栏目生成下一个短编号（c1/e1/m1/a1…）；extra 用于冲突重试时再 +1。
async function nextShortSlug(env, category, extra) {
  const prefix = SLUG_PREFIX[category];
  const re = new RegExp('^' + prefix + '(\\d+)$');
  let max = 0;
  const res = await env.DB.prepare('SELECT slug FROM posts WHERE category = ?').bind(category).all();
  for (const row of res.results || []) {
    const m = re.exec(row.slug || '');
    if (m) max = Math.max(max, parseInt(m[1], 10));
  }
  return prefix + (max + 1 + (extra || 0));
}

// ---------- 标签 ----------
// 清洗标签：字符串数组，最多 10 个，每项 trim 后去空，每项最多 20 字。
function parseTags(v) {
  if (!Array.isArray(v)) return [];
  const out = [];
  for (const t of v) {
    if (typeof t !== 'string') continue;
    const s = t.trim().slice(0, 20);
    if (s) out.push(s);
    if (out.length >= 10) break;
  }
  return out;
}
// 行里的 tags 是 JSON 字符串；解析成数组，null 或解析失败时给 []。
function withTags(row) {
  if (!row) return row;
  let tags = [];
  if (typeof row.tags === 'string' && row.tags) {
    try { const p = JSON.parse(row.tags); if (Array.isArray(p)) tags = p; } catch { /* 解析失败则 [] */ }
  } else if (Array.isArray(row.tags)) tags = row.tags;
  return { ...row, tags };
}

// ---------- CORS ----------
// 默认只允许同源，不设 *。例外：公开 GET /api/posts（已发布列表）允许主站跨域读，
// 因为主站 mikufans.site（Pages）与接口 our.mikufans.site 不同源；登录、/api/me、
// status=all/draft、/api/audit、POST/PUT/DELETE 一律仍只认同源。
const PUBLIC_CORS_ORIGINS = ['https://mikufans.site', 'https://www.mikufans.site'];
function corsHeaders(request, url) {
  const origin = request.headers.get('Origin');
  if (origin && origin === url.origin) {
    return {
      'Access-Control-Allow-Origin': origin,
      'Access-Control-Allow-Credentials': 'true',
      Vary: 'Origin',
    };
  }
  return {};
}
// 主站公开读接口用的跨域头：Origin 在白名单里才回，带 Vary: Origin，不带 Credentials。
function publicPostsCors(request) {
  const origin = request.headers.get('Origin');
  if (origin && PUBLIC_CORS_ORIGINS.includes(origin)) {
    return { 'Access-Control-Allow-Origin': origin, Vary: 'Origin' };
  }
  return {};
}

// ---------- API ----------
async function handleApi(request, env, url) {
  const cors = corsHeaders(request, url);
  const method = request.method;
  const path = url.pathname;

  if (method === 'OPTIONS') {
    // 公开读接口的预检：主站跨域也放行（只回 Allow-Origin，不带 Credentials）
    const pre = path === '/api/posts' ? publicPostsCors(request) : {};
    return new Response(null, {
      status: 204,
      headers: {
        ...cors,
        ...pre,
        'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, X-Miku-Key',
      },
    });
  }

  // GET /api/health
  if (path === '/api/health' && method === 'GET') {
    return json({ ok: true }, 200, cors);
  }

  // GET /api/me
  if (path === '/api/me' && method === 'GET') {
    return json({ authed: await isAuthed(request, env) }, 200, cors);
  }

  // POST /api/login
  if (path === '/api/login' && method === 'POST') {
    if (!env.ADMIN_PASSWORD) return json({ error: 'admin_password_not_set' }, 503, cors);
    let body = {};
    try { body = await request.json(); } catch { return err('bad_request', 400); }
    // 失败统一 401，不透露是密码错还是其他原因（未设置是 503，见上）
    if (typeof body.password !== 'string' || !safeEqual(body.password, env.ADMIN_PASSWORD)) {
      return err('unauthorized', 401);
    }
    const exp = Date.now() + 7 * 24 * 3600 * 1000; // 7 天
    const payload = b64urlEncode(JSON.stringify({ exp }));
    const sig = await hmacSign(env.ADMIN_PASSWORD, payload);
    // cookie 里只有签名过的 {exp}，不放密码，不用明文密码做 cookie 值
    const cookie = `session=${payload}.${sig}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=604800`;
    return json({ ok: true }, 200, { ...cors, 'Set-Cookie': cookie });
  }

  // POST /api/logout
  if (path === '/api/logout' && method === 'POST') {
    const cookie = 'session=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0';
    return json({ ok: true }, 200, { ...cors, 'Set-Cookie': cookie });
  }

  // GET /api/posts
  if (path === '/api/posts' && method === 'GET') {
    const authed = await isAuthed(request, env);
    const category = url.searchParams.get('category') || '';
    const statusParam = url.searchParams.get('status') || 'published';
    if (category && !CATEGORIES.includes(category)) return err('invalid_category', 400);
    if (!['published', 'draft', 'all'].includes(statusParam)) return err('invalid_status', 400);
    if ((statusParam === 'all' || statusParam === 'draft') && !authed) return err('unauthorized', 401);
    let limit = parseInt(url.searchParams.get('limit') || '50', 10);
    if (Number.isNaN(limit)) limit = 50;
    limit = Math.max(1, Math.min(100, limit));
    let offset = parseInt(url.searchParams.get('offset') || '0', 10);
    if (Number.isNaN(offset) || offset < 0) offset = 0;

    const conds = [];
    const params = [];
    if (statusParam !== 'all') { conds.push('status = ?'); params.push(statusParam); }
    if (category) { conds.push('category = ?'); params.push(category); }
    const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
    try {
      const res = await env.DB.prepare(
        `SELECT ${POST_COLUMNS} FROM posts ${where} ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`,
      ).bind(...params, limit, offset).all();
      // 公开列表（已发布）允许主站跨域读；草稿/全部仍只认同源
      const pc = statusParam === 'published' ? publicPostsCors(request) : {};
      return json({ posts: (res.results || []).map(withTags), limit, offset }, 200, { ...cors, ...pc });
    } catch { return err('internal', 500); }
  }

  // GET /api/audit（仅已鉴权）
  if (path === '/api/audit' && method === 'GET') {
    if (!(await isAuthed(request, env))) return err('unauthorized', 401);
    let limit = parseInt(url.searchParams.get('limit') || '30', 10);
    if (Number.isNaN(limit)) limit = 30;
    limit = Math.max(1, Math.min(100, limit));
    try {
      const res = await env.DB.prepare(
        'SELECT id, actor, action, post_id, post_title, detail, created_at FROM audit_log ORDER BY created_at DESC, id DESC LIMIT ?',
      ).bind(limit).all();
      return json({ entries: res.results || [] }, 200, cors);
    } catch { return err('internal', 500); }
  }

  // GET /api/posts/:slug
  const slugMatch = path.match(/^\/api\/posts\/([^/]+)$/);
  if (slugMatch && method === 'GET') {
    const slug = decodeURIComponent(slugMatch[1]);
    try {
      const row = await env.DB.prepare(
        `SELECT ${POST_COLUMNS} FROM posts WHERE slug = ?`,
      ).bind(slug).first();
      if (!row) return err('not_found', 404);
      // 草稿只对已鉴权者可见；未鉴权时按 404 处理，不透露存在性
      if (row.status !== 'published' && !(await isAuthed(request, env))) return err('not_found', 404);
      return json(withTags(row), 200, cors);
    } catch { return err('internal', 500); }
  }

  // POST /api/posts
  if (path === '/api/posts' && method === 'POST') {
    if (!(await isAuthed(request, env))) return err('unauthorized', 401);
    let body = {};
    try { body = await request.json(); } catch { return err('bad_request', 400); }
    const title = typeof body.title === 'string' ? body.title.trim() : '';
    if (!title) return err('title_required', 400);
    const category = body.category;
    if (!CATEGORIES.includes(category)) return err('invalid_category', 400);
    const content = typeof body.content === 'string' ? body.content : '';
    let excerpt = typeof body.excerpt === 'string' ? body.excerpt.trim() : '';
    if (!excerpt) excerpt = content.slice(0, 120);
    let slug = typeof body.slug === 'string' ? body.slug.trim() : '';
    if (slug && !/^[A-Za-z0-9_-]+$/.test(slug)) return err('invalid_slug', 400);
    // slug 为空时按栏目自动生成下一个短编号（c1/e1/m1/a1…），与现有编号体系一致；
    // 显式传的 slug 冲突时仍返回 409。
    const slugAuto = !slug;
    const status = body.status === 'published' ? 'published' : 'draft';
    const author = typeof body.author === 'string' && body.author.trim() ? body.author.trim() : 'Miku';
    const tags = parseTags(body.tags);
    const now = nowSql();
    const publishedAt = status === 'published' ? now : null;
    async function tryInsert(slugValue) {
      const r = await env.DB.prepare(
        'INSERT INTO posts (title, slug, category, content, excerpt, status, author, tags, created_at, updated_at, published_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      ).bind(title, slugValue, category, content, excerpt, status, author, JSON.stringify(tags), now, now, publishedAt).run();
      if (!r.success) return null;
      return env.DB.prepare(
        `SELECT ${POST_COLUMNS} FROM posts WHERE id = ?`,
      ).bind(r.meta.last_row_id).first();
    }
    function isUniqueErr(e) {
      const s = String(e && e.message || e);
      return s.includes('UNIQUE') || s.includes('slug');
    }
    let row = null;
    if (!slugAuto) {
      try { row = await tryInsert(slug); }
      catch (e) {
        if (isUniqueErr(e)) return err('slug_conflict', 409);
        return err('internal', 500);
      }
    } else {
      // 短编号冲突（并发）时数字 +1 再试，最多 5 次；都冲突则回退到旧的 post-<时间戳>-<随机数> 方式
      for (let attempt = 0; attempt < 5 && !row; attempt++) {
        let candidate = null;
        try { candidate = await nextShortSlug(env, category, attempt); } catch { candidate = null; }
        if (!candidate) break;
        try { row = await tryInsert(candidate); if (row) slug = candidate; }
        catch (e) {
          if (!isUniqueErr(e)) return err('internal', 500);
        }
      }
      if (!row) {
        slug = `post-${Date.now()}-${Math.floor(1000 + Math.random() * 9000)}`;
        try { row = await tryInsert(slug); }
        catch (e) {
          if (isUniqueErr(e)) return err('slug_conflict', 409);
          return err('internal', 500);
        }
      }
    }
    if (!row) return err('internal', 500);
    await writeAudit(env, request, '新建', row.id, row.title, CATEGORY_LABEL[category]);
    return json(withTags(row), 201, cors);
  }

  // PUT /api/posts/:id  与  DELETE /api/posts/:id
  const idMatch = path.match(/^\/api\/posts\/(\d+)$/);
  if (idMatch && (method === 'PUT' || method === 'DELETE')) {
    if (!(await isAuthed(request, env))) return err('unauthorized', 401);
    const id = Number(idMatch[1]);
    try {
      const existing = await env.DB.prepare(
        `SELECT ${POST_COLUMNS} FROM posts WHERE id = ?`,
      ).bind(id).first();
      if (!existing) return err('not_found', 404);

      if (method === 'DELETE') {
        await env.DB.prepare('DELETE FROM posts WHERE id = ?').bind(id).run();
        await writeAudit(env, request, '删除', existing.id, existing.title, CATEGORY_LABEL[existing.category] || existing.category);
        return json({ ok: true }, 200, cors);
      }

      // PUT
      let body = {};
      try { body = await request.json(); } catch { return err('bad_request', 400); }
      const sets = [];
      const params = [];
      const allow = ['title', 'slug', 'category', 'content', 'excerpt', 'status', 'author', 'tags'];
      const newTagsJson = body.tags !== undefined ? JSON.stringify(parseTags(body.tags)) : null;
      for (const k of allow) {
        if (body[k] === undefined) continue;
        if (k === 'title') {
          const v = typeof body.title === 'string' ? body.title.trim() : '';
          if (!v) return err('title_required', 400);
          sets.push('title = ?'); params.push(v);
        } else if (k === 'slug') {
          const v = typeof body.slug === 'string' ? body.slug.trim() : '';
          if (!v || !/^[A-Za-z0-9_-]+$/.test(v)) return err('invalid_slug', 400);
          sets.push('slug = ?'); params.push(v);
        } else if (k === 'category') {
          if (!CATEGORIES.includes(body.category)) return err('invalid_category', 400);
          sets.push('category = ?'); params.push(body.category);
        } else if (k === 'status') {
          if (!['draft', 'published'].includes(body.status)) return err('invalid_status', 400);
          sets.push('status = ?'); params.push(body.status);
        } else if (k === 'tags') {
          sets.push('tags = ?'); params.push(newTagsJson);
        } else {
          sets.push(`${k} = ?`); params.push(typeof body[k] === 'string' ? body[k] : '');
        }
      }
      if (!sets.length) return err('bad_request', 400);
      const now = nowSql();
      sets.push('updated_at = ?'); params.push(now);
      // 状态变 published 时若 published_at 为空则补 now；变 draft 时 published_at=null
      const newStatus = body.status !== undefined ? body.status : existing.status;
      if (newStatus === 'published' && !existing.published_at) {
        sets.push('published_at = ?'); params.push(now);
      } else if (newStatus === 'draft') {
        sets.push('published_at = NULL');
      }
      try {
        await env.DB.prepare(`UPDATE posts SET ${sets.join(', ')} WHERE id = ?`).bind(...params, id).run();
      } catch (e) {
        if (String(e && e.message || e).includes('UNIQUE')) return err('slug_conflict', 409);
        return err('internal', 500);
      }
      const row = await env.DB.prepare(`SELECT ${POST_COLUMNS} FROM posts WHERE id = ?`).bind(id).first();
      // 操作日志（best-effort）：按变化定 action
      const statusChanged = body.status !== undefined && body.status !== existing.status;
      let action = '编辑';
      let detail = '';
      if (statusChanged && newStatus === 'published') { action = '发布'; detail = '草稿 → 已发布'; }
      else if (statusChanged && newStatus === 'draft') { action = '取消发布'; detail = '已发布 → 草稿'; }
      else {
        const changedNames = [];
        if (body.title !== undefined && body.title.trim() !== existing.title) changedNames.push('标题');
        if (body.category !== undefined && body.category !== existing.category) changedNames.push('栏目');
        if (body.content !== undefined && body.content !== existing.content) changedNames.push('正文');
        if (body.excerpt !== undefined && body.excerpt.trim() !== (existing.excerpt || '')) changedNames.push('摘要');
        if (body.author !== undefined && body.author !== existing.author) changedNames.push('作者');
        if (newTagsJson !== null && newTagsJson !== JSON.stringify(withTags(existing).tags)) changedNames.push('标签');
        detail = changedNames.length ? changedNames.join('、') + '已更新' : '无字段变化';
      }
      await writeAudit(env, request, action, row.id, row.title, detail);
      return json(withTags(row), 200, cors);
    } catch (e) {
      if (e && e.message === 'slug_conflict') return err('slug_conflict', 409);
      return err('internal', 500);
    }
  }

  return err('not_found', 404);
}

// ---------- 页面 ----------
function htmlResponse(html) {
  return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
}

function routeInfoPage(host) {
  return `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>MikuFans CMS</title>
<style>body{margin:0;background:#f7f3e9;color:#1c2b2a;font-family:Georgia,'Songti SC',serif;line-height:1.8;padding:40px 20px}main{max-width:640px;margin:0 auto}h1{font-size:24px}a{color:#0e7a72}code{background:#e9e4d6;padding:1px 5px}</style></head><body><main>
<h1>MikuFans CMS</h1>
<p>当前 host：<code>${host}</code></p>
<p>这是 MikuFans 的后端 Worker，不是主站。主站 mikufans.site 是 Cloudflare Pages，文章列表与正文读本 Worker 的 <code>/api/posts</code> 接口。</p>
<ul>
<li><a href="/admin">管理后台 /admin</a> —— 登录后写文章（翻唱 / 随笔 / 心情 / 折腾日记）</li>
<li><code>GET /api/health</code> —— 健康检查</li>
<li><code>GET /api/posts</code> —— 公开文章列表（只返回已发布）</li>
</ul>
<p>our.mikufans.site 的根路径就是后台；forever.mikufans.site 的根路径是公开 FOREVER 纪念页，<code>/admin</code> 是后台。</p>
<p><a href="https://mikufans.site">← 回到 MikuFans 主站</a></p>
</main></body></html>`;
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const host = url.hostname;

    if (url.pathname.startsWith('/api/')) return handleApi(request, env, url);

    if (url.pathname === '/admin' || url.pathname === '/admin/') return htmlResponse(adminHtml);

    if (host === 'our.mikufans.site') return htmlResponse(adminHtml);
    if (host === 'forever.mikufans.site') {
      if (url.pathname === '/' || url.pathname === '') return htmlResponse(foreverHtml);
      return new Response('Not Found', { status: 404 });
    }
    // 其他 host（含 workers.dev）
    if (url.pathname === '/' || url.pathname === '') return htmlResponse(routeInfoPage(host));
    return new Response('Not Found', { status: 404 });
  },
};
