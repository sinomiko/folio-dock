# Folio Dock

Folio Dock 是一款可自建的文档上传、在线预览和分享工具。它运行在 Cloudflare Workers，文件存放于私有 R2 存储桶，账号、文档索引和分享设置存放于 D1。

- 上传 HTML、Markdown、PDF、TXT、图片、MHTML、Excel、Word 和 PowerPoint。
- 通过链接或分享码免登录分享，可设置访问口令和有效期。关闭分享会同时撤销两个入口。
- 通过 MCP 上传文件、查询自己的文档和管理分享。
- 在后台管理用户和文档。管理员可添加普通用户、重置密码、禁用、恢复和删除账号。

## 界面截图

![文档工作台与分享入口](docs/screenshots/workspace.png)

![后台用户列表与管理操作](docs/screenshots/admin.png)

## 在线预览

图片支持 PNG、JPEG、GIF、WebP、AVIF、BMP 和 SVG。MHTML 显示归档中的网页、图片和样式。Excel（.xlsx）可切换工作表并查看单元格。Word（.docx）按文档版式显示页面、表格、页眉和页脚，字体和分页可能随浏览器变化。PowerPoint（.pptx）按幻灯片画布显示文字、形状和图片，动画和转场以静态画面显示。旧版 .xls、.doc、.ppt 支持上传、分享和下载。

可在线查看的文件支持「全屏预览」，包括免登录分享页。浏览器无法进入系统全屏时，预览会铺满当前页面。

网页版单文件上限为 15 MB，Markdown 为 1 MB，TXT 为 2 MB。每个账号最多存放 100 份文件，合计 150 MB。MCP 单文件上限为 4 MB，并遵循各格式上限。

## 本地运行

需要 Node.js 22 或更高版本。

    npm ci
    cp .dev.vars.example .dev.vars
    npm run db:local
    npm run dev

在启动前为 .dev.vars 中的 INVITE_CODE、ADMIN_SETUP_CODE 和 PASSWORD_PEPPER 各填入一个独立的随机值。可分别用 openssl rand -hex 32 生成三个值。

打开 Wrangler 显示的本地地址，用邀请码注册。在 /admin 输入管理员激活码完成首次设置。管理员可点击「添加用户」，设置用户名和至少 12 位的登录密码。后台创建的普通用户可用该账号直接登录。

在「用户管理」中可以搜索用户、重置密码、禁用、恢复和删除普通账号。重置密码会结束现有会话并撤销 MCP 令牌。禁用还会暂停该用户的文档分享，恢复后有效的分享可以继续访问。删除账号会永久移除其文档和分享。

## 部署到 Cloudflare

登录 Wrangler，创建自己的 D1 数据库和私有 R2 存储桶。以下资源名可按需替换。

    npx wrangler login
    npx wrangler d1 create my-folio-dock
    npx wrangler r2 bucket create my-folio-dock-files
    cp wrangler.jsonc wrangler.local.jsonc

在 wrangler.local.jsonc 中填写数据库名、数据库 ID 和存储桶名。若账号中多个 Worker 共享速率限制命名空间，请为本实例选择单独的 namespace_id。自定义域名可作为 Worker Custom Domain 添加到 routes。

为生产环境单独创建 .env.production，其中包含 INVITE_CODE、ADMIN_SETUP_CODE 和 PASSWORD_PEPPER。PASSWORD_PEPPER 参与现有账号及分享口令的验证，部署更新时应保留同一个值。

    npx wrangler d1 migrations apply DB --remote --config wrangler.local.jsonc
    npx wrangler deploy --config wrangler.local.jsonc --secrets-file .env.production

部署成功后，打开 Wrangler 输出的站点地址。更新版本时使用相同的私有配置，先应用数据库迁移，再执行部署。

## MCP

登录站点，在工作台选择「MCP 接入」生成令牌。客户端使用 Streamable HTTP 连接站点的 /mcp 端点，并通过 Authorization 请求头发送 Bearer 令牌。令牌只显示一次，重新生成或撤销后旧令牌会失效。

| 工具 | 用途 |
| --- | --- |
| list_documents | 列出自己的文档、可用分享链接和分享码。 |
| upload_document | 上传原始文件。二进制文件使用 base64。share 默认关闭。 |
| set_document_sharing | 通过文档 ID 创建、修改或关闭分享，可设置 password 和 expires_in。 |

expires_in 以秒为单位。修改正在生效的分享时，省略 password 或 expires_in 可保留原设置，传入 null 可移除对应限制。

## 许可证

本项目采用 [MIT 许可证](LICENSE)。依赖项使用各自的许可证。
