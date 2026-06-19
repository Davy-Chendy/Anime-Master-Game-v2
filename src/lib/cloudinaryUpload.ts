"use client";

export type UploadableImage = {
  file: File;
  path: string;
  name: string;
  size: number;
  type: string;
};

export type CloudinaryUploadResult = {
  ok: true;
  path: string;
  url: string;
  originalCloudinaryUrl: string;
  publicId: string;
  rawBytes: number;
  uploadBytes: number;
  usedOriginal: boolean;
};

export type CloudinaryUploadFailure = {
  ok: false;
  path: string;
  error: string;
  rawBytes: number;
};

export type CloudinaryUploadItemResult = CloudinaryUploadResult | CloudinaryUploadFailure;

type PreparedImage = {
  blob: Blob;
  uploadName: string;
  rawBytes: number;
  uploadBytes: number;
  usedOriginal: boolean;
};

export type UploadProgress = {
  done: number;
  total: number;
  success: number;
  fail: number;
  rawBytes: number;
  uploadBytes: number;
  latestMessage: string;
};

export type RemoteImageImportItem = {
  imageUrl: string;
  labelText?: string | null;
};

export type RemoteImageImportResult =
  | {
      ok: true;
      index: number;
      sourceUrl: string;
      labelText: string | null;
      item: UploadableImage;
    }
  | {
      ok: false;
      index: number;
      sourceUrl: string;
      labelText: string | null;
      path: string;
      rawBytes: number;
      error: string;
    };

const cloudinaryConfig = {
  cloudName: process.env.NEXT_PUBLIC_CLOUDINARY_CLOUD_NAME ?? "",
  uploadPreset: process.env.NEXT_PUBLIC_CLOUDINARY_UPLOAD_PRESET ?? "",
  folder: process.env.NEXT_PUBLIC_CLOUDINARY_FOLDER ?? "anime-master-game",
  maxSize: Number(process.env.NEXT_PUBLIC_UPLOAD_IMAGE_MAX_SIZE ?? 960),
  quality: Number(process.env.NEXT_PUBLIC_UPLOAD_IMAGE_QUALITY ?? 0.78),
  format: process.env.NEXT_PUBLIC_UPLOAD_IMAGE_FORMAT ?? "image/webp",
  concurrency: Number(process.env.NEXT_PUBLIC_CLOUDINARY_UPLOAD_CONCURRENCY ?? 2),
};

export function getCloudinaryUploadConfigStatus() {
  return {
    isReady: Boolean(cloudinaryConfig.cloudName && cloudinaryConfig.uploadPreset),
    maxSize: cloudinaryConfig.maxSize,
    quality: cloudinaryConfig.quality,
    format: cloudinaryConfig.format,
  };
}

export function filesToUploadableImages(fileList: FileList | File[]) {
  const files = Array.from(fileList);
  const seen = new Set<string>();

  return files
    .filter(isImageFile)
    .map((file) => ({
      file,
      path: getPath(file),
      name: file.name,
      size: file.size,
      type: file.type || guessMime(file.name),
    }))
    .filter((item) => {
      if (seen.has(item.path)) {
        return false;
      }

      seen.add(item.path);
      return true;
    })
    .sort((a, b) => a.path.localeCompare(b.path));
}

export async function uploadImagesToCloudinary(
  items: UploadableImage[],
  onProgress: (progress: UploadProgress) => void,
) {
  if (!cloudinaryConfig.cloudName || !cloudinaryConfig.uploadPreset) {
    throw new Error("缺少图片上传配置：请设置云名称和免签上传预设。");
  }

  const results: CloudinaryUploadItemResult[] = [];
  const total = items.length;
  const limit = Math.max(1, Math.min(6, cloudinaryConfig.concurrency || 2));
  let done = 0;
  let success = 0;
  let fail = 0;
  let rawBytes = 0;
  let uploadBytes = 0;

  await runPool(items, limit, async (item) => {
    try {
      const prepared = await compressImage(item);
      rawBytes += prepared.rawBytes;
      uploadBytes += prepared.uploadBytes;

      const uploaded = await uploadPreparedFile(prepared);

      results.push({
        ok: true,
        path: item.path,
        url: uploaded.secureUrl,
        originalCloudinaryUrl: uploaded.secureUrl,
        publicId: uploaded.publicId,
        rawBytes: prepared.rawBytes,
        uploadBytes: prepared.uploadBytes,
        usedOriginal: prepared.usedOriginal,
      });
      success += 1;
      onProgress({ done, total, success, fail, rawBytes, uploadBytes, latestMessage: `上传成功：${item.path}` });
    } catch (error) {
      rawBytes += item.size;
      fail += 1;
      results.push({
        ok: false,
        path: item.path,
        rawBytes: item.size,
        error: error instanceof Error ? error.message : String(error),
      });
      onProgress({ done, total, success, fail, rawBytes, uploadBytes, latestMessage: `上传失败：${item.path}` });
    } finally {
      done += 1;
      onProgress({ done, total, success, fail, rawBytes, uploadBytes, latestMessage: `已完成 ${done}/${total}` });
    }
  });

  return results.sort((a, b) => a.path.localeCompare(b.path));
}

