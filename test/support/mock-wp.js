// A small in-memory imitation of the WordPress REST API, covering the endpoints the
// manager uses. It mirrors real WordPress responses (error codes, headers, pagination)
// closely enough to exercise the client, the batch actions and the HTTP API.
import http from 'node:http';

const CAPS = {
  administrator: [
    'edit_posts', 'edit_others_posts', 'publish_posts', 'delete_posts', 'delete_others_posts', 'edit_pages',
    'manage_categories', 'upload_files', 'manage_options', 'install_plugins', 'activate_plugins', 'delete_plugins',
  ],
  editor: [
    'edit_posts', 'edit_others_posts', 'publish_posts', 'delete_posts', 'delete_others_posts', 'edit_pages',
    'manage_categories', 'upload_files',
  ],
};

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function error(status, code, message, extra = {}) {
  return { status, body: { code, message, data: { status, ...extra } } };
}

export async function startMockWp({
  restStyle = 'pretty',
  username = 'admin',
  password = 'abcd efgh ijkl mnop qrst uvwx',
  role = 'administrator',
  name = 'Mock 新闻站',
  appPasswords = true,
  delayMs = 0,
} = {}) {
  let nextId = 100;
  const state = {
    posts: new Map(),
    pages: new Map(),
    categories: new Map([[1, { id: 1, name: 'Uncategorized', count: 0 }]]),
    tags: new Map(),
    plugins: new Map([
      ['hello', { plugin: 'hello', status: 'inactive', name: 'Hello Dolly', version: '1.7.2', author: 'Matt', description: { raw: 'Hello', rendered: 'Hello' } }],
      ['akismet/akismet', { plugin: 'akismet/akismet', status: 'active', name: 'Akismet Anti-spam', version: '5.3', author: 'Automattic', description: { raw: 'Spam', rendered: 'Spam' } }],
    ]),
    // Slugs "available on WordPress.org" for install.
    directory: { 'classic-editor': { name: 'Classic Editor', version: '1.6.5', main: 'classic-editor/classic-editor' } },
    settings: {
      title: name, description: '', url: '', email: 'admin@example.com', timezone: 'UTC',
      date_format: 'F j, Y', time_format: 'g:i a', start_of_week: 1, language: 'en_US',
      use_smilies: true, posts_per_page: 10, default_comment_status: 'open', default_ping_status: 'open',
    },
    media: [],
    requests: [],
    // Hooks for tests: return a response object to short-circuit a request.
    intercept: null,
    delayMs,
    inFlight: 0,
    peakInFlight: 0,
  };

  const auth = { username, password };
  const server = http.createServer(handle);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  state.settings.url = base;

  const addPost = (type, fields) => {
    const id = nextId++;
    const now = new Date(Date.UTC(2024, 0, 1) + id * 60000).toISOString().slice(0, 19);
    const post = {
      id, type, title: '', content: '', excerpt: '', status: 'publish', slug: `post-${id}`,
      date: now, date_gmt: now, modified: now, author: 1, sticky: false, comment_status: 'open',
      categories: type === 'posts' ? [1] : undefined, tags: type === 'posts' ? [] : undefined, featured_media: 0,
      ...fields,
    };
    state[type].set(id, post);
    return post;
  };

  const addTerm = (taxonomy, termName) => {
    const id = nextId++;
    const term = { id, name: termName, count: 0 };
    state[taxonomy].set(id, term);
    return term;
  };

  function formatPost(p, context) {
    const out = {
      id: p.id, date: p.date, date_gmt: p.date_gmt, modified: p.modified, slug: p.slug, status: p.status, type: p.type === 'posts' ? 'post' : 'page',
      link: `${base}/?p=${p.id}`, title: { rendered: esc(p.title) }, content: { rendered: `<p>${p.content}</p>` },
      excerpt: { rendered: esc(p.excerpt) }, author: p.author, comment_status: p.comment_status, featured_media: p.featured_media,
    };
    if (context === 'edit') {
      out.title.raw = p.title;
      out.content.raw = p.content;
      out.excerpt.raw = p.excerpt;
    }
    if (p.type === 'posts') Object.assign(out, { sticky: p.sticky, categories: p.categories, tags: p.tags });
    return out;
  }

  function pickFields(obj, fields) {
    if (!fields) return obj;
    const keys = fields.split(',');
    return Object.fromEntries(Object.entries(obj).filter(([k]) => keys.includes(k)));
  }

  function list(items, query, format) {
    const perPage = Math.min(100, parseInt(query.get('per_page'), 10) || 10);
    const page = parseInt(query.get('page'), 10) || 1;
    const total = items.length;
    const totalPages = Math.max(1, Math.ceil(total / perPage));
    if (page > totalPages && total > 0) return error(400, 'rest_post_invalid_page_number', 'The page number requested is larger than the number of pages available.');
    const slice = items.slice((page - 1) * perPage, page * perPage).map(format);
    return { status: 200, body: slice, headers: { 'X-WP-Total': String(total), 'X-WP-TotalPages': String(totalPages) } };
  }

  function applyPostFields(post, body) {
    for (const key of ['title', 'content', 'excerpt', 'status', 'slug', 'comment_status', 'categories', 'tags', 'sticky', 'featured_media', 'date_gmt']) {
      if (body[key] !== undefined) post[key] = body[key];
    }
    if (body.status && body.status !== 'trash' && body.slug === undefined && post.slug.endsWith('__trashed') && post.slug !== '__trashed') {
      post.slug = post.slug.slice(0, -'__trashed'.length); // WordPress restores the "desired" slug
    }
    if (body.date_gmt) {
      post.date = body.date_gmt;
      if (post.status === 'publish' && new Date(`${body.date_gmt}Z`) > new Date()) post.status = 'future';
    }
    post.modified = new Date().toISOString().slice(0, 19);
  }

  function route(method, path, query, body, rawBody, headers) {
    const fields = query.get('_fields');
    if (path === '/' && method === 'GET') {
      const index = {
        name: esc(name), description: '', url: base, home: base, namespaces: ['oembed/1.0', 'wp/v2'],
        authentication: appPasswords
          ? { 'application-passwords': { endpoints: { authorization: `${base}/wp-admin/authorize-application.php` } } }
          : {},
      };
      return { status: 200, body: index };
    }

    const header = headers.authorization || '';
    const [user, ...rest] = Buffer.from(header.replace(/^Basic /, ''), 'base64').toString('utf8').split(':');
    const pass = rest.join(':').replace(/[^a-z\d]/gi, '');
    if (!header || !appPasswords || user !== auth.username || pass !== auth.password.replace(/[^a-z\d]/gi, '')) {
      return error(401, 'rest_not_logged_in', 'You are not currently logged in.');
    }
    const caps = CAPS[role];
    const can = (cap) => caps.includes(cap);

    if (path === '/wp/v2/users/me') {
      return { status: 200, body: pickFields({ id: 1, name: 'Admin &amp; Co', slug: username, roles: [role], capabilities: Object.fromEntries(caps.map((c) => [c, true])) }, fields) };
    }
    if (path === '/wp/v2/users') {
      const ids = (query.get('include') || '').split(',').map(Number);
      return { status: 200, body: ids.includes(1) ? [pickFields({ id: 1, name: 'Admin' }, fields)] : [] };
    }

    let m = path.match(/^\/wp\/v2\/(posts|pages)(?:\/(\d+))?$/);
    if (m) {
      const [, type, idStr] = m;
      const store = state[type];
      if (!idStr) {
        if (method === 'GET') {
          const statuses = (query.get('status') || 'publish').split(',');
          const search = (query.get('search') || '').toLowerCase();
          const cats = (query.get('categories') || '').split(',').filter(Boolean).map(Number);
          let items = [...store.values()].filter((p) => (statuses.includes('any') ? p.status !== 'trash' : statuses.includes(p.status)));
          if (search) items = items.filter((p) => p.title.toLowerCase().includes(search) || p.content.toLowerCase().includes(search));
          if (cats.length) items = items.filter((p) => p.categories?.some((c) => cats.includes(c)));
          items.sort((a, b) => b.id - a.id);
          return list(items, query, (p) => pickFields(formatPost(p, query.get('context')), fields));
        }
        if (method === 'POST') {
          if (!can('publish_posts')) return error(403, 'rest_cannot_create', 'Sorry, you are not allowed to create posts as this user.');
          const post = addPost(type, { title: body.title || '', content: body.content || '', status: 'draft' });
          applyPostFields(post, body);
          return { status: 201, body: formatPost(post, 'edit') };
        }
      } else {
        const post = store.get(Number(idStr));
        if (!post) return error(404, 'rest_post_invalid_id', 'Invalid post ID.');
        if (method === 'GET') return { status: 200, body: pickFields(formatPost(post, query.get('context')), fields) };
        if (method === 'POST') {
          applyPostFields(post, body);
          return { status: 200, body: pickFields(formatPost(post, 'edit'), fields) };
        }
        if (method === 'DELETE') {
          if (query.get('force') === 'true') {
            store.delete(post.id);
            return { status: 200, body: { deleted: true, previous: formatPost(post, 'edit') } };
          }
          if (post.status === 'trash') return error(410, 'rest_already_trashed', 'The post has already been deleted.');
          post.status = 'trash';
          post.slug = post.slug ? `${post.slug}__trashed` : '__trashed';
          return { status: 200, body: formatPost(post, 'edit') };
        }
      }
    }

    m = path.match(/^\/wp\/v2\/(categories|tags)(?:\/(\d+))?$/);
    if (m) {
      const [, taxonomy, idStr] = m;
      const terms = state[taxonomy];
      if (!idStr && method === 'GET') {
        const search = (query.get('search') || '').toLowerCase();
        const include = (query.get('include') || '').split(',').filter(Boolean).map(Number);
        let items = [...terms.values()];
        if (search) items = items.filter((t) => t.name.toLowerCase().includes(search));
        if (include.length) items = items.filter((t) => include.includes(t.id));
        return list(items, query, (t) => pickFields({ ...t, name: esc(t.name) }, fields));
      }
      if (!idStr && method === 'POST') {
        if (!can('manage_categories')) return error(403, 'rest_cannot_create', 'Sorry, you are not allowed to create terms in this taxonomy.');
        const existing = [...terms.values()].find((t) => t.name.toLowerCase() === String(body.name).toLowerCase());
        if (existing) return error(400, 'term_exists', 'A term with the name provided already exists with this parent.', { term_id: existing.id });
        return { status: 201, body: addTerm(taxonomy, body.name) };
      }
      if (idStr && method === 'DELETE') {
        const term = terms.get(Number(idStr));
        if (!term) return error(404, 'rest_term_invalid', 'Term does not exist.');
        if (query.get('force') !== 'true') return error(501, 'rest_trash_not_supported', 'Terms do not support trashing. Set \'force=true\' to delete.');
        if (term.id === 1) return error(403, 'rest_cannot_delete', 'Sorry, you are not allowed to delete this term.');
        terms.delete(term.id);
        for (const p of state.posts.values()) {
          p[taxonomy] = p[taxonomy].filter((id) => id !== term.id);
          if (taxonomy === 'categories' && !p.categories.length) p.categories = [1];
        }
        return { status: 200, body: { deleted: true, previous: term } };
      }
    }

    if (path.startsWith('/wp/v2/plugins')) {
      if (!can('activate_plugins')) return error(403, 'rest_cannot_view_plugins', 'Sorry, you are not allowed to manage plugins for this site.');
      const id = path.slice('/wp/v2/plugins/'.length);
      if (path === '/wp/v2/plugins' && method === 'GET') {
        return { status: 200, body: [...state.plugins.values()].map((p) => pickFields(p, fields)) };
      }
      if (path === '/wp/v2/plugins' && method === 'POST') {
        if (!can('install_plugins')) return error(403, 'rest_cannot_install_plugin', 'Sorry, you are not allowed to install plugins on this site.');
        const info = state.directory[body.slug];
        if (!info) return error(500, 'plugins_api_failed', 'Plugin not found.');
        if ([...state.plugins.keys()].some((k) => k.split('/')[0] === body.slug)) return error(500, 'folder_exists', 'Destination folder already exists.');
        const plugin = { plugin: info.main, status: body.status === 'active' ? 'active' : 'inactive', name: info.name, version: info.version, author: '', description: { raw: '', rendered: '' } };
        state.plugins.set(info.main, plugin);
        return { status: 201, body: plugin };
      }
      const plugin = state.plugins.get(id);
      if (!plugin) return error(404, 'rest_plugin_not_found', 'Plugin not found.');
      if (method === 'POST') {
        plugin.status = body.status;
        return { status: 200, body: plugin };
      }
      if (method === 'DELETE') {
        if (plugin.status === 'active') return error(400, 'rest_cannot_delete_active_plugin', 'Cannot delete an active plugin. Please deactivate it first.');
        state.plugins.delete(id);
        return { status: 200, body: { deleted: true, previous: plugin } };
      }
    }

    if (path === '/wp/v2/settings') {
      if (!can('manage_options')) return error(403, 'rest_forbidden', 'Sorry, you are not allowed to do that.');
      if (method === 'POST') {
        for (const [k, v] of Object.entries(body)) {
          if (!(k in state.settings)) continue; // unknown settings are silently ignored, like WordPress
          if (k === 'language' && v !== 'en_US') continue; // only installed languages are accepted
          state.settings[k] = k === 'description' ? esc(v) : v;
        }
      }
      return { status: 200, body: state.settings };
    }

    if (path === '/wp/v2/media' && method === 'POST') {
      const disposition = headers['content-disposition'] || '';
      const file = disposition.match(/filename="?([^";]+)"?/)?.[1];
      if (!file) return error(400, 'rest_upload_no_content_disposition', 'No Content-Disposition supplied.');
      const media = { id: nextId++, file, type: headers['content-type'], size: rawBody.length, source_url: `${base}/wp-content/uploads/${file}` };
      state.media.push(media);
      return { status: 201, body: media };
    }

    return error(404, 'rest_no_route', 'No route was found matching the URL and request method.');
  }

  function handle(req, res) {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const url = new URL(req.url, base);
      let path = null;
      if (url.searchParams.has('rest_route')) path = url.searchParams.get('rest_route');
      else if (restStyle === 'pretty' && url.pathname.startsWith('/wp-json')) path = url.pathname.slice('/wp-json'.length) || '/';

      if (path === null) {
        // Front end of the site (and /wp-json/ on sites without pretty permalinks).
        res.writeHead(200, { 'Content-Type': 'text/html; charset=UTF-8', Link: `<${restStyle === 'pretty' ? `${base}/wp-json/` : `${base}/?rest_route=/`}>; rel="https://api.w.org/"` });
        return res.end(`<!doctype html><title>${esc(name)}</title>`);
      }

      const rawBody = Buffer.concat(chunks);
      let body = {};
      if (String(req.headers['content-type']).startsWith('application/json') && rawBody.length) body = JSON.parse(rawBody.toString('utf8'));
      state.requests.push({ method: req.method, path, query: url.search, body });

      state.inFlight++;
      state.peakInFlight = Math.max(state.peakInFlight, state.inFlight);
      setTimeout(() => {
        state.inFlight--;
        const result = state.intercept?.(req.method, path, url.searchParams, body)
          || route(req.method, path.replace(/\/+$/, '') || '/', url.searchParams, body, rawBody, req.headers);
        res.writeHead(result.status, { 'Content-Type': result.contentType || 'application/json; charset=UTF-8', ...result.headers });
        res.end(typeof result.body === 'string' ? result.body : JSON.stringify(result.body));
      }, state.delayMs);
    });
  }

  return {
    url: base,
    state,
    auth,
    addPost,
    addTerm,
    close: () => new Promise((resolve) => {
      server.close(resolve);
      server.closeAllConnections?.();
    }),
  };
}
