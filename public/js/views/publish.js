import { h, clear, button, field, toast, withBusy, confirmDialog, select, radios, checkbox, readStorage, writeStorage } from '../dom.js';
import { subscribe, selectedSites } from '../store.js';
import { runJob } from '../jobs.js';

const DRAFT_KEY = 'wpbm.publishDraft';
const MAX_IMAGE = 15 * 1024 * 1024;

function readAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error('读取图片失败'));
    reader.readAsDataURL(file);
  });
}

export function mount(el) {
  const cleanups = [];
  const draft = readStorage(DRAFT_KEY, {});

  const type = radios('publish-type', [['posts', '文章'], ['pages', '页面']], draft.type || 'posts');
  const title = h('input', { type: 'text', placeholder: '标题', value: draft.title || '' });
  const content = h('textarea', { rows: 14, class: 'code', placeholder: '正文，支持 HTML，例如：<p>第一段</p><p>第二段</p>' });
  content.value = draft.content || '';
  const excerpt = h('textarea', { rows: 2, placeholder: '可选' });
  excerpt.value = draft.excerpt || '';
  const categories = h('input', { type: 'text', placeholder: '例如：国内新闻, 科技（多个用逗号分隔）', value: draft.categories || '' });
  const tags = h('input', { type: 'text', placeholder: '例如：热点, 头条', value: draft.tags || '' });
  const createTerms = checkbox('分类/标签不存在时自动创建', { checked: draft.createTerms !== false });
  const status = select([['publish', '立即发布'], ['draft', '保存为草稿'], ['pending', '待审核'], ['private', '私密'], ['future', '定时发布']], draft.status || 'publish');
  const date = h('input', { type: 'datetime-local', value: draft.date || '' });
  const comment = select([['', '跟随网站默认设置'], ['open', '允许评论'], ['closed', '关闭评论']], draft.comment || '');
  const slug = h('input', { type: 'text', placeholder: '可选，留空自动生成', value: draft.slug || '' });
  const imageFile = h('input', { type: 'file', accept: 'image/jpeg,image/png,image/gif,image/webp' });
  const imageUrl = h('input', { type: 'text', placeholder: '或者填写图片网址 https://…', value: draft.imageUrl || '' });
  const preview = h('img', { alt: '', class: 'hidden' });
  Object.assign(preview.style, { maxWidth: '240px', maxHeight: '150px', borderRadius: '6px', border: '1px solid var(--border)' });
  const clearImage = button('移除图片', { size: 'xs', kind: 'ghost' });
  clearImage.classList.add('hidden');
  const targets = h('div', { class: 'notice' });
  const publishBtn = button('发布', { kind: 'primary' });
  const resetBtn = button('清空表单', { kind: 'ghost' });
  const dateField = field('发布时间', date, '可选。留空表示现在；"定时发布"必须填写将来的时间');
  const taxonomyFields = h('div', { class: 'grid cols-2' },
    field('分类', categories, '按名称匹配各站点的分类'),
    field('标签', tags));

  let imageData = null;

  const saveDraft = () => writeStorage(DRAFT_KEY, {
    type: type.get(), title: title.value, content: content.value, excerpt: excerpt.value, categories: categories.value,
    tags: tags.value, createTerms: createTerms.input.checked, status: status.value, date: date.value,
    comment: comment.value, slug: slug.value, imageUrl: imageUrl.value,
  });
  el.addEventListener('input', saveDraft);
  el.addEventListener('change', saveDraft);

  const syncType = () => {
    const isPosts = type.get() === 'posts';
    taxonomyFields.classList.toggle('hidden', !isPosts);
    createTerms.el.classList.toggle('hidden', !isPosts);
  };
  type.inputs.forEach((i) => i.addEventListener('change', syncType));
  syncType();

  imageFile.addEventListener('change', async () => {
    const file = imageFile.files[0];
    if (!file) return;
    if (file.size > MAX_IMAGE) {
      imageFile.value = '';
      return toast('图片不能超过 15MB', 'error');
    }
    try {
      const dataUrl = await readAsDataUrl(file);
      imageData = { dataBase64: String(dataUrl).split(',')[1], mimeType: file.type, filename: file.name };
      preview.src = dataUrl;
      preview.classList.remove('hidden');
      clearImage.classList.remove('hidden');
      imageUrl.value = '';
    } catch (err) {
      toast(err.message, 'error');
    }
  });
  clearImage.addEventListener('click', () => {
    imageData = null;
    imageFile.value = '';
    preview.removeAttribute('src');
    preview.classList.add('hidden');
    clearImage.classList.add('hidden');
  });

  const renderTargets = () => {
    const sites = selectedSites();
    publishBtn.textContent = sites.length ? `发布到 ${sites.length} 个站点` : '发布';
    clear(targets, sites.length
      ? [h('b', null, `将发布到左侧已选的 ${sites.length} 个站点：`), sites.map((s) => s.name).join('、')]
      : h('span', null, '请先在左侧选择要发布到的站点。'));
    targets.className = `notice ${sites.length ? 'info' : 'warn'}`;
  };
  renderTargets();
  cleanups.push(subscribe(renderTargets));

  resetBtn.addEventListener('click', async () => {
    if (!(await confirmDialog({ message: '清空表单中已填写的内容？', confirmText: '清空' }))) return;
    for (const input of [title, content, excerpt, categories, tags, date, slug, imageUrl]) input.value = '';
    clearImage.click();
    saveDraft();
  });

  publishBtn.addEventListener('click', async () => {
    const sites = selectedSites();
    if (!sites.length) return toast('请先在左侧选择站点', 'warn');
    if (!title.value.trim()) return toast('请填写标题', 'warn');
    if (status.value === 'future' && !date.value) return toast('定时发布需要填写发布时间', 'warn');
    const typeText = type.get() === 'pages' ? '页面' : '文章';
    const ok = await confirmDialog({
      title: `批量发布${typeText}`,
      message: `将在 ${sites.length} 个站点上各创建一篇${typeText}「${title.value.trim()}」。确定吗？`,
      details: h('div', { class: 'muted small' }, sites.map((s) => s.name).join('、')),
      confirmText: '开始发布',
    });
    if (!ok) return;
    const params = {
      title: title.value,
      content: content.value,
      excerpt: excerpt.value,
      status: status.value,
      slug: slug.value.trim(),
      commentStatus: comment.value,
      categories: categories.value,
      tags: tags.value,
      createTerms: createTerms.input.checked,
    };
    if (date.value) params.date = new Date(date.value).toISOString();
    if (imageData) params.image = imageData;
    else if (imageUrl.value.trim()) params.image = { url: imageUrl.value.trim() };
    await withBusy(publishBtn, async () => {
      try {
        const job = await runJob({ action: 'posts.create', type: type.get(), siteIds: sites.map((s) => s.id), params });
        if (job.counts.error === 0 && job.status === 'done') toast(`已在 ${job.counts.ok + job.counts.warn} 个站点创建`, 'ok');
      } catch (err) {
        toast(err.message, 'error', 8000);
      }
    });
  });

  clear(el,
    h('div', { class: 'view-head' }, h('h2', null, '批量发布'), h('span', { class: 'muted small' }, '写一次，同时发布到多个站点')),
    targets,
    h('div', { class: 'card' },
      h('div', { class: 'card-body stack' },
        h('div', { class: 'field' }, h('span', { class: 'label' }, '类型'), type.el),
        field('标题', title),
        field('正文', content, '支持 HTML。可以在 WordPress 编辑器里切换到"代码编辑器"复制内容过来。'),
        field('摘要', excerpt),
        taxonomyFields,
        createTerms.el,
        h('div', { class: 'grid cols-4' }, field('状态', status), dateField, field('评论', comment), field('别名（网址）', slug)),
        h('div', { class: 'field' },
          h('span', { class: 'label' }, '特色图片（可选）'),
          h('div', { class: 'row' }, imageFile, clearImage),
          imageUrl,
          preview,
          h('div', { class: 'hint' }, '支持 JPG、PNG、GIF、WebP，最大 15MB。图片会分别上传到每个站点的媒体库。'))),
      h('div', { class: 'card-foot' }, publishBtn, resetBtn, h('span', { class: 'muted small' }, '表单内容会自动保存在本浏览器中'))));

  return () => cleanups.forEach((fn) => fn());
}