export async function downloadRemoteImagesForUpload(
  importItems: RemoteImageImportItem[],
  onProgress: (progress: UploadProgress) => void,
  options: { maxBytes?: number } = {},
) {
  const results: RemoteImageImportResult[] = [];
  const total = importItems.length;
  const limit = Math.max(1, Math.min(6, cloudinaryConfig.concurrency || 2));
  const maxBytes = options.maxBytes ?? 20 * 1024 * 1024;
  let done = 0;
  let success = 0;
  let fail = 0;
  let rawBytes = 0;

  await runPool(
    importItems.map((item, index) => ({ item, index })),
    limit,
    async ({ item, index }) => {
      const fallbackPath = buildRemoteImagePath(item.imageUrl, index, "");

      try {
        const response = await fetch(remoteImageImportUrl(item.imageUrl));
        if (!response.ok) {
          throw new Error(await readImportImageError(response));
        }

        const contentType = normalizeMime(response.headers.get("content-type") ?? "");
        const blob = await response.blob();

        if (blob.size > maxBytes) {
          throw new Error(`图片超过 ${formatBytes(maxBytes)}。`);
        }

        const fileName = buildRemoteImageFileName(item.imageUrl, index, contentType);
        const type = contentType.startsWith("image/") ? contentType : guessMime(fileName);
        const file = new File([blob], fileName, { type });
        const uploadItem = {
          file,
          path: buildRemoteImagePath(item.imageUrl, index, type),
          name: fileName,
          size: file.size,
          type: file.type || guessMime(fileName),
        };

        rawBytes += uploadItem.size;
        success += 1;
        results.push({
          ok: true,
          index,
          sourceUrl: item.imageUrl,
          labelText: item.labelText?.trim() || null,
          item: uploadItem,
        });
        onProgress({
          done,
          total,
          success,
          fail,
          rawBytes,
          uploadBytes: 0,
          latestMessage: `已读取：${shortenUrl(item.imageUrl)}`,
        });
      } catch (error) {
        fail += 1;
        results.push({
          ok: false,
          index,
          sourceUrl: item.imageUrl,
          labelText: item.labelText?.trim() || null,
          path: fallbackPath,
          rawBytes: 0,
          error: error instanceof Error ? error.message : String(error),
        });
        onProgress({
          done,
          total,
          success,
          fail,
          rawBytes,
          uploadBytes: 0,
          latestMessage: `读取失败：${shortenUrl(item.imageUrl)}`,
        });
      } finally {
        done += 1;
        onProgress({
          done,
          total,
          success,
          fail,
          rawBytes,
          uploadBytes: 0,
          latestMessage: `已读取 ${done}/${total}`,
        });
      }
    },
  );

  return results.sort((a, b) => a.index - b.index);
}

function isImageFile(file: File) {
  return file.type.startsWith("image/") || /\.(jpg|jpeg|png|webp|gif|avif)$/i.test(file.name);
}

function getPath(file: File) {
  return file.webkitRelativePath || file.name;
}

function guessMime(name: string) {
  const lowerName = name.toLowerCase();
  if (lowerName.endsWith(".jpg") || lowerName.endsWith(".jpeg")) return "image/jpeg";
  if (lowerName.endsWith(".png")) return "image/png";
  if (lowerName.endsWith(".webp")) return "image/webp";
  if (lowerName.endsWith(".gif")) return "image/gif";
  if (lowerName.endsWith(".avif")) return "image/avif";
  return "application/octet-stream";
}

function normalizeMime(value: string) {
  return value.split(";")[0].trim().toLowerCase();
}

async function compressImage(item: UploadableImage): Promise<PreparedImage> {
  if ((item.type || "").includes("gif") || item.name.toLowerCase().endsWith(".gif")) {
    return {
      blob: item.file,
      uploadName: item.name,
      rawBytes: item.size,
      uploadBytes: item.size,
      usedOriginal: true,
    };
  }

  const targetMime = cloudinaryConfig.format || "image/webp";
  const quality = Math.max(0.1, Math.min(1, cloudinaryConfig.quality || 0.78));
  const maxSize = Math.max(100, cloudinaryConfig.maxSize || 960);
  const image = await loadImageFromBlob(item.file);
  const width = image.naturalWidth || image.width;
  const height = image.naturalHeight || image.height;

  if (!width || !height) {
    throw new Error("无法读取图片尺寸。");
  }

  const scale = Math.min(1, maxSize / width, maxSize / height);
  const outputWidth = Math.max(1, Math.round(width * scale));
  const outputHeight = Math.max(1, Math.round(height * scale));
  const canvas = document.createElement("canvas");
  canvas.width = outputWidth;
  canvas.height = outputHeight;

  const context = canvas.getContext("2d", { alpha: targetMime === "image/png" || targetMime === "image/webp" });
  if (!context) {
    throw new Error("浏览器无法创建图片压缩画布。");
  }

  context.drawImage(image, 0, 0, outputWidth, outputHeight);

  let blob: Blob;
  try {
    blob = await canvasToBlob(canvas, targetMime, quality);
  } catch (error) {
    if (targetMime !== "image/webp") {
      throw error;
    }

    blob = await canvasToBlob(canvas, "image/jpeg", quality);
  }

  if (blob.size >= item.size) {
    return {
      blob: item.file,
      uploadName: item.name,
      rawBytes: item.size,
      uploadBytes: item.size,
      usedOriginal: true,
    };
  }

  return {
    blob,
    uploadName: replaceExtension(item.name, extensionForMime(blob.type || targetMime, item.name)),
    rawBytes: item.size,
    uploadBytes: blob.size,
    usedOriginal: false,
  };
}

