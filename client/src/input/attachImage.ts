import { ImageManipulator, SaveFormat, type ImageRef } from 'expo-image-manipulator';
import * as ImagePicker from 'expo-image-picker';

import {
  ATTACHMENT_MAX_DIMENSION,
  AttachmentError,
  encodeWithinBudget,
  planEncodeAttempts,
  type EncodedImage,
} from './attachments';

export type ImageSource = 'library' | 'camera';

/**
 * Lets the user pick or take one photo. Resolves with its URI, or null when
 * they cancel. The system photo picker needs no permission; the camera does.
 */
export async function pickImage(source: ImageSource): Promise<string | null> {
  const options: ImagePicker.ImagePickerOptions = { mediaTypes: 'images', quality: 1, exif: false };
  let result: ImagePicker.ImagePickerResult;
  if (source === 'camera') {
    const permission = await ImagePicker.requestCameraPermissionsAsync();
    if (!permission.granted) {
      throw new AttachmentError('没有相机权限，请在系统设置里允许 Panecast 使用相机');
    }
    result = await ImagePicker.launchCameraAsync(options);
  } else {
    result = await ImagePicker.launchImageLibraryAsync(options);
  }
  if (result.canceled) return null;
  return result.assets[0]?.uri ?? null;
}

/**
 * Decodes the image at `uri` (downsampled while decoding, orientation applied)
 * and re-encodes it as JPEG, smaller each attempt, until the base64 fits
 * `budget`. Null when even the smallest attempt is too large.
 */
export async function encodeImage(uri: string, budget: number): Promise<EncodedImage | null> {
  const context = ImageManipulator.manipulate(uri, {
    maxWidth: ATTACHMENT_MAX_DIMENSION,
    maxHeight: ATTACHMENT_MAX_DIMENSION,
  });
  const refs: ImageRef[] = [];
  try {
    const base = await context.renderAsync();
    refs.push(base);
    const sized = new Map<string, ImageRef>([[`${base.width}x${base.height}`, base]]);
    const attempts = planEncodeAttempts(base.width, base.height);
    if (attempts.length === 0) throw new AttachmentError('读不出这张图片');
    return await encodeWithinBudget(attempts, budget, async (attempt) => {
      const key = `${attempt.width}x${attempt.height}`;
      let image = sized.get(key);
      if (!image) {
        // One side only: the manipulator keeps the aspect ratio.
        const size = attempt.width >= attempt.height ? { width: attempt.width } : { height: attempt.height };
        const resized = ImageManipulator.manipulate(base).resize(size);
        try {
          image = await resized.renderAsync();
        } finally {
          resized.release();
        }
        refs.push(image);
        sized.set(key, image);
      }
      const saved = await image.saveAsync({ format: SaveFormat.JPEG, compress: attempt.quality, base64: true });
      return saved.base64 ?? '';
    });
  } finally {
    for (const ref of refs) ref.release();
    context.release();
  }
}
