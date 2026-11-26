const $ = selector => document.querySelector(selector);

export function setupManagement({ api, setMessage, toast, prettySize, dateText, isAdminPage, login, activate }) {
  setupMcp(api, setMessage);
  if (!isAdminPage) return { accountChanged() {} };
  return setupAdmin({ api, setMessage, toast, prettySize, dateText, login, activate });
}

function setupMcp(api, setMessage) {
  const dialog = $('#mcp-dialog');
  const generate = $('#mcp-generate');
  const revoke = $('#mcp-revoke');
  const token = $('#mcp-token');
  const errorBox = $('#mcp-error');
  let active = false;
  let busy = false;

  function render(createdAt) {
    active = createdAt !== null;
    $('#mcp-status').textContent = active ? '已有有效令牌。重新生成后，旧令牌会立即失效。' : '尚未生成令牌。';
    generate.textContent = active ? '重新生成令牌' : '生成令牌';
    revoke.hidden = !active;
  }

  function setBusy(value) {
    busy = value;
    generate.disabled = value;
    revoke.disabled = value;
    dialog.querySelector('[data-close]').disabled = value;
  }

  async function change(method) {
    setBusy(true);
    setMessage(errorBox, '');
    try {
      const result = await api('/api/mcp-token', { method });
      token.value = result.token ?? '';
      $('#mcp-issued').hidden = !token.value;
      $('#mcp-copy').textContent = '复制令牌';
      render(result.created_at ?? null);
    } catch (error) {
      setMessage(errorBox, error.message);
    } finally {
      setBusy(false);
    }
  }

  $('#mcp-open').addEventListener('click', async () => {
    $('#mcp-url').value = location.origin + '/mcp';
    setMessage(errorBox, '');
    revoke.hidden = true;
    $('#mcp-status').textContent = '正在检查令牌…';
    setBusy(true);
    dialog.showModal();
    try {
      const result = await api('/api/mcp-token');
      render(result.created_at);
    } catch (error) {
      setMessage(errorBox, error.message);
      $('#mcp-status').textContent = '';
    } finally {
      setBusy(false);
    }
  });
  dialog.addEventListener('cancel', event => {
    if (busy) event.preventDefault();
  });
  dialog.addEventListener('close', () => {
    token.value = '';
    $('#mcp-issued').hidden = true;
  });
  generate.addEventListener('click', () => change('POST'));
  revoke.addEventListener('click', () => change('DELETE'));
  $('#mcp-copy').addEventListener('click', async event => {
    const button = event.currentTarget;
    try {
      await navigator.clipboard.writeText(token.value);
      button.textContent = '已复制';
    } catch {
      token.focus();
      token.select();
      setMessage(errorBox, '令牌已选中，可以手动复制。');
    }
  });
}

