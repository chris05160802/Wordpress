import { pool, htmlToText, clampInt, parseList, badRequest } from './util.js';

const SITE_CONCURRENCY = 6;
const POST_STATUSES = ['any', 'publish', 'draft', 'pending', 'private', 'future', 'trash'];
const LIST_FIELDS = 'id,title,status,date,modified,link,categories,tags,author,sticky,comment_status,slug';
const EDIT_FIELDS = 'id,title,content,excerpt,status,slug,link,date,comment_status,sticky';

/** Runs fn for every site; a failing site yields { siteId, error } instead of failing the whole query. */
async function forSites(ctx, sites, fn) {
  return pool(sites, SITE_CONCURRENCY, async (site) => {
    try {
      return { siteId: site.id, ...(await fn(ctx.siteContext(site), site)) };
    } catch (err) {
      return { siteId: site.id, error: err.message };
    }
  });
}

export function postType(value) {
  const type = value || 'posts';
  if (type !== 'posts' && type !== 'pages') throw badRequest('内容类型不正确');
  return type;
}

function wpDate(value, endOfDay) {
  const s = String(value ?? '').trim();
  if (!s) return undefined;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) throw badRequest('日期格式应为 YYYY-MM-DD');
  return `${s}T${endOfDay ? '23:59:59' : '00:00:00'}`;
}

function decodeSlug(slug) {
  try {
    return decodeURIComponent(slug || '');
  } catch {
    return slug || '';
  }
}

/** id -> name for the given term IDs (cosmetic; failures just leave names blank). */
async function termNames(client, taxonomy, ids) {
  const unique = [...new Set(ids)].filter((id) => id > 0);
  const names = new Map();
  for (let i = 0; i < unique.length; i += 100) {
    try {
      const list = await client.get(`/wp/v2/${taxonomy}`, { include: unique.slice(i, i + 100), per_page: 100, _fields: 'id,name' });
      for (const t of list) names.set(t.id, htmlToText(t.name));
    } catch {
      // ignore
    }
  }
  return names;
}

async function userNames(client, ids) {
  const unique = [...new Set(ids)].filter((id) => id > 0).slice(0, 100);
  const names = new Map();
  if (!unique.length) return names;
  try {
    const list = await client.get('/wp/v2/users', { include: unique, per_page: 100, _fields: 'id,name' });
    for (const u of list) names.set(u.id, htmlToText(u.name));
  } catch {
    // Listing users needs extra permissions on some sites; author names are optional.
  }
  return names;
}

export async function queryPosts(ctx, sites, params = {}) {
  const type = postType(params.type);
  const limit = clampInt(params.limit, 1, 2000, 100);
  const status = POST_STATUSES.includes(params.status) ? params.status : 'any';
  const search = String(params.search ?? '').trim();
  const categories = type === 'posts' ? parseList(params.category) : [];
  const tags = type === 'posts' ? parseList(params.tag) : [];
  const after = wpDate(params.after, false);
  const before = wpDate(params.before, true);

  const results = await forSites(ctx, sites, async (sc, site) => {
    const query = { status, orderby: 'date', order: 'desc', _fields: LIST_FIELDS, search, after, before };
    if (categories.length) {
      query.categories = await sc.terms.resolve('categories', categories);
      if (!query.categories.length) return { total: 0, items: [], note: '该站点没有这个分类' };
    }
    if (tags.length) {
      query.tags = await sc.terms.resolve('tags', tags);
      if (!query.tags.length) return { total: 0, items: [], note: '该站点没有这个标签' };
    }
    const { items, total } = await sc.client.getAll(`/wp/v2/${type}`, query, limit);
    const [catNames, tagNames, authors] = await Promise.all([
      termNames(sc.client, 'categories', items.flatMap((p) => p.categories || [])),
      termNames(sc.client, 'tags', items.flatMap((p) => p.tags || [])),
      userNames(sc.client, items.map((p) => p.author)),
    ]);
    return {
      total,
      items: items.map((p) => ({
        siteId: site.id,
        id: p.id,
        title: htmlToText(p.title?.rendered),
        status: p.status,
        date: p.date,
        modified: p.modified,
        link: p.link,
        slug: decodeSlug(p.slug),
        sticky: Boolean(p.sticky),
        commentStatus: p.comment_status,
        author: authors.get(p.author) || '',
        categories: (p.categories || []).map((id) => catNames.get(id) || `#${id}`),
        tags: (p.tags || []).map((id) => tagNames.get(id) || `#${id}`),
      })),
    };
  });

  return {
    type,
    // Newest first across all sites.
    items: results.flatMap((r) => r.items || []).sort((a, b) => String(b.date).localeCompare(String(a.date))),
    sites: results.map(({ items, ...r }) => ({ ...r, count: items ? items.length : 0 })),
  };
}

