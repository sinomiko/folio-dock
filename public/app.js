import { setupManagement } from './management.js';
import { formatShareCode, normalizeShareCode } from './share-code.js';

const $ = selector => document.querySelector(selector);
const workspace = $('#workspace');
const viewer = $('#viewer');
const authDialog = $('#auth-dialog');
const shareDialog = $('#share-dialog');
const codeDialog = $('#code-dialog');
const deleteDialog = $('#delete-dialog');
const fileInput = $('#file-input');
const dropZone = $('#drop-zone');
const images = new Set(['png', 'jpg', 'gif', 'webp', 'avif', 'bmp', 'svg']);
const officePreviews = new Set(['xlsx', 'docx', 'pptx']);
const previewMessages = {
  html: 'HTML 预览在隔离框架中运行，适用于单文件 HTML。',
  mhtml: '预览归档中的网页快照、图片和样式。脚本和外部资源会被阻止。',
  xlsx: '预览工作表及单元格内容。请下载原文件查看完整格式、图表或计算公式。',
  docx: '按原文档版式预览，字体和分页可能随浏览器有所变化。',
  pptx: '按原幻灯片画布预览，动画和转场以静态画面显示。',
  xls: '此旧版 Excel 文件可下载后打开。',
  doc: '此旧版 Word 文件可下载后打开。',
  ppt: '此旧版 PowerPoint 文件可下载后打开。',
};
const downloadOnly = new Set(['xls', 'doc', 'ppt']);
const dateFormat = new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: 'short', day: 'numeric' });
const expiryFormat = new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'short' });
const pathMatch = location.pathname.match(/^\/(document|share)\/([a-f0-9]+)\/?$/);
const isShare = pathMatch?.[1] === 'share';
const isAdminPage = /^\/admin\/?$/.test(location.pathname);
const isWorkspace = !pathMatch && !isAdminPage;

let username = null;
let isAdmin = false;
let sessionReady = false;
let documents = [];
let listLoading = false;
let listError = '';
let uploading = false;
let authMode = 'login';
let selectedShare = null;
let selectedDelete = null;
let openDocument = null;
let toastTimer;
let sessionGeneration = 0;

async function api(path, options = {}) {
  const { method = 'GET', json, body, headers: extraHeaders } = options;
  const headers = new Headers(extraHeaders);
  if (method !== 'GET') headers.set('X-Folio-Action', '1');
  if (json !== undefined) headers.set('Content-Type', 'application/json');
  const response = await fetch(path, {
    method,
    headers,
    body: json === undefined ? body : JSON.stringify(json),
    credentials: 'same-origin',
    cache: 'no-store',
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data.error || '操作失败，请稍后重试。');
    error.status = response.status;
    error.code = data.code;
    throw error;
  }
  return data;
}

function setMessage(element, message) {
  element.textContent = message;
  element.hidden = !message;
}

function toast(message) {
  const element = $('#toast');
  window.clearTimeout(toastTimer);
  setMessage(element, message);
  toastTimer = window.setTimeout(() => setMessage(element, ''), 3200);
}

