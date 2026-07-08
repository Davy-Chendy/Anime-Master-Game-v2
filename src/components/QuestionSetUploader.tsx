"use client";

import { DragEvent, useMemo, useRef, useState } from "react";
import { Button } from "@/components/Button";
import {
  filesToUploadableImages,
  getR2UploadConfigStatus,
  uploadImagesToR2,
  type R2UploadItemResult,
  type UploadProgress,
  type UploadableImage,
} from "@/lib/r2Upload";
import {
  createQuestionSetFromUrlText,
  createUploadedQuestionSet,
  getCommunityQuestionSets,
  parseImageUrlsText,
  parseQuestionImportText,
  prepareQuestionSetForStart,
} from "@/lib/cloudflareRooms";
import type { FailedQuestionUrlImport, PreparedQuestionUrlImport, QuestionSet, QuestionUrlImportInput, Room } from "@/types/game";

type QuestionSetUploaderProps = {
  room: Room;
  presenterPlayerId: string;
  isCancelingPresenterSetup?: boolean;
  onRoomUpdated: (room: Room) => void;
  onError: (message: string) => void;
  onClearError?: () => void;
  onCancelPresenterSetup?: () => void;
};

type SetupMode = "upload" | "urlText" | "community";
type CommunitySort = "latest" | "rating";
const maxUploadImageCount = 120;
const maxUploadImageBytes = 20 * 1024 * 1024;

type BrowserFileSystemFileHandle = {
  kind: "file";
  getFile: () => Promise<File>;
};

type BrowserFileSystemDirectoryHandle = {
  values: () => AsyncIterable<BrowserFileSystemFileHandle | { kind: "directory" }>;
};

const emptyProgress: UploadProgress = {
  done: 0,
  total: 0,
  success: 0,
  fail: 0,
  rawBytes: 0,
  uploadBytes: 0,
  latestMessage: "尚未开始",
};

function toImportInputs(items: ReturnType<typeof parseQuestionImportText>): QuestionUrlImportInput[] {
  return items.map((item, index) => ({
    imageUrl: item.imageUrl,
    labelText: item.labelText ?? null,
    orderIndex: index,
  }));
}

function failedToImportInputs(items: FailedQuestionUrlImport[]): QuestionUrlImportInput[] {
  return items.map((item) => ({
    imageUrl: item.imageUrl,
    labelText: item.labelText ?? null,
    orderIndex: item.orderIndex,
  }));
}

function getQuestionSetUrls(questionSet: QuestionSet | null) {
  if (!questionSet) {
    return [];
  }

  const textUrls = parseImageUrlsText(questionSet.imageUrlsText ?? "");

  if (textUrls.length > 0) {
    return textUrls;
  }

  return (questionSet.questions ?? [])
    .slice()
    .sort((a, b) => a.orderIndex - b.orderIndex)
    .map((question) => question.imageUrl);
}

function getQuestionSetPreviewItems(questionSet: QuestionSet | null) {
  if (!questionSet) {
    return [];
  }

  const questions = (questionSet.questions ?? []).slice().sort((a, b) => a.orderIndex - b.orderIndex);

  if (questions.length > 0) {
    return questions.map((question, index) => ({
      key: question.id,
      url: question.imageUrl,
      labelText: question.labelText ?? null,
      index,
    }));
  }

  return getQuestionSetUrls(questionSet).map((url, index) => ({
    key: `${url}-${index}`,
    url,
    labelText: null,
    index,
  }));
}

function getDraftQuestionSetTitle(room: Room) {
  return `房间 ${room.code} 临时题库`;
}

function getQuestionSetUploaderName(questionSet: QuestionSet) {
  return questionSet.createdByNickname?.trim() || "未知上传者";
}

