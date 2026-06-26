"use client";

export type UploadableImage = {
  file: File;
  path: string;
  name: string;
  size: number;
  type: string;
};

export type R2UploadResult = {
  ok: true;
  path: string;
  url: string;
  r2Key: string;
  publicId: string;
  rawBytes: number;
  uploadBytes: number;
  usedOriginal: boolean;
};

export type R2UploadFailure = {
  ok: false;
  path: string;
  error: string;
  rawBytes: number;
};

export type R2UploadItemResult = R2UploadResult | R2UploadFailure;

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

const r2UploadConfig = {
  maxSize: Number(process.env.NEXT_PUBLIC_UPLOAD_IMAGE_MAX_SIZE ?? 960),
  quality: Number(process.env.NEXT_PUBLIC_UPLOAD_IMAGE_QUALITY ?? 0.78),
  format: process.env.NEXT_PUBLIC_UPLOAD_IMAGE_FORMAT ?? "image/webp",
  concurrency: Number(process.env.NEXT_PUBLIC_R2_UPLOAD_CONCURRENCY ?? 2),
};

function apiBase() {
  return (process.env.NEXT_PUBLIC_API_BASE_URL ?? "").replace(/\/$/, "");
}

function apiUrl(path: string) {
  return `${apiBase()}${path}`;
}

export function getR2UploadConfigStatus() {
  return {
    isReady: true,
    maxSize: r2UploadConfig.maxSize,
    quality: r2UploadConfig.quality,
    format: r2UploadConfig.format,
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

export async function uploadImagesToR2(
  items: UploadableImage[],
  onProgress: (progress: UploadProgress) => void,
) {
  const results: R2UploadItemResult[] = [];
  const total = items.length;
  const limit = Math.max(1, Math.min(6, r2UploadConfig.concurrency || 2));
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
        url: uploaded.url,
        r2Key: uploaded.key,
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

  const targetMime = r2UploadConfig.format || "image/webp";
  const quality = Math.max(0.1, Math.min(1, r2UploadConfig.quality || 0.78));
  const maxSize = Math.max(100, r2UploadConfig.maxSize || 960);
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

async function uploadPreparedFile(prepared: PreparedImage) {
  const endpoint = apiUrl(`/api/r2-upload?filename=${encodeURIComponent(prepared.uploadName)}`);
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "content-type": prepared.blob.type || "application/octet-stream",
    },
    body: prepared.blob,
  });
  const data = (await response.json().catch(() => ({}))) as {
    key?: string;
    url?: string;
    publicId?: string;
    error?: string;
  };

  if (!response.ok) {
    throw new Error(data.error ?? `图片上传失败，请检查 R2 配置和网络。状态码 ${response.status}。`);
  }

  if (!data.url || !data.key) {
    throw new Error("图片服务未返回图片地址。");
  }

  return {
    key: data.key,
    url: data.url,
    publicId: data.publicId ?? data.key,
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
