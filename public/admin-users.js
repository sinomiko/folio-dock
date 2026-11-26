const $ = selector => document.querySelector(selector);
const statusLabels = { active: '正常', disabled: '已禁用', deleting: '正在删除' };

export function setupAdminUsers({ api, setMessage, toast, confirm, onCreated }) {
  const panel = $('#admin-users');
  const rows = $('#admin-users-rows');
  const dialog = $('#admin-user-dialog');
  const form = $('#admin-user-form');
  const submit = $('#admin-user-submit');
  const close = dialog.querySelector('[data-close]');
  const previous = $('#admin-users-prev');
  const next = $('#admin-users-next');
  let selectedUser;
  let page = 1;
  let lastPage = 1;
  let query = '';
  let requestId = 0;

  function openDialog(user = null) {
    selectedUser = user;
    form.reset();
    form.elements.username.readOnly = Boolean(user);
    form.elements.username.value = user?.username ?? '';
    $('#admin-user-title').textContent = user ? '重置密码' : '添加用户';
    $('#admin-user-description').textContent = user
      ? '重置后，用户需要用新密码重新登录，现有 MCP 令牌也会失效。'
      : '创建普通账号。用户可以直接登录。';
    submit.textContent = user ? '保存新密码' : '创建账号';
    setMessage($('#admin-user-error'), '');
    dialog.showModal();
    form.elements[user ? 'password' : 'username'].focus();
  }

  $('#admin-add-user').addEventListener('click', () => openDialog());
  dialog.addEventListener('close', () => {
    form.reset();
    selectedUser = null;
    setMessage($('#admin-user-error'), '');
  });
  dialog.addEventListener('cancel', event => {
    if (submit.disabled) event.preventDefault();
  });

  form.addEventListener('submit', async event => {
    event.preventDefault();
    setMessage($('#admin-user-error'), '');
    submit.disabled = true;
    close.disabled = true;
    const user = selectedUser;
    try {
      if (user) {
        await api('/api/admin/users/' + user.id + '/password', {
          method: 'PATCH', json: { password: form.elements.password.value },
        });
        toast('已重置 ' + user.username + ' 的密码');
      } else {
        const result = await api('/api/admin/users', {
          method: 'POST', json: Object.fromEntries(new FormData(form)),
        });
        query = '';
        page = 1;
        $('#admin-users-search').value = '';
        onCreated();
        toast('已创建账号 ' + result.username);
      }
      dialog.close();
    } catch (error) {
      if (dialog.open) setMessage($('#admin-user-error'), error.message);
    } finally {
      submit.disabled = false;
      close.disabled = false;
    }
  });

  function userButton(label, user, action, danger = false) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = danger ? 'text-button text-danger' : 'text-button';
    button.textContent = label;
    button.setAttribute('aria-label', label + ' ' + user.username);
    button.addEventListener('click', action);
    return button;
  }

  function confirmStatus(user) {
    const disabling = user.status === 'active';
    const label = disabling ? '禁用用户' : '恢复用户';
    const detail = disabling
      ? '禁用「' + user.username + '」会结束其登录会话，撤销 MCP 令牌并暂停文档分享。'
      : '恢复「' + user.username + '」的登录和仍在有效期内的文档分享。';
    confirm(label, detail, async () => {
      await api('/api/admin/users/' + user.id + '/status', {
        method: 'PATCH', json: { status: disabling ? 'disabled' : 'active' },
      });
      return (disabling ? '已禁用 ' : '已恢复 ') + user.username;
    }, disabling);
  }

  function confirmDelete(user) {
    confirm('删除用户', '永久删除「' + user.username + '」的账号及其全部文档。分享链接和分享码也会失效。', async () => {
      const result = await api('/api/admin/users/' + user.id, { method: 'DELETE' });
      return result.status === 'deleting' ? '账号已停用，待上传结束后可继续删除。' : '已删除账号 ' + user.username;
    });
  }

  function renderRows(users) {
    rows.replaceChildren(...users.map(user => {
      const row = document.createElement('tr');
      row.insertCell().textContent = user.username;
      row.insertCell().textContent = user.is_admin ? '管理员' : '普通用户';
      row.insertCell().textContent = statusLabels[user.status];
      row.insertCell().textContent = user.document_count;

      const actions = document.createElement('div');
      actions.className = 'admin-user-actions';
      row.insertCell().append(actions);
      if (user.is_admin) return row;
      if (user.status !== 'deleting') {
        actions.append(
          userButton('重置密码', user, () => openDialog(user)),
          userButton(user.status === 'active' ? '禁用' : '恢复', user, () => confirmStatus(user)),
        );
      }
      actions.append(userButton(user.status === 'deleting' ? '继续删除' : '删除', user, () => confirmDelete(user), true));
      return row;
    }));
  }

  async function load() {
    if (panel.hidden) return;
    const current = ++requestId;
    rows.replaceChildren();
    $('#admin-users-page').textContent = '';
    previous.disabled = true;
    next.disabled = true;
    setMessage($('#admin-users-error'), '');
    setMessage($('#admin-users-empty'), '正在加载用户…');
    try {
      const params = new URLSearchParams({ q: query, page });
      const data = await api('/api/admin/users?' + params);
      if (current !== requestId || panel.hidden) return;
      lastPage = Math.max(1, Math.ceil(data.total / data.page_size));
      if (page > lastPage) {
        page = lastPage;
        return await load();
      }
      renderRows(data.users);
      setMessage($('#admin-users-empty'), data.users.length ? '' : '暂无匹配的用户。');
      $('#admin-users-page').textContent = '第 ' + page + ' / ' + lastPage + ' 页 · ' + data.total + ' 名用户';
      previous.disabled = page <= 1;
      next.disabled = page >= lastPage;
    } catch (error) {
      if (current !== requestId || panel.hidden) return;
      setMessage($('#admin-users-empty'), '');
      setMessage($('#admin-users-error'), error.message);
    }
  }

  $('#admin-users-search-form').addEventListener('submit', event => {
    event.preventDefault();
    query = $('#admin-users-search').value.trim();
    page = 1;
    void load();
  });
  previous.addEventListener('click', () => { page -= 1; void load(); });
  next.addEventListener('click', () => { page += 1; void load(); });

  return {
    load,
    reset() {
      requestId += 1;
      rows.replaceChildren();
      if (dialog.open) dialog.close();
      page = 1;
      query = '';
      $('#admin-users-search').value = '';
    },
  };
}