function setupAdmin({ api, setMessage, toast, prettySize, dateText, login, activate }) {
  const selectAll = $('#admin-select-all');
  const bulk = $('#admin-bulk');
  const cleanup = $('#admin-cleanup');
  const rows = $('#admin-rows');
  const dialog = $('#admin-confirm-dialog');
  const selected = new Set();
  let page = 1;
  let lastPage = 1;
  let query = '';
  let docs = [];
  let cleanable = 0;
  let loading = false;
  let authorized = false;
  let requestId = 0;
  let confirmAction;

  function syncControls() {
    const selectable = docs.filter(doc => doc.state !== 'pending').length;
    selectAll.disabled = loading || !selectable;
    selectAll.checked = selectable > 0 && selected.size === selectable;
    selectAll.indeterminate = selected.size > 0 && selected.size < selectable;
    bulk.disabled = loading || !selected.size;
    bulk.textContent = selected.size ? '删除所选（' + selected.size + '）' : '删除所选';
    cleanup.disabled = loading || !cleanable;
    $('#admin-prev').disabled = loading || page <= 1;
    $('#admin-next').disabled = loading || page >= lastPage;
  }

  function confirm(title, detail, action) {
    confirmAction = action;
    $('#admin-confirm-title').textContent = title;
    $('#admin-confirm-detail').textContent = detail;
    setMessage($('#admin-confirm-error'), '');
    dialog.showModal();
  }

  function confirmDelete(ids, name) {
    confirm('删除文档', name ? '删除「' + name + '」后，原文件和分享链接将不可用。' :
      '将删除所选的 ' + ids.length + ' 份文档，并使相关分享链接失效。', async () => {
      const result = await api('/api/admin/documents/delete', { method: 'POST', json: { ids } });
      return '已删除 ' + result.deleted + ' 份文档';
    });
  }

  function renderRows() {
    const status = { pending: '上传未完成', deleting: '删除未完成' };
    rows.replaceChildren(...docs.map(doc => {
      const row = document.createElement('tr');
      const pick = row.insertCell();
      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.disabled = doc.state === 'pending';
      checkbox.checked = selected.has(doc.id);
      checkbox.setAttribute('aria-label', '选择 ' + doc.name);
      checkbox.addEventListener('change', () => {
        if (checkbox.checked) selected.add(doc.id);
        else selected.delete(doc.id);
        syncControls();
      });
      pick.append(checkbox);
      const file = row.insertCell();
      const title = document.createElement('strong');
      const details = document.createElement('small');
      title.dir = 'auto';
      title.textContent = doc.name;
      details.textContent = doc.format.toUpperCase() + ' · ' + prettySize(doc.size);
      file.append(title, details);
      row.insertCell().textContent = doc.owner;
      row.insertCell().textContent = status[doc.state] ?? (doc.shared ? '已分享' : '私有');
      row.insertCell().textContent = dateText(doc.created_at);
      const action = row.insertCell();
      if (doc.state !== 'pending') {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'text-button text-danger';
        button.textContent = '删除';
        button.setAttribute('aria-label', '删除 ' + doc.name);
        button.addEventListener('click', () => confirmDelete([doc.id], doc.name));
        action.append(button);
      }
      return row;
    }));
  }

  async function load() {
    if (!authorized) return;
    const current = ++requestId;
    loading = true;
    docs = [];
    selected.clear();
    rows.replaceChildren();
    setMessage($('#admin-error'), '');
    setMessage($('#admin-empty'), '正在加载文档…');
    syncControls();
    const params = new URLSearchParams({ q: query, filter: $('#admin-filter').value, page });
    try {
      const data = await api('/api/admin/documents?' + params);
      if (current !== requestId) return;
      lastPage = Math.max(1, Math.ceil(data.total / data.page_size));
      if (page > lastPage) {
        page = lastPage;
        return await load();
      }
      docs = data.documents;
      cleanable = data.stats.cleanable;
      $('#admin-total').textContent = data.stats.total;
      $('#admin-size').textContent = prettySize(data.stats.size);
      $('#admin-cleanable').textContent = cleanable;
      $('#admin-page').textContent = '第 ' + page + ' / ' + lastPage + ' 页 · ' + data.total + ' 份文档';
      renderRows();
      setMessage($('#admin-empty'), docs.length ? '' : '暂无匹配的文档。');
    } catch (error) {
      if (current !== requestId) return;
      cleanable = 0;
      lastPage = 1;
      setMessage($('#admin-empty'), '');
      setMessage($('#admin-error'), error.message);
    } finally {
      if (current === requestId) {
        loading = false;
        syncControls();
      }
    }
  }

  $('#admin-login').addEventListener('click', login);
  $('#admin-activate').addEventListener('submit', async event => {
    event.preventDefault();
    const form = event.currentTarget;
    const submit = $('#admin-activate-submit');
    setMessage($('#admin-access-error'), '');
    submit.disabled = true;
    try {
      await api('/api/admin/activate', { method: 'POST', json: { code: form.elements.code.value } });
      form.reset();
      activate();
      toast('管理员已激活');
    } catch (error) {
      setMessage($('#admin-access-error'), error.message);
    } finally {
      submit.disabled = false;
    }
  });
  $('#admin-search-form').addEventListener('submit', event => {
    event.preventDefault();
    query = $('#admin-search').value.trim();
    page = 1;
    void load();
  });
  $('#admin-filter').addEventListener('change', () => { page = 1; void load(); });
  $('#admin-prev').addEventListener('click', () => { page -= 1; void load(); });
  $('#admin-next').addEventListener('click', () => { page += 1; void load(); });
  selectAll.addEventListener('change', () => {
    selected.clear();
    if (selectAll.checked) for (const doc of docs) if (doc.state !== 'pending') selected.add(doc.id);
    renderRows();
    syncControls();
  });
  bulk.addEventListener('click', () => confirmDelete([...selected]));
  cleanup.addEventListener('click', () => confirm(
    '清理未完成的文档',
    '本次最多清理 50 条记录，包括超过 1 小时的未完成上传，以及未完成的删除。',
    async () => {
      const result = await api('/api/admin/cleanup', { method: 'POST' });
      return '已清理 ' + result.deleted + ' 条记录';
    },
  ));
  $('#admin-confirm-submit').addEventListener('click', async event => {
    const button = event.currentTarget;
    button.disabled = true;
    setMessage($('#admin-confirm-error'), '');
    try {
      const result = await confirmAction();
      dialog.close();
      toast(result);
      await load();
    } catch (error) {
      setMessage($('#admin-confirm-error'), error.message);
    } finally {
      button.disabled = false;
    }
  });

  return {
    accountChanged(username, isAdmin) {
      authorized = isAdmin;
      requestId += 1;
      $('#admin-console').hidden = !authorized;
      $('#admin-access').hidden = authorized;
      $('#admin-login').hidden = Boolean(username);
      $('#admin-activate').hidden = !username;
      $('#admin-access-title').textContent = username ? '需要管理员权限' : '登录管理后台';
      $('#admin-access-detail').textContent = username ? '首次设置时，使用独立的激活码授权当前账号。' :
        '请先登录 Folio Dock，再进入管理后台。';
      setMessage($('#admin-access-error'), '');
      if (authorized) void load();
    },
  };
}
