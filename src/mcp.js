import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { z } from 'zod';

const maxFile = 4 * 1024 * 1024;
const maxBase64 = 4 * Math.ceil(maxFile / 3);
export const maxMcpBody = 6 * 1024 * 1024;
const sharingOptions = {
  expires_in: z.number().int().min(1).max(365 * 86400).nullable().optional()
    .describe('Seconds until expiration. Null means no expiry. Omit to keep the current expiry when editing an active share.'),
  password: z.string().min(4).max(64).nullable().optional()
    .describe('Optional password recipients must enter. Null clears it. Omit to keep the current password when editing.'),
};

export async function handleMcp(request, parsedBody, services) {
  const server = new McpServer(
    { name: 'folio-dock', version: '1.0.0' },
    { instructions: 'Upload and manage your own documents. Uploads are private by default. Enable link sharing only when requested.' },
  );
  const result = operation => async input => {
    try {
      const data = await operation(input);
      return { structuredContent: data, content: [{ type: 'text', text: JSON.stringify(data) }] };
    } catch (error) {
      return { isError: true, content: [{ type: 'text', text: services.errorMessage(error) }] };
    }
  };

  server.registerTool('list_documents', {
    description: 'List your documents and any active share URLs, sorted by most recent upload.',
    annotations: { readOnlyHint: true, openWorldHint: false },
    inputSchema: z.object({
      query: z.string().max(120).default('').describe('Optional filename substring.'),
      limit: z.number().int().min(1).max(100).default(25),
    }),
  }, result(({ query, limit }) => services.list(query, limit)));

  server.registerTool('upload_document', {
    description: 'Upload HTML, Markdown, TXT, PDF, images, MHTML or Excel, Word and PowerPoint documents. Uploads are private unless share is true.',
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    inputSchema: z.object({
      filename: z.string().min(1).max(180).describe('File name including its original extension, such as .png, .mhtml, .xlsx, .docx or .pptx.'),
      text: z.string().min(1).max(maxFile).optional().describe('Raw HTML, Markdown or text. Supply either text or base64.'),
      base64: z.string().min(1).max(maxBase64).optional().describe('Base64-encoded original file. Required for PDF, images and Office files. Maximum 4 MB after decode.'),
      share: z.boolean().default(false).describe('Create a share link and share code. Defaults to false.'),
      ...sharingOptions,
    }).refine(input => (input.text === undefined) !== (input.base64 === undefined), 'Provide either text or base64.'),
  }, result(services.upload));

  server.registerTool('set_document_sharing', {
    description: 'Create or update a share link and code with an optional password and expiry. Disable to revoke both.',
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    inputSchema: z.object({
      document_id: z.string().regex(/^[a-f0-9]{32}$/).describe('Document ID from list_documents or upload_document.'),
      enabled: z.boolean(),
      ...sharingOptions,
    }),
  }, result(services.share));

  const transport = new WebStandardStreamableHTTPServerTransport({ enableJsonResponse: true });
  await server.connect(transport);
  try {
    return await transport.handleRequest(request, { parsedBody });
  } finally {
    await server.close();
  }
}
