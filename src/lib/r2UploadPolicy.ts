export const R2_IMAGE_UPLOAD_MAX_BYTES = 10 * 1024 * 1024;
export const R2_IMAGE_UPLOAD_MAX_MEGABYTES = 10;
export const R2_IMAGE_UPLOAD_TOO_LARGE_MESSAGE = `图片压缩后仍超过 ${R2_IMAGE_UPLOAD_MAX_MEGABYTES} MB，已拒绝上传。`;

export function isR2ImageUploadTooLarge(bytes: number) {
  return bytes > R2_IMAGE_UPLOAD_MAX_BYTES;
}
