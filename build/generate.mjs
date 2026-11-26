// MikuFans SSG 生成器（方案一：Webhook 自动构建用）
// 用途：Cloudflare Pages 构建时运行，从公开接口拉已发布文章，
//       为每篇生成 /post/<slug>/index.html（正文直接印进 HTML 源码）、
//       为每个栏目生成 /<栏目>/index.html，并重生 sitemap.xml。后台写文章的流程不变。
// 用法：node generate.mjs [--template index.html] [--out <输出目录>] [--api https://our.mikufans.site]
// 说明：输出目录就是站点根：模板本身会原样复制为 index.html（首页仍走 SPA），
//       文章页是模板的克隆：换标题/描述/canonical、填好面包屑、
//       把文章正文预渲染进 #rcontent。页面 JS 加载后会照常接管渲染，
//       静态正文只负责让爬虫和无 JS 的访客直接读到全文，两边内容同源同渲染。
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const args = process.argv.slice(2);
function opt(name, dflt) {
  const i = args.indexOf('--' + name);
  return i >= 0 && args[i + 1] ? args[i + 1] : dflt;
}
const TEMPLATE = opt('template', 'index.html');
const OUT = opt('out', '.');
const API = opt('api', 'https://our.mikufans.site');
const SITE = 'https://mikufans.site';

const COLUMNS = {
  covers: { label: '歌', author: '大小姐', desc: '大小姐唱过的歌，和喜欢的老歌介绍，一首一首慢慢讲。' },
  essays: { label: '随笔', author: '大小姐', desc: '散文和小作文，慢慢写、慢慢看。' },
  moods: { label: '心情', author: '大小姐', desc: '短短的心情，一天一条，攒起来就是日子。' },
  blog: { label: '折腾日记', author: 'P主', desc: 'P主的折腾日记：电脑、网络、调音、装机，折腾过的都记在这儿。' },
};

const template = readFileSync(TEMPLATE, 'utf8');

// —— 复用前台自己的渲染函数：从模板里原样抽 esc / inline / renderMD，
//    保证静态页的排版和访客点开后 JS 重渲染的结果一字不差，不另写第二份实现。
const start = template.indexOf('function esc(s)');
// 终点取数据常量定义处：渲染函数段到此为止只有注释，不含可执行代码。
const endMarker = 'var API_POSTS_URL=';
const end = template.indexOf(endMarker);
if (start < 0 || end < 0 || end <= start) {
  throw new Error('在模板里找不到 Markdown 渲染函数段，已中止（模板结构变了，先人工核对）');
}
const renderSrc = template.slice(start, end);
const { esc, renderMD } = new Function(
  renderSrc + '\nreturn { esc, renderMD };'
)();

const res = await fetch(`${API}/api/posts?limit=100`);
if (!res.ok) throw new Error(`拉文章失败：HTTP ${res.status}`);
const data = await res.json();
const posts = (data.posts || []).filter((p) => p && p.slug && p.title);
if (!posts.length) throw new Error('接口返回 0 篇文章，已中止，避免生成空站');

// 数据文件固定地址即可：Pages 按部署供数、zone 层缓存已撤，
// 旧的内容版本戳（按 hash 换数据地址）已于 2026-11-25 深夜拆除。
const tpl = template;
console.log(`已发布文章 ${posts.length} 篇，开始生成…`);

// —— 最近更新：按发布日倒序取最新 5 篇（与前台 renderOtherColumns 同口径，
//    并列日期保持接口顺序，与 JS 的稳定排序一致）。预渲染成真链接 <a>，
//    JS 加载后会清空并用同内容重建为按钮，视觉不变；无 JS 时链接直接可点、
//    爬虫能顺着进文章页。样式靠下面这段补充 CSS 与 .latest button 对齐。
const postDate = (p) => String(p.published_at || p.created_at || '').substring(0, 10);
const latest5 = posts.slice().sort((x, y) => postDate(y).localeCompare(postDate(x))).slice(0, 5);
const latestHtml = latest5.map((p) => {
  const col = COLUMNS[p.category] || { label: p.category || '' };
  return `<a href="/post/${p.slug}/"><span class="k">${esc(col.label)}</span><span class="t">${esc(p.title)}</span><span class="dt">${postDate(p).replace(/-/g, '/')}</span></a>`;
}).join('');
const LATEST_CSS = '<style>.latest a{display:flex;gap:12px;align-items:baseline;background:var(--surface);border:1px solid var(--line);border-radius:12px;padding:13px 16px;text-align:left;color:var(--ink);width:100%;box-shadow:var(--shadow);text-decoration:none;box-sizing:border-box}.latest a:hover{border-color:var(--teal)}@media (max-width:560px){.latest .dt{display:none}.latest a{flex-wrap:wrap}}</style>';
function injectLatest(html) {
  return html
    .replace('</head>', LATEST_CSS + '\n</head>')
    .replace('<div class="latest" id="latestList"></div>',
      `<div class="latest" id="latestList">${latestHtml}</div>`);
}

