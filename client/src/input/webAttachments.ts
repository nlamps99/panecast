import type { AttachmentFile } from './fileAttachments';

export type AttachmentEvents = {
  enabled: boolean;
  files(files: AttachmentFile[]): void;
  error(message: string): void;
};

/** Native platforms continue to use their photo picker. */
export function useWebAttachments(_events: AttachmentEvents): boolean { return false; }
export async function pickFiles(): Promise<AttachmentFile[]> { return []; }
