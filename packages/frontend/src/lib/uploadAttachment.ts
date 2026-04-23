export interface UploadResult {
  filename: string;
  relativePath: string;
  url: string;
  mimetype: string;
  size: number;
}

export async function uploadAttachment(file: File): Promise<UploadResult> {
  const fd = new FormData();
  fd.append('file', file, file.name);
  const res = await fetch('/api/attachments', {
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