mkdirSync(OUT, { recursive: true });
writeFileSync(join(OUT, 'index.html'), injectLatest(tpl));

let fail = 0;
for (const p of posts) {
  const col = COLUMNS[p.category] || { label: p.category || '', author: p.author || 'Miku' };
  const date = String(p.published_at || p.created_at || '').substring(0, 10);
  const updated = String(p.updated_at || p.published_at || p.created_at || '').substring(0, 10);
  const tags = Array.isArray(p.tags) ? p.tags : [];
  const mins = Math.max(1, Math.ceil(String(p.content || '').length / 400));
  const desc = String(p.excerpt || '').replace(/\s+/g, ' ').trim().slice(0, 150);
  const canonical = `${SITE}/post/${p.slug}/`;
  const bodyHtml =
    `<h2 class="rtitle">${esc(p.title)}</h2>` +
    `<div class="rmeta"><span>${date.replace(/-/g, '/')}</span><span>作者：${esc(col.author)}</span>` +
    tags.map((t) => `<span class="tag">${esc(t)}</span>`).join('') +
    `<span>约 ${mins} 分钟</span></div>` +
    `<div class="md fs2">${renderMD(String(p.content || ''))}</div>`;
  const jsonLd = {
    '@context': 'https://schema.org', '@type': 'Article',
    headline: p.title, description: desc, datePublished: date,
    dateModified: updated, author: { '@type': 'Person', name: p.author || 'Miku' },
    mainEntityOfPage: canonical,
  };

  let html = injectLatest(tpl);
  html = html.replace(/<title>[\s\S]*?<\/title>/, `<title>${esc(p.title)} · ${esc(col.label)} · MikuFans</title>`);
  html = html.replace(
    /<meta name="description" content="[^"]*" \/>/,
    `<meta name="description" content="${esc(desc)}" />\n` +
    `<link rel="canonical" href="${canonical}" />\n` +
    `<meta property="og:type" content="article" />\n` +
    `<meta property="og:title" content="${esc(p.title)} · MikuFans" />\n` +
    `<meta property="og:description" content="${esc(desc)}" />\n` +
    `<meta property="og:url" content="${canonical}" />\n` +
    `<script type="application/ld+json">${JSON.stringify(jsonLd).replace(/</g, '\\u003c')}</script>`
  );
  // 文章页初始状态：列表藏起来、文章区直接展开（JS 接管后会按路由重排，不冲突）
  html = html.replace('<div id="listView">', '<div id="listView" hidden>');
  html = html.replace('<main id="articleView" hidden>', '<main id="articleView">');
  html = html.replace('<span class="cur" id="crumbTitle">文章</span>',
    `<span class="cur" id="crumbTitle">${esc(p.title)}</span>`);
  html = html.replace('<a href="#list" id="crumbColumn">折腾日记</a>',
    `<a href="#list" id="crumbColumn">${esc(col.label)}</a>`);
  html = html.replace('<span id="backLabel">返回折腾日记</span>',
    `<span id="backLabel">返回${esc(col.label)}</span>`);
  html = html.replace('<div id="rcontent"></div>', `<div id="rcontent">${bodyHtml}</div>`);
  // 折腾日记是 P主的文章，不挂大小姐小卡片：静态页先藏好，JS 接管后由 renderSidebar 按栏目维持。
  if (p.category === 'blog') {
    if (!html.includes('<section class="sidecard" id="profileCard"')) throw new Error('模板里找不到小卡片锚点，已中止');
    html = html.replace('<section class="sidecard" id="profileCard"',
      '<section class="sidecard" id="profileCard" style="display:none"');
  }

  // 自检：标题换上了、正文真的进了源码，否则宁可报错也不交残页。
  // 探针与页面纯文本都先抹掉 markdown 记号、反斜杠和空白再比，避免引用/加粗等写法误报。
  const norm = (s) => s.replace(/<[^>]+>/g, '').replace(/[\s\\*_`>#|~[\]()!-]/g, '');
  const probe = String(p.content || '').split('\n').map((s) => s.trim())
    .find((s) => norm(s).length >= 10 && !s.startsWith('```'));
  if (!html.includes(`<title>${esc(p.title)}`) || (probe && !norm(html).includes(norm(probe).slice(0, 14)))) {
    console.error(`✗ ${p.slug} 自检没过，跳过`); fail++; continue;
  }
  const dir = join(OUT, 'post', p.slug);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'index.html'), html);
  console.log(`✓ /post/${p.slug}/ 《${p.title}》 ${(html.length / 1024).toFixed(0)}KB`);
}
if (fail) throw new Error(`${fail} 篇自检失败，已中止整次生成`);

