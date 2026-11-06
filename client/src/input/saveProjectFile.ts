import { File, Paths } from 'expo-file-system';
import * as Sharing from 'expo-sharing';
import { Platform } from 'react-native';

export type ProjectFile = { name: string; mime_type: string; size: number; data_base64: string; text?: string };
export function parseProjectFile(value: unknown): ProjectFile {
  if (!value || typeof value !== 'object') throw new Error('文件响应格式不正确');
  const v = value as Partial<ProjectFile>;
  if (typeof v.name !== 'string' || typeof v.mime_type !== 'string' || typeof v.size !== 'number' || typeof v.data_base64 !== 'string' || v.data_base64.length > 6 * 1024 * 1024) throw new Error('文件过大或格式不正确');
  return { name: v.name.replace(/[^\p{L}\p{N}._-]/gu, '_').slice(0, 160) || 'download', mime_type: v.mime_type, size: v.size, data_base64: v.data_base64, ...(typeof v.text === 'string' ? { text: v.text } : {}) };
}
export async function saveProjectFile(file: ProjectFile): Promise<void> {
  if (Platform.OS === 'web') {
    const a = document.createElement('a');
    a.href = `data:${file.mime_type};base64,${file.data_base64}`;
    a.download = file.name;
    a.click();
    return;
  }
  if (!await Sharing.isAvailableAsync()) throw new Error('当前设备不支持保存或分享文件');
  const local = new File(Paths.cache, `${Date.now()}-${file.name}`);
  await local.create();
  await local.write(file.data_base64, { encoding: 'base64' });
  await Sharing.shareAsync(local.uri, { mimeType: file.mime_type, dialogTitle: '保存或分享项目文件' });
}
