import sharp from 'sharp';
import { ApiError } from '../orchestrator/errors.js';

export const MAX_REFERENCE_BYTES = 5 * 1024 * 1024;
export const MAX_REFERENCE_SET_BYTES = 20 * 1024 * 1024;
export const MAX_REFERENCE_PIXELS = 25_000_000;

export async function validateReferenceImage(bytes: Uint8Array, mimeType: string) {
  if (!bytes.byteLength || bytes.byteLength > MAX_REFERENCE_BYTES) {
    throw new ApiError(413, 'IMAGE_TOO_LARGE', 'Each reference photo must contain between 1 byte and 5 MiB.');
  }
  const formats: Record<string, string> = { 'image/jpeg': 'jpeg', 'image/png': 'png', 'image/webp': 'webp' };
  const format = formats[mimeType];
  if (!format) throw new ApiError(415, 'IMAGE_TYPE', 'Use a single-frame JPEG, PNG or WebP photo.');
  try {
    const image = sharp(bytes, { limitInputPixels: MAX_REFERENCE_PIXELS, failOn: 'warning', animated: true });
    const metadata = await image.metadata();
    if (metadata.format !== format || (metadata.pages ?? 1) !== 1 || !metadata.width || !metadata.height
        || metadata.width * metadata.height > MAX_REFERENCE_PIXELS) {
      throw new ApiError(415, 'INVALID_IMAGE', 'The photo format, dimensions or frame count is not supported.');
    }
    const normalized = await image.rotate().flatten({ background: '#ffffff' }).jpeg({ quality: 92 }).toBuffer({ resolveWithObject: true });
    if (normalized.data.byteLength > MAX_REFERENCE_BYTES) {
      throw new ApiError(413, 'IMAGE_TOO_LARGE', 'The normalized reference exceeds 5 MiB.');
    }
    return {
      bytes: new Uint8Array(normalized.data), mimeType: 'image/jpeg' as const,
      width: normalized.info.width, height: normalized.info.height,
    };
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(415, 'INVALID_IMAGE', 'The photo could not be decoded within the 25-megapixel limit.');
  }
}