function formatQuestionSetPublishedAt(questionSet: QuestionSet) {
  const publishedAt = new Date(questionSet.createdAt);

  if (Number.isNaN(publishedAt.getTime())) {
    return "未知时间";
  }

  const year = String(publishedAt.getFullYear()).slice(-2);
  const month = String(publishedAt.getMonth() + 1).padStart(2, "0");
  const day = String(publishedAt.getDate()).padStart(2, "0");

  return `${year}/${month}/${day}`;
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

function isCurrentFolderFile(file: File) {
  const relativePath = file.webkitRelativePath || "";

  if (!relativePath) {
    return true;
  }

  return relativePath.split(/[\\/]/).filter(Boolean).length <= 2;
}

async function pickCurrentFolderFiles() {
  const picker = (window as Window & {
    showDirectoryPicker?: () => Promise<BrowserFileSystemDirectoryHandle>;
  }).showDirectoryPicker;

  if (!picker) {
    return null;
  }

  const directoryHandle = await picker();
  const files: File[] = [];

  for await (const entry of directoryHandle.values()) {
    if (entry.kind === "file") {
      files.push(await entry.getFile());
    }
  }

  return files;
}

export function QuestionSetUploader({
  room,
  presenterPlayerId,
  isCancelingPresenterSetup = false,
  onRoomUpdated,
  onError,
  onClearError,
  onCancelPresenterSetup,
}: QuestionSetUploaderProps) {
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const folderInputRef = useRef<HTMLInputElement | null>(null);
  const jsonlInputRef = useRef<HTMLInputElement | null>(null);
  const previewRef = useRef<HTMLDivElement | null>(null);
  const [mode, setMode] = useState<SetupMode>("upload");
  const [urlText, setUrlText] = useState("");
  const [items, setItems] = useState<UploadableImage[]>([]);
  const [isDragging, setIsDragging] = useState(false);
  const [isDraggingImport, setIsDraggingImport] = useState(false);
  const [isUploading, setIsUploading] = useState(false);
  const [isCreatingFromText, setIsCreatingFromText] = useState(false);
  const [isLoadingCommunity, setIsLoadingCommunity] = useState(false);
  const [communitySort, setCommunitySort] = useState<CommunitySort>("latest");
  const [communitySets, setCommunitySets] = useState<QuestionSet[]>([]);
  const [communitySearch, setCommunitySearch] = useState("");
  const [previewingCommunitySet, setPreviewingCommunitySet] = useState<QuestionSet | null>(null);
  const [isConfirmingQuestionSet, setIsConfirmingQuestionSet] = useState(false);
  const [progress, setProgress] = useState<UploadProgress>(emptyProgress);
  const [results, setResults] = useState<R2UploadItemResult[]>([]);
  const [questionSet, setQuestionSet] = useState<QuestionSet | null>(null);
  const configStatus = getR2UploadConfigStatus();

  const previewUrls = useMemo(() => getQuestionSetUrls(questionSet), [questionSet]);
  const previewItems = useMemo(() => getQuestionSetPreviewItems(questionSet), [questionSet]);
  const importPreview = useMemo(() => {
    try {
      const importItems = parseQuestionImportText(urlText);
      return {
        items: importItems,
        labeledCount: importItems.filter((item) => item.labelText?.trim()).length,
        error: null,
      };
    } catch (error) {
      return {
        items: [],
        labeledCount: 0,
        error: error instanceof Error ? error.message : "题单JSONL格式错误",
      };
    }
  }, [urlText]);
  const urlsTextForPreview = previewUrls.join("\n");
  const progressPercent = progress.total > 0 ? Math.round((progress.done / progress.total) * 100) : 0;
  const filteredCommunitySets = useMemo(() => {
    const terms = communitySearch
      .trim()
      .toLowerCase()
      .split(/\s+/)
      .filter(Boolean);

    if (terms.length === 0) {
      return communitySets;
    }

    return communitySets.filter((item) => {
      const searchableText = `${item.title} ${item.description ?? ""} ${item.createdByNickname ?? ""}`.toLowerCase();
      return terms.every((term) => searchableText.includes(term));
    });
  }, [communitySearch, communitySets]);

  function clearError() {
    onClearError?.();
  }

  function scrollToPreview() {
    window.setTimeout(() => {
      previewRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    }, 50);
  }

  function resetCreatedSet() {
    setQuestionSet(null);
    setResults([]);
  }

  async function markQuestionSetReady(selectedQuestionSet: QuestionSet) {
    if (!room.id) {
      return;
    }

    setIsConfirmingQuestionSet(true);
    try {
      const nextRoom = await prepareQuestionSetForStart({
        roomId: room.id,
        presenterPlayerId,
        questionSetId: selectedQuestionSet.id,
      });
      onRoomUpdated({ ...room, ...nextRoom, players: room.players });
      clearError();
    } catch (error) {
      onError(error instanceof Error ? error.message : "通知房主失败，请稍后重试");
    } finally {
      setIsConfirmingQuestionSet(false);
    }
  }

  function switchMode(nextMode: SetupMode) {
    setMode(nextMode);
    clearError();

    if (nextMode === "community" && communitySets.length === 0 && !isLoadingCommunity) {
      handleLoadCommunitySets();
    }
  }

  function addFiles(fileList: FileList | File[] | null) {
    if (!fileList) {
      return;
    }

    const selectedFiles = Array.from(fileList);
    const currentFolderFiles = selectedFiles.filter(isCurrentFolderFile);
    const skippedNestedFiles = selectedFiles.length - currentFolderFiles.length;
    const imageFiles = filesToUploadableImages(currentFolderFiles);
    const oversizedFiles = imageFiles.filter((item) => item.size > maxUploadImageBytes);
    const incoming = imageFiles.filter((item) => item.size <= maxUploadImageBytes);
    const skippedNonImages = currentFolderFiles.length - imageFiles.length;

    if (incoming.length === 0) {
      onError(
        oversizedFiles.length > 0
          ? `图片不能超过 ${formatBytes(maxUploadImageBytes)}`
          : "没有检测到可上传的图片",
      );
      return;
    }

    const existing = new Set(items.map((item) => item.path));
    const nextItems = [...items];

    for (const item of incoming) {
      if (!existing.has(item.path)) {
        nextItems.push(item);
        existing.add(item.path);
      }
    }

    const sortedItems = nextItems.sort((a, b) => a.path.localeCompare(b.path));
    const limitedItems = sortedItems.slice(0, maxUploadImageCount);
    const warningParts = [
      sortedItems.length > maxUploadImageCount ? `一次最多选择 ${maxUploadImageCount} 张图片，已保留前 ${maxUploadImageCount} 张` : "",
      skippedNestedFiles > 0 ? `已忽略 ${skippedNestedFiles} 个子文件夹内的文件` : "",
      oversizedFiles.length > 0 ? `已跳过 ${oversizedFiles.length} 张超过 ${formatBytes(maxUploadImageBytes)} 的图片` : "",
      skippedNonImages > 0 ? `已忽略 ${skippedNonImages} 个非图片文件` : "",
    ].filter(Boolean);

    setItems(limitedItems);

    if (warningParts.length > 0) {
      onError(`${warningParts.join("，")}`);
    } else {
      clearError();
    }

    resetCreatedSet();
  }

  async function handleChooseFolder() {
    try {
      const pickedFiles = await pickCurrentFolderFiles();

      if (pickedFiles) {
        addFiles(pickedFiles);
        return;
      }
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") {
        return;
      }

      onError(error instanceof Error ? error.message : "读取文件夹失败，请重试");
      return;
    }

    folderInputRef.current?.click();
  }

  function clearFiles() {
    setItems([]);
    setProgress(emptyProgress);
    resetCreatedSet();

    if (fileInputRef.current) {
      fileInputRef.current.value = "";
    }

    if (folderInputRef.current) {
      folderInputRef.current.value = "";
    }
  }

  function handleDrop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    setIsDragging(false);
    addFiles(event.dataTransfer.files);
  }

  async function readJsonlFiles(fileList: FileList | File[] | null) {
    const files = Array.from(fileList ?? []).filter((file) => /\.jsonl$/i.test(file.name) || file.type === "application/json");

    if (files.length === 0) {
      onError("请上传 .jsonl 文件");
      return;
    }

    try {
      const texts = await Promise.all(files.map((file) => file.text()));
      setUrlText(texts.join("\n"));
      resetCreatedSet();
      clearError();
    } catch {
      onError("读取题单JSONL文件失败，请重试");
    } finally {
      if (jsonlInputRef.current) {
        jsonlInputRef.current.value = "";
      }
    }
  }

  function handleImportDrop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    setIsDraggingImport(false);
    readJsonlFiles(event.dataTransfer.files);
  }

  async function createQuestionSetFromUrls(imageUrls: string[]) {
    if (imageUrls.length === 0) {
      onError("至少需要一张图片");
      return null;
    }

    const createdQuestionSet = await createUploadedQuestionSet({
      roomId: room.id ?? "",
      presenterPlayerId,
      title: getDraftQuestionSetTitle(room),
      description: "",
      imageUrls,
    });

    setQuestionSet(createdQuestionSet);
    clearError();
    scrollToPreview();
    return createdQuestionSet;
  }

  async function handleUpload() {
    clearError();

    if (items.length === 0) {
      onError("请先选择至少一张图片");
      return;
    }

    setIsUploading(true);
    resetCreatedSet();
    setProgress({ ...emptyProgress, total: items.length, latestMessage: "开始压缩并上传图片" });

    try {
      const uploadResults = await uploadImagesToR2(items, setProgress);
      setResults(uploadResults);

      const imageUrls = uploadResults
        .filter((result): result is Extract<R2UploadItemResult, { ok: true }> => result.ok)
        .map((result) => result.url);

      if (imageUrls.length === 0) {
        onError("没有图片上传成功，未创建题库");
        return;
      }

      await createQuestionSetFromUrls(imageUrls);
    } catch (error) {
      onError(error instanceof Error ? error.message : "上传题库失败，请稍后重试");
    } finally {
      setIsUploading(false);
    }
  }

  async function handleCreateFromUrlText() {
    clearError();

    if (!urlText.trim()) {
      onError("请先粘贴图片链接，或上传题单JSONL文件");
      return;
    }

    if (importPreview.error) {
      onError(importPreview.error);
      return;
    }

    if (importPreview.items.length === 0) {
      onError("没有检测到有效图片链接。请使用 http/https 图片链接，或每行一个包含 image_url 的 JSON 对象");
      return;
    }

    if (importPreview.items.length > maxUploadImageCount) {
      onError(`一次最多导入 ${maxUploadImageCount} 张图片，请删减题单后重试`);
      return;
    }

    setIsCreatingFromText(true);
    resetCreatedSet();
    setProgress({ ...emptyProgress, total: importPreview.items.length, latestMessage: "开始抓取并压缩远端图片" });

    try {
      let preparedQuestions: PreparedQuestionUrlImport[] = [];
      let retryQuestions: QuestionUrlImportInput[] = toImportInputs(importPreview.items);
      let fallbackToOriginalUrls = false;

      while (true) {
        setProgress((current) => ({
          ...current,
          total: preparedQuestions.length + retryQuestions.length,
          done: preparedQuestions.length,
          success: preparedQuestions.length,
          fail: 0,
          latestMessage: fallbackToOriginalUrls
            ? "正在用原链接代替失败图片并创建题库"
            : preparedQuestions.length > 0
              ? `正在重试 ${retryQuestions.length} 张失败图片`
              : "正在抓取、压缩并上传远端图片",
        }));

        const result = await createQuestionSetFromUrlText({
          roomId: room.id ?? "",
          presenterPlayerId,
          title: getDraftQuestionSetTitle(room),
          description: "",
          retryQuestions,
          preparedQuestions,
          fallbackToOriginalUrls,
        });

        if (result.status === "created") {
          setQuestionSet(result.questionSet);
          setProgress({
            ...emptyProgress,
            total: result.importedCount + result.fallbackCount,
            done: result.importedCount + result.fallbackCount,
            success: result.importedCount,
            fail: result.fallbackCount,
            latestMessage:
              result.fallbackCount > 0
                ? `题库已创建：${result.importedCount} 张已上传图库，${result.fallbackCount} 张使用原链接`
                : `题库已创建：${result.importedCount} 张图片已上传图库`,
          });
          clearError();
          scrollToPreview();
          break;
        }

        preparedQuestions = result.preparedQuestions;
        retryQuestions = failedToImportInputs(result.failedQuestions);
        setProgress({
          ...emptyProgress,
          total: result.totalCount,
          done: result.preparedQuestions.length + result.failedQuestions.length,
          success: result.preparedQuestions.length,
          fail: result.failedQuestions.length,
          latestMessage: `${result.failedQuestions.length} 张图片导入失败`,
        });

        const failedSummary = result.failedQuestions
          .slice(0, 5)
          .map((item) => `第 ${item.orderIndex + 1} 张：${item.error}`)
          .join("\n");
        const shouldRetry = window.confirm(
          `有 ${result.failedQuestions.length} 张图片导入失败。\n\n${failedSummary}${
            result.failedQuestions.length > 5 ? "\n..." : ""
          }\n\n点击“确定”重试失败图片；点击“取消”则用原 URL 代替失败图片创建题库。`,
        );

        if (shouldRetry) {
          fallbackToOriginalUrls = false;
          continue;
        }

        fallbackToOriginalUrls = true;
      }
    } catch (error) {
      onError(error instanceof Error ? error.message : "从图片链接创建题库失败");
    } finally {
      setIsCreatingFromText(false);
    }
  }

  async function handleLoadCommunitySets(nextSort = communitySort) {
    clearError();
    setIsLoadingCommunity(true);

    try {
      const questionSets = await getCommunityQuestionSets(nextSort);
      setCommunitySets(questionSets);
    } catch (error) {
      onError(error instanceof Error ? error.message : "加载社区题库失败");
    } finally {
      setIsLoadingCommunity(false);
    }
  }

  async function handleSelectCommunitySet(selectedQuestionSet: QuestionSet) {
    setQuestionSet(selectedQuestionSet);
    clearError();
    scrollToPreview();
  }

  async function handleConfirmQuestionSet() {
    if (!questionSet) {
      onError("请先创建或选择题库");
      return;
    }

    await markQuestionSetReady(questionSet);
  }

  async function handleCopyUrlsText() {
    try {
      await navigator.clipboard.writeText(urlsTextForPreview);
      clearError();
    } catch {
      onError("复制失败，请手动选择图片链接文本");
    }
  }

  return (
    <div className="space-y-6">
      <section className="space-y-4">
        <div className="flex items-center gap-3">
          <span className="grid h-7 w-7 shrink-0 place-items-center rounded-md bg-slate-900 text-sm font-bold text-white">1</span>
          <h3 className="text-base font-semibold text-slate-950">选择来源</h3>
        </div>

        <div className="grid gap-2 sm:grid-cols-3" role="tablist" aria-label="题库来源">
          {[
            ["upload", "上传图片"],
            ["urlText", "题单JSONL/图片链接"],
            ["community", "社区题库"],
          ].map(([value, label]) => (
            <button
              aria-pressed={mode === value}
              className={[
                "rounded-md border px-4 py-3 text-left text-sm font-semibold transition",
                mode === value
                  ? "border-rose-300 bg-rose-50 text-rose-800 shadow-sm"
                  : "border-[var(--line)] bg-white text-slate-700 hover:bg-slate-50",
              ].join(" ")}
              key={value}
              type="button"
              onClick={() => switchMode(value as SetupMode)}
            >
              {label}
            </button>
          ))}
        </div>

        {mode === "upload" ? (
          <div className="space-y-4">
            {!configStatus.isReady ? (
              <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
                图片上传服务未就绪，无法上传新图片。
              </div>
            ) : null}
            <div
              className={`rounded-md border-2 border-dashed p-6 text-center transition ${
                isDragging ? "border-rose-300 bg-rose-50" : "border-[var(--line)] bg-slate-50"
              }`}
              onDragOver={(event) => {
                event.preventDefault();
                setIsDragging(true);
              }}
              onDragLeave={() => setIsDragging(false)}
              onDrop={handleDrop}
            >
              <p className="text-base font-semibold text-slate-900">拖拽图片到这里</p>
              <div className="mt-4 flex flex-wrap justify-center gap-3">
                <Button type="button" variant="secondary" onClick={() => fileInputRef.current?.click()}>
                  选择图片
                </Button>
                <Button type="button" variant="secondary" onClick={handleChooseFolder}>
                  选择文件夹
                </Button>
                <Button type="button" variant="secondary" onClick={clearFiles} disabled={isUploading || items.length === 0}>
                  清空
                </Button>
              </div>
              <p className="mt-3 text-xs text-[var(--muted)]">
                文件夹只取当前层图片，不读取子文件夹；单张不超过 {formatBytes(maxUploadImageBytes)}，最多 {maxUploadImageCount} 张
              </p>
              <input ref={fileInputRef} className="hidden" type="file" accept="image/*" multiple onChange={(event) => addFiles(event.target.files)} />
              <input
                ref={folderInputRef}
                className="hidden"
                type="file"
                accept="image/*"
                multiple
                {...({ webkitdirectory: "", directory: "" } as Record<string, string>)}
                onChange={(event) => addFiles(event.target.files)}
              />
            </div>
            <div className="grid gap-3 text-sm sm:grid-cols-3">
              <div
                className={
                  items.length > 0
                    ? "rounded-md border-2 border-emerald-500 bg-white p-3 shadow-sm"
                    : "rounded-md bg-slate-50 p-3"
                }
              >
                <span
                  className={items.length > 0 ? "flex items-center gap-1.5 text-xs font-semibold text-slate-600" : "block text-xs text-[var(--muted)]"}
                >
                  {items.length > 0 ? <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" /> : null}
                  <span>已选择</span>
                </span>
                <span className={items.length > 0 ? "mt-1 block text-2xl font-bold text-emerald-800" : "mt-1 block text-xl font-semibold text-slate-950"}>
                  {items.length}
                </span>
              </div>
              <div className="rounded-md bg-slate-50 p-3">
                <span className="block text-xs text-[var(--muted)]">成功</span>
                <span className="mt-1 block text-xl font-semibold text-slate-950">{progress.success}</span>
              </div>
              <div className="rounded-md bg-slate-50 p-3">
                <span className="block text-xs text-[var(--muted)]">失败</span>
                <span className="mt-1 block text-xl font-semibold text-slate-950">{progress.fail}</span>
              </div>
            </div>
            {progress.total > 0 ? (
              <div>
                <div className="h-3 overflow-hidden rounded-full bg-slate-100">
                  <div className="h-full bg-[var(--primary)] transition-all" style={{ width: `${progressPercent}%` }} />
                </div>
                <p className="mt-2 text-xs text-[var(--muted)]">{progress.latestMessage}</p>
              </div>
            ) : null}
            {progress.fail > 0 ? (
              <p className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
                有图片上传失败，可以再次点击上传重试
              </p>
            ) : null}
            <Button className="w-full sm:w-auto" type="button" onClick={handleUpload} disabled={!configStatus.isReady || isUploading || items.length === 0}>
              {isUploading ? "上传中…" : "上传并创建"}
            </Button>
          </div>
        ) : null}

        {mode === "urlText" ? (
          <div className="space-y-4">
            <div
              className={`rounded-md border-2 border-dashed p-4 transition ${
                isDraggingImport ? "border-rose-300 bg-rose-50" : "border-[var(--line)] bg-slate-50"
              }`}
              onDragOver={(event) => {
                event.preventDefault();
                setIsDraggingImport(true);
              }}
              onDragLeave={() => setIsDraggingImport(false)}
              onDrop={handleImportDrop}
            >
              <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-center">
                <p className="text-sm font-semibold text-slate-900">粘贴图片链接，或上传题单JSONL</p>
                <Button type="button" variant="secondary" onClick={() => jsonlInputRef.current?.click()}>
                  选择题单JSONL
                </Button>
              </div>
              <input
                ref={jsonlInputRef}
                className="hidden"
                type="file"
                accept=".jsonl,application/json"
                multiple
                onChange={(event) => readJsonlFiles(event.target.files)}
              />
            </div>
            <label className="block">
              <span className="mb-2 block text-sm font-medium text-slate-900">图片链接或题单JSONL</span>
              <textarea
                className="min-h-52 w-full rounded-md border border-[var(--line)] bg-white px-3 py-2 text-sm outline-none transition focus:border-[var(--primary)] focus:ring-4 focus:ring-rose-100"
                placeholder={
                  "https://game.example.com/api/r2-images/question-images/.../image.webp\nhttps://game.example.com/api/r2-images/question-images/.../image2.webp\n\n{\"image_url\":\"https://...jpg\",\"label_text\":\"动画名\"}"
                }
                value={urlText}
                onChange={(event) => {
                  setUrlText(event.target.value);
                  resetCreatedSet();
                  clearError();
                }}
              />
            </label>
            {importPreview.error ? (
              <p className="text-sm text-red-600">{importPreview.error}</p>
            ) : (
              <p className="text-sm text-[var(--muted)]">
                已识别 {importPreview.items.length} 张图片，{importPreview.labeledCount} 个带答案
              </p>
            )}
            <Button className="w-full sm:w-auto" type="button" onClick={handleCreateFromUrlText} disabled={isCreatingFromText}>
              {isCreatingFromText ? "抓取并创建中…" : "创建题库"}
            </Button>
            {isCreatingFromText || progress.total > 0 ? (
              <div>
                <div className="h-3 overflow-hidden rounded-full bg-slate-100">
                  <div className="h-full bg-[var(--primary)] transition-all" style={{ width: `${progressPercent}%` }} />
                </div>
                <p className="mt-2 text-xs text-[var(--muted)]">{progress.latestMessage}</p>
              </div>
            ) : null}
          </div>
        ) : null}

        {mode === "community" ? (
          <div className="space-y-4">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
              <label className="block flex-1">
                <span className="mb-2 block text-sm font-medium text-slate-900">搜索题库</span>
                <input
                  className="h-11 w-full rounded-md border border-[var(--line)] bg-white px-3 text-sm outline-none transition placeholder:text-slate-400 focus:border-[var(--primary)] focus:ring-4 focus:ring-rose-100"
                  placeholder="标题或简介"
                  value={communitySearch}
                  onChange={(event) => setCommunitySearch(event.target.value)}
                />
              </label>
              <div className="flex gap-2">
                <select
                  aria-label="社区题库排序"
                  className="h-11 rounded-md border border-[var(--line)] bg-white px-3 text-sm"
                  value={communitySort}
                  onChange={(event) => {
                    const nextSort = event.target.value as CommunitySort;
                    setCommunitySort(nextSort);
                    handleLoadCommunitySets(nextSort);
                  }}
                >
                  <option value="latest">最新</option>
                  <option value="rating">评分最高</option>
                </select>
                <Button className="h-11" type="button" variant="secondary" onClick={() => handleLoadCommunitySets()} disabled={isLoadingCommunity}>
                  {isLoadingCommunity ? "加载中…" : "刷新"}
                </Button>
              </div>
            </div>
            <div className="grid max-h-[54vh] gap-3 overflow-y-auto pr-1">
              {filteredCommunitySets.map((item) => (
                <div
                  className="rounded-md border border-[var(--line)] bg-white p-3 text-left transition hover:border-rose-300 hover:bg-rose-50"
                  key={item.id}
                >
                  <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-center">
                    <div className="min-w-0">
                      <p className="truncate font-semibold text-slate-950">{item.title}</p>
                      <p className="mt-1 line-clamp-2 text-sm text-[var(--muted)]">{item.description || "暂无简介"}</p>
                      <p className="mt-2 text-xs text-[var(--muted)]">
                        上传者：{getQuestionSetUploaderName(item)} · 发布时间：{formatQuestionSetPublishedAt(item)} · {item.imageCount} 张 ·{" "}
                        {Number(item.ratingAvg).toFixed(1)} 分 · {item.ratingCount} 人评分
                      </p>
                    </div>
                    <div className="flex shrink-0 flex-wrap gap-2">
                      <Button type="button" variant="secondary" onClick={() => setPreviewingCommunitySet(item)}>
                        预览
                      </Button>
                      <Button type="button" onClick={() => handleSelectCommunitySet(item)}>
                        选择
                      </Button>
                    </div>
                  </div>
                </div>
              ))}
              {!isLoadingCommunity && communitySets.length === 0 ? (
                <p className="rounded-md bg-slate-50 px-4 py-5 text-sm text-[var(--muted)]">暂无社区题库</p>
              ) : null}
              {!isLoadingCommunity && communitySets.length > 0 && filteredCommunitySets.length === 0 ? (
                <p className="rounded-md bg-slate-50 px-4 py-5 text-sm text-[var(--muted)]">没有匹配的题库</p>
              ) : null}
            </div>
          </div>
        ) : null}
      </section>

      {previewingCommunitySet ? (
        <div className="fixed inset-0 z-50 grid place-items-center bg-slate-950/45 px-4 py-6">
          <div className="flex max-h-[88vh] w-full max-w-5xl flex-col overflow-hidden rounded-lg border border-[var(--line)] bg-white shadow-2xl">
            <div className="flex flex-col justify-between gap-3 border-b border-[var(--line)] px-5 py-4 sm:flex-row sm:items-start">
              <div>
                <p className="text-lg font-semibold text-slate-950">{previewingCommunitySet.title}</p>
                <p className="mt-1 text-sm text-[var(--muted)]">{previewingCommunitySet.description || "暂无简介"}</p>
                <p className="mt-2 text-xs text-[var(--muted)]">
                  上传者：{getQuestionSetUploaderName(previewingCommunitySet)}，发布时间：{formatQuestionSetPublishedAt(previewingCommunitySet)}，
                  {previewingCommunitySet.imageCount} 张，评分 {Number(previewingCommunitySet.ratingAvg).toFixed(2)} / 5，{previewingCommunitySet.ratingCount} 人评分
                </p>
              </div>
              <div className="flex shrink-0 gap-2">
                <Button
                  type="button"
                  onClick={() => {
                    handleSelectCommunitySet(previewingCommunitySet);
                    setPreviewingCommunitySet(null);
                  }}
                >
                  用这个题库
                </Button>
                <button
                  className="rounded-md border border-[var(--line)] px-3 py-2 text-sm font-semibold hover:bg-slate-50"
                  type="button"
                  onClick={() => setPreviewingCommunitySet(null)}
                >
                  关闭
                </button>
              </div>
            </div>
            <div className="overflow-y-auto p-5">
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
                {getQuestionSetPreviewItems(previewingCommunitySet).map((item) => (
                  <figure className="rounded-md border border-[var(--line)] bg-slate-50 p-2" key={item.key}>
                    <img alt="" className="aspect-video w-full rounded bg-black object-contain" src={item.url} />
                    <figcaption className="mt-2 text-xs text-[var(--muted)]">
                      第 {item.index + 1} 张
                      <span className="mt-1 block font-medium text-slate-800">{item.labelText?.trim() || "未填写答案"}</span>
                    </figcaption>
                  </figure>
                ))}
              </div>
            </div>
          </div>
        </div>
      ) : null}

      <section ref={previewRef} className="space-y-4 border-t border-[var(--line)] pt-5 scroll-mt-4">
        <div className="flex items-center gap-3">
          <span className="grid h-7 w-7 shrink-0 place-items-center rounded-md bg-slate-900 text-sm font-bold text-white">2</span>
          <h3 className="text-base font-semibold text-slate-950">确认题库</h3>
        </div>

        {questionSet ? (
          <div className="rounded-md border border-[var(--line)] bg-slate-50 p-4">
            <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-center">
              <div>
                <p className="font-semibold text-slate-950">{questionSet.title}</p>
                <p className="mt-1 text-sm text-[var(--muted)]">
                  {questionSet.imageCount} 张图片，{questionSet.isPublic ? "社区公开题库" : "未发布题库"}
                  {questionSet.isPublic ? `，上传者：${getQuestionSetUploaderName(questionSet)}` : ""}
                </p>
              </div>
              <Button type="button" onClick={handleConfirmQuestionSet} disabled={isConfirmingQuestionSet}>
                {isConfirmingQuestionSet ? "确认中…" : "确认使用这个题库"}
              </Button>
            </div>
            <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-6">
              {previewItems.slice(0, 12).map((item) => (
                <figure className="rounded-md border border-[var(--line)] bg-white p-2" key={item.key}>
                  <img alt="" className="aspect-square w-full rounded bg-black object-cover" src={item.url} />
                  <figcaption className="mt-2 truncate text-xs text-[var(--muted)]" title={item.labelText?.trim() || "未填写答案"}>
                    {item.labelText?.trim() || "未填写答案"}
                  </figcaption>
                </figure>
              ))}
              {previewUrls.length === 0
                ? results.slice(0, 12).map((result) =>
                    result.ok ? (
                      <figure className="rounded-md border border-[var(--line)] bg-white p-2" key={result.url}>
                        <img alt="" className="aspect-square w-full rounded bg-black object-cover" src={result.url} />
                        <figcaption className="mt-2 truncate text-xs text-[var(--muted)]">未填写答案</figcaption>
                      </figure>
                    ) : null,
                  )
                : null}
            </div>
            {urlsTextForPreview ? (
              <details className="mt-4">
                <summary className="cursor-pointer text-sm font-semibold text-slate-900">图片链接文本</summary>
                <textarea
                  className="mt-3 min-h-32 w-full rounded-md border border-[var(--line)] bg-white px-3 py-2 text-xs outline-none"
                  readOnly
                  value={urlsTextForPreview}
                />
                <Button className="mt-3" type="button" variant="secondary" onClick={handleCopyUrlsText}>
                  复制图片链接
                </Button>
              </details>
            ) : null}
          </div>
        ) : (
          <div className="rounded-md border border-dashed border-[var(--line)] bg-slate-50 px-4 py-6 text-sm text-[var(--muted)]">
            创建或选择题库后，这里会显示预览
          </div>
        )}
      </section>

      {onCancelPresenterSetup ? (
        <div className="flex justify-end border-t border-[var(--line)] pt-5">
          <Button
            className="w-full sm:w-auto"
            type="button"
            variant="secondary"
            onClick={onCancelPresenterSetup}
            disabled={isCancelingPresenterSetup}
          >
            {isCancelingPresenterSetup ? "撤回中…" : "不当出题人了"}
          </Button>
        </div>
      ) : null}
    </div>
  );
}