function prettySize(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

function setIcon(icon, format) {
  icon.textContent = format.toUpperCase();
  icon.dataset.format = format;
}

function showDocumentPreview(document, endpoint) {
  const { name, format } = document;
  setMessage($('#viewer-warning'), previewMessages[format] || '');
  if (downloadOnly.has(format)) return;
  const preview = $('#preview');
  if (images.has(format)) {
    const image = window.document.createElement('img');
    image.alt = name;
    image.addEventListener('error', () => setMessage($('#viewer-error'), '图片无法预览，可下载原文件查看。'));
    image.src = endpoint + '/preview';
    preview.replaceChildren(image);
    return;
  }

  const frame = window.document.createElement('iframe');
  frame.title = name + ' · 文档预览';
  if (format !== 'pdf' && format !== 'mhtml' && !officePreviews.has(format)) {
    frame.setAttribute('sandbox', format === 'html' ? 'allow-scripts' : '');
  }
  frame.referrerPolicy = 'no-referrer';
  frame.src = endpoint + '/preview';
  preview.replaceChildren(frame);
}

function dateText(seconds) {
  return dateFormat.format(new Date(seconds * 1000));
}

function renderAccount() {
  $('#account').hidden = !username;
  $('#account').textContent = username ?? '';
  $('#login').hidden = !sessionReady || Boolean(username);
  $('#register').hidden = !sessionReady || Boolean(username);
  $('#logout').hidden = !username;
  $('#admin-link').hidden = !isAdmin || !isWorkspace;
  $('#mcp-open').hidden = !username || !isWorkspace;
  $('#logout').disabled = uploading;
  $('#hero-upload').disabled = !sessionReady || uploading;
  $('#pick-files').disabled = !sessionReady || uploading;
}

function showEmpty(title, detail, action, handler) {
  $('#empty').hidden = false;
  $('#document-table').hidden = true;
  $('#empty-title').textContent = title;
  $('#empty-detail').textContent = detail;
  const button = $('#empty-action');
  button.hidden = !action;
  button.textContent = action ?? '';
  button.onclick = handler ?? null;
}

function hasActiveShare(document) {
  return Boolean(document.share_token) && (!document.share_expires_at || document.share_expires_at * 1000 > Date.now());
}

function renderDocuments() {
  $('#filters').hidden = !username || !documents.length;
  $('#library-count').textContent = username && !listLoading && !listError ? documents.length + ' 份文档' : '';
  if (!sessionReady || listLoading) return showEmpty('正在加载文档', '');
  if (!username) return showEmpty('登录后查看文档', '上传的文件会保存在你的工作台。', '登录', () => showAuth('login'));
  if (listError) return showEmpty('暂时无法加载文档', listError, '重试', refreshDocuments);
  if (!documents.length) return showEmpty('还没有文档', '上传你的第一份 AI 文档。', '选择文件', chooseFiles);

  const query = $('#search').value.trim().toLocaleLowerCase();
  const filter = $('#filter').value;
  const visible = documents.filter(document =>
    document.name.toLocaleLowerCase().includes(query) &&
    (filter === 'all' || hasActiveShare(document) === (filter === 'shared')),
  );
  if (!visible.length) return showEmpty('没有匹配的文档', '试试其他搜索词或分享状态。');

  const container = $('#documents');
  const rows = visible.map(document => {
    const row = $('#row-template').content.firstElementChild.cloneNode(true);
    row.querySelector('[data-view]').href = '/document/' + document.id;
    setIcon(row.querySelector('.file-icon'), document.format);
    row.querySelector('strong').textContent = document.name;
    row.querySelector('strong').title = document.name;
    row.querySelector('small').textContent = prettySize(document.size);
    const status = row.querySelector('.visibility');
    const active = hasActiveShare(document);
    status.textContent = active ? '已分享' : document.share_token ? '分享已过期' : '私有';
    status.classList.toggle('shared', active);
    const time = row.querySelector('time');
    time.dateTime = new Date(document.created_at * 1000).toISOString();
    time.textContent = dateText(document.created_at);
    const shareButton = row.querySelector('[data-share]');
    shareButton.setAttribute('aria-label', '分享 ' + document.name);
    shareButton.addEventListener('click', () => showShare(document));
    const deleteButton = row.querySelector('[data-delete]');
    deleteButton.setAttribute('aria-label', '删除 ' + document.name);
    deleteButton.addEventListener('click', () => showDelete(document));
    return row;
  });
  container.replaceChildren(...rows);
  $('#empty').hidden = true;
  $('#document-table').hidden = false;
}

async function refreshDocuments() {
  const generation = sessionGeneration;
  if (!username || !isWorkspace) return;
  listLoading = true;
  listError = '';
  renderDocuments();
  try {
    const result = await api('/api/documents');
    if (generation === sessionGeneration) documents = result.documents;
  } catch (error) {
    if (generation === sessionGeneration) {
      if (error.status === 401) setAccount(null);
      else listError = error.message;
    }
  } finally {
    if (generation === sessionGeneration) {
      listLoading = false;
      renderDocuments();
    }
  }
}

function setAccount(account) {
  username = account?.username ?? null;
  isAdmin = Boolean(account?.is_admin);
  sessionReady = true;
  sessionGeneration += 1;
  documents = [];
  listLoading = false;
  listError = '';
  $('#search').value = '';
  $('#filter').value = 'all';
  renderAccount();
  management.accountChanged(username, isAdmin);
  if (isWorkspace) {
    if (username) void refreshDocuments();
    else renderDocuments();
  }
}

function showAuth(mode) {
  authMode = mode;
  const register = mode === 'register';
  const form = $('#auth-form');
  $('#auth-title').textContent = register ? '注册' : '登录';
  $('#auth-intro').textContent = register ? '使用邀请码创建你的文档工作台。' : '登录后上传、预览和分享你的 AI 文档。';
  $('#auth-submit').textContent = register ? '注册并登录' : '登录';
  $('#auth-switch').textContent = register ? '已有账户？登录' : '有邀请码？注册';
  $('#invite-label').hidden = !register;
  form.elements.invite.required = register;
  form.elements.password.autocomplete = register ? 'new-password' : 'current-password';
  setMessage($('#auth-error'), '');
  if (!authDialog.open) {
    form.reset();
    authDialog.showModal();
    form.elements.username.focus();
  }
}

function chooseFiles() {
  if (uploading || !sessionReady) return;
  if (!username) return showAuth('login');
  fileInput.click();
}

async function uploadFiles(files) {
  if (uploading || !files.length || !sessionReady) return;
  if (!username) return showAuth('login');
  uploading = true;
  renderAccount();
  const status = $('#upload-status');
  const failures = [];
  let uploaded = 0;
  status.classList.remove('error');
  for (const [index, file] of files.entries()) {
    setMessage(status, '正在上传 ' + (index + 1) + ' / ' + files.length + ' · ' + file.name);
    try {
      await api('/api/documents', {
        method: 'POST',
        headers: { 'X-Folio-Filename': encodeURIComponent(file.name) },
        body: file,
      });
      uploaded += 1;
    } catch (error) {
      failures.push(file.name + ' · ' + error.message);
      if (error.status === 401) {
        setAccount(null);
        break;
      }
    }
  }
  uploading = false;
  renderAccount();
  status.classList.toggle('error', Boolean(failures.length));
  setMessage(status, failures.join('\n'));
  if (uploaded) {
    toast('已上传 ' + uploaded + ' 份文档');
    await refreshDocuments();
  }
}

function renderShare() {
  const active = hasActiveShare(selectedShare);
  const expired = Boolean(selectedShare.share_token) && !active;
  $('#share-name').textContent = selectedShare.name;
  if (active) {
    const expiry = selectedShare.share_expires_at ? '有效至 ' + expiryFormat.format(selectedShare.share_expires_at * 1000) : '永久有效';
    $('#share-detail').textContent = expiry + (selectedShare.share_requires_password ? ' · 访问需验证口令' : ' · 可直接访问');
  } else {
    $('#share-detail').textContent = expired ? '分享已过期。设置有效期后可生成新的链接和分享码。' :
      '开启后可发送链接，或请接收方在首页输入分享码。';
  }
  $('#share-box').hidden = !active;
  $('#share-link').value = active ? new URL('/share/' + selectedShare.share_token, location.origin).href : '';
  $('#share-code').value = active ? formatShareCode(selectedShare.share_token) : '';
  $('#share-copy').textContent = '复制链接';
  $('#share-copy-code').textContent = '复制分享码';
  $('#share-expiry option[value="keep"]').hidden = !active;
  $('#share-expiry').value = active ? 'keep' : 'never';
  $('#share-password-mode option[value="keep"]').hidden = !selectedShare.share_requires_password;
  $('#share-password-mode').value = selectedShare.share_requires_password ? 'keep' : 'none';
  $('#share-password').value = '';
  updatePasswordField();
  $('#share-stop').hidden = !selectedShare.share_token;
  $('#share-toggle').textContent = active ? '保存分享设置' : expired ? '重新开启分享' : '开启链接分享';
}

function updatePasswordField() {
  const needsPassword = $('#share-password-mode').value === 'set';
  $('#share-password-label').hidden = !needsPassword;
  $('#share-password').required = needsPassword;
}

function showShare(document) {
  selectedShare = document;
  setMessage($('#share-error'), '');
  renderShare();
  shareDialog.showModal();
}

function showDelete(document) {
  selectedDelete = document;
  $('#delete-name').textContent = document.name;
  setMessage($('#delete-error'), '');
  deleteDialog.showModal();
}

async function showViewer() {
  const [, kind, id] = pathMatch;
  const endpoint = (kind === 'share' ? '/api/shared/' : '/api/documents/') + id;
  $('#viewer-back').textContent = isShare ? '‹ Folio Dock' : '‹ 返回工作台';
  $('#viewer-actions').hidden = true;
  $('#viewer-warning').hidden = true;
  $('#verify-share').hidden = true;
  $('#viewer-title').textContent = '正在打开文档…';
  setMessage($('#viewer-error'), '');
  $('#preview').replaceChildren();

  try {
    const { document } = await api(endpoint);
    openDocument = document;
    $('#viewer-title').textContent = document.name;
    window.document.title = document.name + ' · Folio Dock';
    setIcon($('#viewer-icon'), document.format);
    $('#viewer-meta').textContent = document.format.toUpperCase() + ' · ' + prettySize(document.size) + ' · ' + dateText(document.created_at);
    $('#viewer-download').href = endpoint + '/download';
    $('#viewer-share').hidden = isShare;
    showDocumentPreview(document, endpoint);
    $('#viewer-actions').hidden = false;
  } catch (error) {
    if (isShare && error.code === 'share_password_required') {
      $('#viewer-title').textContent = '此分享需要口令';
      $('#verify-share').reset();
      setMessage($('#verify-error'), '');
      $('#verify-share').hidden = false;
      $('#verify-password').focus();
      return;
    }
    $('#viewer-title').textContent = '无法打开文档';
    setMessage($('#viewer-error'), error.message);
  }
}

for (const button of document.querySelectorAll('[data-close]')) {
  button.addEventListener('click', () => $('#' + button.dataset.close).close());
}
$('#login').addEventListener('click', () => showAuth('login'));
$('#register').addEventListener('click', () => showAuth('register'));
$('#auth-switch').addEventListener('click', () => showAuth(authMode === 'login' ? 'register' : 'login'));
$('#hero-upload').addEventListener('click', chooseFiles);
$('#open-code').addEventListener('click', () => {
  $('#code-form').reset();
  setMessage($('#code-error'), '');
  codeDialog.showModal();
  $('#code-value').focus();
});
$('#code-form').addEventListener('submit', async event => {
  event.preventDefault();
  const code = normalizeShareCode($('#code-value').value);
  if (!code) return setMessage($('#code-error'), '请输入 16 位分享码。');
  const button = $('#code-submit');
  button.disabled = true;
  setMessage($('#code-error'), '');
  try {
    const { path } = await api('/api/share-code', { method: 'POST', json: { code } });
    if (codeDialog.open) location.assign(path);
  } catch (error) {
    setMessage($('#code-error'), error.message);
  } finally {
    button.disabled = false;
  }
});
$('#verify-share').addEventListener('submit', async event => {
  event.preventDefault();
  const button = $('#verify-submit');
  button.disabled = true;
  setMessage($('#verify-error'), '');
  try {
    await api('/api/shared/' + pathMatch[2] + '/verify', {
      method: 'POST', json: { password: $('#verify-password').value },
    });
    await showViewer();
  } catch (error) {
    setMessage($('#verify-error'), error.message);
  } finally {
    button.disabled = false;
  }
});
$('#pick-files').addEventListener('click', chooseFiles);
$('#search').addEventListener('input', renderDocuments);
$('#filter').addEventListener('change', renderDocuments);
$('#viewer-share').addEventListener('click', () => showShare(openDocument));
fileInput.addEventListener('change', () => {
  const files = Array.from(fileInput.files);
  fileInput.value = '';
  void uploadFiles(files);
});

let dragDepth = 0;
dropZone.addEventListener('dragenter', event => {
  if (!event.dataTransfer.types.includes('Files')) return;
  event.preventDefault();
  dragDepth += 1;
  dropZone.classList.add('is-dragging');
});
dropZone.addEventListener('dragover', event => {
  if (!event.dataTransfer.types.includes('Files')) return;
  event.preventDefault();
  event.dataTransfer.dropEffect = 'copy';
});
dropZone.addEventListener('dragleave', () => {
  dragDepth = Math.max(0, dragDepth - 1);
  dropZone.classList.toggle('is-dragging', dragDepth > 0);
});
dropZone.addEventListener('drop', event => {
  event.preventDefault();
  dragDepth = 0;
  dropZone.classList.remove('is-dragging');
  void uploadFiles(Array.from(event.dataTransfer.files));
});

$('#auth-form').addEventListener('submit', async event => {
  event.preventDefault();
  const submit = $('#auth-submit');
  const switchMode = $('#auth-switch');
  const input = Object.fromEntries(new FormData(event.currentTarget));
  submit.disabled = true;
  switchMode.disabled = true;
  setMessage($('#auth-error'), '');
  try {
    const result = await api('/api/' + authMode, { method: 'POST', json: input });
    setAccount(result);
    authDialog.close();
    if (pathMatch && !isShare) await showViewer();
    toast('已登录');
  } catch (error) {
    setMessage($('#auth-error'), error.message);
  } finally {
    submit.disabled = false;
    switchMode.disabled = false;
  }
});

$('#logout').addEventListener('click', async event => {
  const button = event.currentTarget;
  button.disabled = true;
  try {
    await api('/api/logout', { method: 'POST' });
    setAccount(null);
    if (pathMatch && !isShare) location.assign('/');
    else toast('已退出登录');
  } catch (error) {
    toast(error.message);
  } finally {
    button.disabled = false;
  }
});

async function saveShare(settings) {
  const target = selectedShare;
  const buttons = [$('#share-stop'), $('#share-toggle')];
  for (const button of buttons) button.disabled = true;
  setMessage($('#share-error'), '');
  try {
    const result = await api('/api/documents/' + target.id + '/share', { method: 'PATCH', json: settings });
    Object.assign(target, result);
    if (selectedShare === target) renderShare();
    if (!pathMatch) renderDocuments();
  } catch (error) {
    if (selectedShare === target) setMessage($('#share-error'), error.message);
  } finally {
    for (const button of buttons) button.disabled = false;
  }
}

$('#share-settings').addEventListener('submit', event => {
  event.preventDefault();
  const settings = { enabled: true };
  const expiry = $('#share-expiry').value;
  const passwordMode = $('#share-password-mode').value;
  if (expiry !== 'keep') settings.expires_in = expiry === 'never' ? null : Number(expiry);
  if (passwordMode !== 'keep') settings.password = passwordMode === 'set' ? $('#share-password').value : null;
  void saveShare(settings);
});
$('#share-stop').addEventListener('click', () => saveShare({ enabled: false }));
$('#share-password-mode').addEventListener('change', updatePasswordField);

async function copyShare(event, selector) {
  const button = event.currentTarget;
  const input = $(selector);
  try {
    await navigator.clipboard.writeText(input.value);
    button.textContent = '已复制';
  } catch {
    input.focus();
    input.select();
    setMessage($('#share-error'), '内容已选中，可以手动复制。');
  }
}
$('#share-copy').addEventListener('click', event => copyShare(event, '#share-link'));
$('#share-copy-code').addEventListener('click', event => copyShare(event, '#share-code'));

$('#delete-confirm').addEventListener('click', async event => {
  const button = event.currentTarget;
  const target = selectedDelete;
  button.disabled = true;
  setMessage($('#delete-error'), '');
  try {
    await api('/api/documents/' + target.id, { method: 'DELETE' });
    documents = documents.filter(document => document.id !== target.id);
    if (selectedDelete === target) deleteDialog.close();
    renderDocuments();
    toast('文档已删除');
  } catch (error) {
    if (selectedDelete === target) setMessage($('#delete-error'), error.message);
  } finally {
    button.disabled = false;
  }
});

const management = setupManagement({
  api, setMessage, toast, prettySize, dateText, isAdminPage,
  login: () => showAuth('login'),
  activate: () => setAccount({ username, is_admin: true }),
});

workspace.hidden = !isWorkspace;
viewer.hidden = !pathMatch;
$('#admin').hidden = !isAdminPage;
if (pathMatch) void showViewer();
api('/api/session').then(setAccount).catch(error => {
  setAccount(null);
  toast(error.message);
});
