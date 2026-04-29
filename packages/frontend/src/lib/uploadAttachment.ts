import { API_BASE } from './backendUrl';

export interface UploadResult {
  filename: string;
  relativePath: string;
  url: string;
  mimetype: string;
  size: number;
}

/**
 * 上传附件。可选 boxId —— 如果 vault 设置 attachmentPolicy === 'per-box'，
 * 后端会落到 attachments/<boxId>/ 子目录里。
 */
export async function uploadAttachment(file: File, boxId?: string | null): Promise<UploadResult> {
  const fd = new FormData();
  fd.append('file', file, file.name);
  const url = boxId
    ? `${API_BASE}/attachments?boxId=${encodeURIComponent(boxId)}`
    : `${API_BASE}/attachments`;
  const res = await fetch(url, {
    method: 'POST',
    body: fd,
  });
  if (!res.ok) {
    throw new Error(`upload failed: ${res.status} ${res.statusText}`);
  }
  return res.json();
}

export function isImage(mime: string | undefined): boolean {
  return !!mime && mime.startsWith('image/');
}

export function makeMarkdownInsert(result: UploadResult): string {
  const alt = result.filename.replace(/\.[^.]+$/, '');
  if (isImage(result.mimetype)) {
    return `![${alt}](${result.relativePath})`;
  }
  return `[${result.filename}](${result.relativePath})`;
}