function loadImageFromBlob(blob: Blob) {
  return new Promise<HTMLImageElement>((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const image = new Image();

    image.onload = () => {
      URL.revokeObjectURL(url);
      resolve(image);
    };

    image.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("图片解码失败。"));
    };

    image.src = url;
  });
}

function canvasToBlob(canvas: HTMLCanvasElement, mime: string, quality: number) {
  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (!blob) {
          reject(new Error("浏览器不支持该图片格式的 Canvas 编码。"));
          return;
        }

        resolve(blob);
      },
      mime,
      quality,
    );
  });
}

function extensionForMime(mime: string, originalName: string) {
  if (mime === "image/webp") return ".webp";
  if (mime === "image/jpeg") return ".jpg";
  if (mime === "image/png") return ".png";
  return originalName.match(/\.[^.]+$/)?.[0] || ".jpg";
}

function replaceExtension(name: string, extension: string) {
  return name.replace(/\.[^.]+$/, "") + extension;
}

function apiBase() {
  return (process.env.NEXT_PUBLIC_API_BASE_URL ?? "").replace(/\/$/, "");
}

function remoteImageImportUrl(sourceUrl: string) {
  return `${apiBase()}/api/import-image?url=${encodeURIComponent(sourceUrl)}`;
}

async function readImportImageError(response: Response) {
  const contentType = response.headers.get("content-type") ?? "";

  if (contentType.includes("application/json")) {
    const data = (await response.json().catch(() => null)) as { error?: string } | null;
    return data?.error || `读取图片失败，状态码 ${response.status}。`;
  }

  const text = await response.text().catch(() => "");
  return text.trim() || `读取图片失败，状态码 ${response.status}。`;
}

function buildRemoteImagePath(sourceUrl: string, index: number, mime: string) {
  const order = String(index + 1).padStart(3, "0");
  return `${order}-${buildRemoteImageFileName(sourceUrl, index, mime)}`;
}

function buildRemoteImageFileName(sourceUrl: string, index: number, mime: string) {
  let baseName = "";

  try {
    const url = new URL(sourceUrl);
    baseName = decodeURIComponent(url.pathname.split("/").filter(Boolean).pop() ?? "");
  } catch {
    baseName = "";
  }

  const safeBaseName =
    baseName
      .replace(/[\\/:*?"<>|#%&{}$!`'@+=]/g, "-")
      .replace(/\s+/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 90) || `remote-image-${index + 1}`;

  if (/\.[a-z0-9]{2,5}$/i.test(safeBaseName)) {
    return safeBaseName;
  }

  return `${safeBaseName}${extensionForMime(normalizeMime(mime), safeBaseName)}`;
}

function shortenUrl(value: string) {
  return value.length > 70 ? `${value.slice(0, 67)}...` : value;
}

function formatBytes(bytes: number) {
  if (bytes >= 1024 * 1024) {
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  }

  if (bytes >= 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }

  return `${bytes} B`;
}

async function uploadPreparedFile(prepared: PreparedImage) {
  const endpoint = `https://api.cloudinary.com/v1_1/${encodeURIComponent(cloudinaryConfig.cloudName)}/image/upload`;
  const form = new FormData();
  form.append("file", prepared.blob, prepared.uploadName);
  form.append("upload_preset", cloudinaryConfig.uploadPreset);
  form.append("tags", "anime-master-game,question-set");

  if (cloudinaryConfig.folder) {
    form.append("folder", cloudinaryConfig.folder);
  }

  const response = await fetch(endpoint, { method: "POST", body: form });
  const data = (await response.json().catch(() => ({}))) as {
    secure_url?: string;
    public_id?: string;
    error?: { message?: string };
  };

  if (!response.ok) {
    throw new Error(`图片上传失败，请检查上传预设和网络。状态码 ${response.status}。`);
  }

  if (!data.secure_url) {
    throw new Error("图片服务未返回图片地址。");
  }

  return {
    secureUrl: data.secure_url,
    publicId: data.public_id ?? "",
  };
}

async function runPool<T>(items: T[], limit: number, worker: (item: T) => Promise<void>) {
  let index = 0;
  const workers = Array.from({ length: limit }, async () => {
    while (index < items.length) {
      const current = index;
      index += 1;
      await worker(items[current]);
    }
  });

  await Promise.all(workers);
}