// —— 栏目页：每个栏目一页 /<栏目>/，与文章页同法克隆模板：
//    换标题/描述/canonical、把该栏目面板预设为可见（JS 接管后按路由重排，不冲突）。
//    栏目从此有自己的干净地址，不再靠首页的 ?view= 参数区分。
for (const [key, col] of Object.entries(COLUMNS)) {
  const canonical = `${SITE}/${key}/`;
  let html = injectLatest(tpl);
  html = html.replace(/<title>[\s\S]*?<\/title>/, `<title>${esc(col.label)} · MikuFans</title>`);
  html = html.replace(
    /<meta name="description" content="[^"]*" \/>/,
    `<meta name="description" content="${esc(col.desc)}" />\n` +
    `<link rel="canonical" href="${canonical}" />\n` +
    `<meta property="og:type" content="website" />\n` +
    `<meta property="og:title" content="${esc(col.label)} · MikuFans" />\n` +
    `<meta property="og:description" content="${esc(col.desc)}" />\n` +
    `<meta property="og:url" content="${canonical}" />`
  );
  html = html.replace('<section data-panel="home">', '<section data-panel="home" hidden>');
  html = html.replace(`<section data-panel="${key}" hidden>`, `<section data-panel="${key}">`);
  if (!html.includes(`<title>${esc(col.label)} · MikuFans</title>`) || !html.includes(`href="${canonical}"`) || html.includes(`<section data-panel="${key}" hidden>`)) {
    throw new Error(`栏目页 ${key} 自检失败，已中止整次生成`);
  }
  const dir = join(OUT, key);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'index.html'), html);
  console.log(`✓ /${key}/ 《${col.label}》 ${(html.length / 1024).toFixed(0)}KB`);
}

// —— 静态数据：前台改读同源静态 JSON，访客不再请求后端接口。
// posts-summary.json 是轻量索引（去正文、带 content_length），列表渲染全靠它；
// posts.json 是全量（含正文），只作空闲预热填正文缓存用，列表不读它；
// post-<slug>.json 是单篇（含正文），预热漏网时点开文章按需取。
const dataDir = join(OUT, 'data');
mkdirSync(dataDir, { recursive: true });
const summaryPosts = posts.map((p) => {
  const { content, ...rest } = p;
  return { ...rest, content_length: String(content || '').length };
});
// 无戳版照旧写：给还攥着旧页面的访客兜底；新页面一律按戳取数。
writeFileSync(join(dataDir, 'posts-summary.json'), JSON.stringify({ posts: summaryPosts }));
writeFileSync(join(dataDir, 'posts.json'), JSON.stringify({ posts }));
for (const p of posts) {
  writeFileSync(join(dataDir, `post-${p.slug}.json`), JSON.stringify(p));
}
console.log(`✓ 静态数据已生成：data/posts-summary.json、data/posts.json（预热）、单篇 × ${posts.length}`);

// —— sitemap：首页 + 四个栏目页 + 每篇 canonical 地址，lastmod 用文章更新日
const colUrls = Object.keys(COLUMNS).map((key) => {
  const lm = posts.filter((p) => p.category === key)
    .map((p) => String(p.updated_at || p.published_at || '').substring(0, 10))
    .sort().pop() || '';
  return `  <url><loc>${SITE}/${key}/</loc>${lm ? `<lastmod>${lm}</lastmod>` : ''}<priority>0.6</priority></url>`;
});
const urls = [`  <url><loc>${SITE}/</loc><priority>1.0</priority></url>`]
  .concat(colUrls)
  .concat(posts.map((p) => {
    const lm = String(p.updated_at || p.published_at || '').substring(0, 10);
    return `  <url><loc>${SITE}/post/${p.slug}/</loc>${lm ? `<lastmod>${lm}</lastmod>` : ''}<priority>0.8</priority></url>`;
  })).join('\n');
writeFileSync(join(OUT, 'sitemap.xml'),
  `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`);
console.log(`✓ sitemap.xml 重生：${posts.length + 1 + colUrls.length} 条 URL`);

// 首页自检：最近更新 5 篇的链接必须都在首页源码里
const homeHtml = readFileSync(join(OUT, 'index.html'), 'utf8');
for (const p of latest5) {
  if (!homeHtml.includes(`href="/post/${p.slug}/"`) || !homeHtml.includes(esc(p.title))) {
    throw new Error(`首页最近更新自检失败：缺 ${p.slug}`);
  }
}
console.log(`✓ 首页最近更新已静态化：${latest5.map((p) => p.slug).join(', ')}`);
console.log('生成完毕。');