export async function getPostForEdit(ctx, site, type, id) {
  const sc = ctx.siteContext(site);
  const p = await sc.client.get(`/wp/v2/${postType(type)}/${id}`, { context: 'edit', _fields: EDIT_FIELDS });
  return {
    siteId: site.id,
    id: p.id,
    title: p.title?.raw ?? '',
    content: p.content?.raw ?? '',
    excerpt: p.excerpt?.raw ?? '',
    status: p.status,
    slug: decodeSlug(p.slug),
    link: p.link,
    date: p.date,
    commentStatus: p.comment_status,
  };
}

const EDITABLE = { title: 'title', content: 'content', excerpt: 'excerpt', status: 'status', slug: 'slug', commentStatus: 'comment_status' };

export async function savePost(ctx, site, type, id, input = {}) {
  const body = {};
  for (const [key, wpKey] of Object.entries(EDITABLE)) {
    if (input[key] !== undefined && input[key] !== null) body[wpKey] = String(input[key]);
  }
  if (!Object.keys(body).length) throw badRequest('没有要保存的修改');
  const sc = ctx.siteContext(site);
  await sc.client.post(`/wp/v2/${postType(type)}/${id}`, body, { retries: 1 });
  return getPostForEdit(ctx, site, type, id);
}

export async function queryPlugins(ctx, sites) {
  const results = await forSites(ctx, sites, async (sc) => ({
    plugins: await sc.client.get('/wp/v2/plugins', { _fields: 'plugin,status,name,version,author,description' }),
  }));
  const byId = new Map();
  for (const r of results) {
    for (const p of r.plugins || []) {
      if (!byId.has(p.plugin)) {
        byId.set(p.plugin, {
          plugin: p.plugin,
          slug: p.plugin.split('/')[0],
          name: htmlToText(p.name) || p.plugin,
          author: htmlToText(p.author),
          description: htmlToText(p.description?.raw ?? p.description?.rendered ?? '').slice(0, 300),
          sites: {},
        });
      }
      byId.get(p.plugin).sites[r.siteId] = { status: p.status, version: p.version };
    }
  }
  return {
    plugins: [...byId.values()].sort((a, b) => a.name.localeCompare(b.name, 'zh-CN')),
    sites: results.map(({ plugins, ...r }) => ({ ...r, count: plugins ? plugins.length : 0 })),
  };
}

export async function querySettings(ctx, sites) {
  const results = await forSites(ctx, sites, async (sc) => ({ settings: await sc.client.get('/wp/v2/settings') }));
  return { sites: results };
}

export async function queryTerms(ctx, sites, taxonomy) {
  const tax = taxonomy === 'tags' ? 'tags' : 'categories';
  const results = await forSites(ctx, sites, async (sc) => {
    const { items, total } = await sc.client.getAll(`/wp/v2/${tax}`, { orderby: 'count', order: 'desc', _fields: 'id,name,count' }, 1000);
    return { terms: items, total };
  });
  const byName = new Map();
  for (const r of results) {
    for (const t of r.terms || []) {
      const name = htmlToText(t.name);
      const key = name.toLowerCase();
      if (!byName.has(key)) byName.set(key, { name, sites: {} });
      byName.get(key).sites[r.siteId] = { id: t.id, count: t.count };
    }
  }
  return {
    taxonomy: tax,
    terms: [...byName.values()].sort((a, b) => a.name.localeCompare(b.name, 'zh-CN')),
    sites: results.map(({ terms, ...r }) => ({ ...r, count: terms ? terms.length : 0 })),
  };
}
