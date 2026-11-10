import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { encodeImage } from './attachImage';
import { AttachmentError } from './attachments';
import type { AttachmentFile } from './fileAttachments';
import type { AttachmentEvents } from './webAttachments';

const scope = '#panecast-terminal, #panecast-expanded-composer';
const inside = (target: EventTarget | null) => target instanceof Element && Boolean(target.closest(scope));

export function browserFile(file: File): AttachmentFile {
  return { name: file.name || 'clipboard-image.png', mimeType: file.type, size: file.size,
    readBase64: () => new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(new AttachmentError(`无法读取“${file.name}”`));
      reader.onload = () => {
        const data = typeof reader.result === 'string' ? reader.result : '';
        const separator = data.indexOf(',');
        if (separator < 0) reject(new AttachmentError(`无法读取“${file.name}”`));
        else resolve(data.slice(separator + 1));
      };
      reader.readAsDataURL(file);
    }),
    ...(file.type.startsWith('image/') ? { compressImage: async (budget: number) => {
      const url = URL.createObjectURL(file);
      try { return await encodeImage(url, budget); } finally { URL.revokeObjectURL(url); }
    } } : {}),
  };
}

/** Files are supplied by WebKit's user gesture, without native filesystem access. */
export function transferredFiles(data: DataTransfer): File[] {
  const items = Array.from(data.items ?? []);
  if (items.some(item => item.kind === 'file' && item.webkitGetAsEntry?.()?.isDirectory)) {
    throw new AttachmentError('请先把文件夹压缩成 ZIP，再上传');
  }
  return data.files?.length ? Array.from(data.files) : items.filter(item => item.kind === 'file').flatMap(item => {
    const file = item.getAsFile(); return file ? [file] : [];
  });
}

export function bindAttachmentEvents(events: () => AttachmentEvents, dragging: (active: boolean) => void): () => void {
  const hasFiles = (data: DataTransfer | null) => data && (Array.from(data.types ?? []).includes('Files') || data.files?.length || Array.from(data.items ?? []).some(item => item.kind === 'file'));
  const accept = (data: DataTransfer) => {
    const current = events();
    if (!current.enabled) { current.error('当前暂时无法上传，请等待连接或上传完成后重试'); return; }
    try { const files = transferredFiles(data); if (files.length) current.files(files.map(browserFile)); }
    catch (error) { current.error(error instanceof Error ? error.message : '无法读取附件'); }
  };
  const over = (event: DragEvent) => {
    if (!hasFiles(event.dataTransfer)) return;
    event.preventDefault();
    const available = inside(event.target) && events().enabled;
    if (event.dataTransfer) event.dataTransfer.dropEffect = available ? 'copy' : 'none';
    dragging(available);
  };
  const leave = (event: DragEvent) => { if (!inside(event.relatedTarget)) dragging(false); };
  const drop = (event: DragEvent) => {
    dragging(false);
    if (!hasFiles(event.dataTransfer)) return;
    // A file drop must never navigate the app to a local document.
    event.preventDefault();
    if (inside(event.target) && event.dataTransfer) accept(event.dataTransfer);
  };
  const paste = (event: ClipboardEvent) => {
    if (event.defaultPrevented || !inside(event.target) || !(event.target instanceof HTMLTextAreaElement) || !hasFiles(event.clipboardData)) return;
    event.preventDefault();
    if (event.clipboardData) accept(event.clipboardData);
  };
  document.addEventListener('dragover', over); document.addEventListener('dragleave', leave);
  document.addEventListener('drop', drop); document.addEventListener('paste', paste);
  return () => {
    document.removeEventListener('dragover', over); document.removeEventListener('dragleave', leave);
    document.removeEventListener('drop', drop); document.removeEventListener('paste', paste);
  };
}

export function useWebAttachments(events: AttachmentEvents): boolean {
  const latest = useRef(events);
  useLayoutEffect(() => { latest.current = events; }, [events]);
  const [dragging, setDragging] = useState(false);
  useEffect(() => bindAttachmentEvents(() => latest.current, setDragging), []);
  return dragging;
}

export function pickFiles(): Promise<AttachmentFile[]> {
  return new Promise(resolve => {
    const input = document.createElement('input'); input.type = 'file'; input.multiple = true; input.hidden = true;
    const finish = () => { const files = Array.from(input.files ?? []).map(browserFile); input.remove(); resolve(files); };
    input.addEventListener('change', finish, { once: true }); input.addEventListener('cancel', finish, { once: true });
    document.body.appendChild(input); input.click();
  });
}
