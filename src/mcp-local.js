import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, isAbsolute, join } from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { formats, formatForFilename } from './formats.js';
import { mcpShareHeader, mcpUploadPath, sharingOptions } from './mcp.js';

function uploadEndpoint(value) {
  const site = value && URL.canParse(value) ? new URL(value) : null;
  const loopback = site?.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(site.hostname);
  if (!site || (site.protocol !== 'https:' && !loopback) || site.username || site.password ||
      site.pathname !== '/' || site.search || site.hash) {
    throw new Error('请将 FOLIO_SITE_URL 设为 Folio Dock 的站点根地址。');
  }
  return new URL(mcpUploadPath, site);
}

async function uploadLocalFile(input, signal) {
  const endpoint = uploadEndpoint(process.env.FOLIO_SITE_URL);
  const token = process.env.FOLIO_MCP_TOKEN?.trim();
  if (!/^fd_[a-f0-9]{64}$/.test(token ?? '')) {
    throw new Error('请在本机配置中设置有效的 FOLIO_MCP_TOKEN。');
  }

  const { path, ...settings } = input;
  const localPath = path.startsWith('~/') ? join(homedir(), path.slice(2)) : path;
  if (!isAbsolute(localPath) || localPath.includes('\0')) throw new Error('请输入本地文件的绝对路径。');

  let file;
  let stream;
  try {
    file = await open(localPath, constants.O_RDONLY | constants.O_NONBLOCK);
    const fileInfo = await file.stat();
    if (!fileInfo.isFile()) throw new Error('请选择一个普通文件。');
    const { size } = fileInfo;
    const filename = basename(localPath);
    const format = formatForFilename(filename);
    if (!format) throw new Error('此文件格式不受支持。');
    if (!size) throw new Error('文件为空。');
    if (size > formats[format].max) throw new Error('文件超出大小限制。');

    stream = file.createReadStream({ start: 0, end: size - 1, autoClose: false });
    const response = await fetch(endpoint, {
      method: 'PUT',
      headers: {
        Authorization: 'Bearer ' + token,
        'Content-Type': 'application/octet-stream',
        'Content-Length': String(size),
        'X-Folio-Filename': encodeURIComponent(filename),
        [mcpShareHeader]: encodeURIComponent(JSON.stringify(settings)),
      },
      body: stream,
      duplex: 'half',
      redirect: 'error',
      signal,
    });
    const result = await response.json().catch(() => null);
    if (!response.ok) throw new Error(result?.error || '上传失败，HTTP ' + response.status + '。');
    const document = result?.document;
    if (!document?.share_url) throw new Error('站点未返回分享链接，请在 Folio Dock 工作台查看上传结果。');
    return document;
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') throw new Error('找不到这个本地文件。');
    if (error.code === 'EACCES' || error.code === 'EPERM') throw new Error('没有权限读取这个本地文件。');
    if (signal.aborted) throw new Error('上传已取消。');
    if (error instanceof TypeError) throw new Error('无法完成上传，请检查站点连接或文件是否在上传时被修改。');
    throw error;
  } finally {
    stream?.destroy();
    await file?.close().catch(() => {});
  }
}

const server = new McpServer(
  { name: 'folio-dock-local', version: '1.0.0' },
  { instructions: 'Upload and share files from this machine using paths explicitly supplied by the user.' },
);

server.registerTool('upload_local_file', {
  description: 'Stream a local file to Folio Dock and create a share link and share code in one call. Use only when the user asks to share the selected file.',
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  inputSchema: z.object({
    path: z.string().min(1).describe('Absolute path on this machine, or a path starting with ~/.'),
    password: sharingOptions.password.describe('Optional sharing password. Omit for a link without a password.'),
    expires_in: sharingOptions.expires_in.describe('Optional lifetime in seconds, up to 365 days. Omit for no expiration.'),
  }),
}, async (input, { signal }) => {
  try {
    const document = await uploadLocalFile(input, signal);
    return { structuredContent: document, content: [{ type: 'text', text: JSON.stringify(document) }] };
  } catch (error) {
    return { isError: true, content: [{ type: 'text', text: error.message }] };
  }
});

await server.connect(new StdioServerTransport());
