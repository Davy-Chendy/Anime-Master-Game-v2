import assert from "node:assert/strict";
import test from "node:test";

import {
  buildLocalUploadQuestionImport,
  extractCreationToolLabelFromFilename,
  findNearestLocalUploadDropTarget,
  filesToUploadableImages,
  getLocalUploadCreationMethod,
  moveLocalUploadDraftQuestionToIndex,
  readDroppedUploadFiles,
  removeLocalUploadDraftQuestion,
  toUploadSourceFiles,
} from "../src/lib/r2Upload";

type TestEntry = {
  isFile: boolean;
  isDirectory: boolean;
  name: string;
  fullPath?: string;
  file?: (success: (file: File) => void) => void;
  createReader?: () => {
    readEntries: (success: (entries: TestEntry[]) => void) => void;
  };
};

function imageFile(name: string, type = "image/jpeg") {
  return {
    name,
    type,
    size: 128,
    webkitRelativePath: "",
  } as File;
}

function fileEntry(path: string, file: File): TestEntry {
  return {
    isFile: true,
    isDirectory: false,
    name: file.name,
    fullPath: path,
    file: (success) => success(file),
  };
}

function directoryEntry(name: string, batches: TestEntry[][]): TestEntry {
  return {
    isFile: false,
    isDirectory: true,
    name,
    fullPath: `/${name}`,
    createReader: () => {
      let index = 0;
      return {
        readEntries: (success) => success(batches[index++] ?? []),
      };
    },
  };
}

function transferItem(entry: TestEntry, fallbackFile: File | null = null) {
  return {
    kind: "file",
    getAsFile: () => fallbackFile,
    webkitGetAsEntry: () => entry,
  } as unknown as DataTransferItem;
}

test("creation-tool filenames extract the full answer between the ordinal and mosaic suffix", () => {
  assert.equal(
    extractCreationToolLabelFromFilename("001-樱满集-罪恶王冠-mosaic.jpg"),
    "樱满集-罪恶王冠",
  );
  assert.equal(extractCreationToolLabelFromFilename("12-角色名-作品名-MOSAIC.WEBP"), "角色名-作品名");
  assert.equal(extractCreationToolLabelFromFilename("folder/003-答案-mosaic.png"), "答案");
  assert.equal(extractCreationToolLabelFromFilename("001-答案.jpg"), null);
  assert.equal(extractCreationToolLabelFromFilename("001--mosaic.jpg"), null);
  assert.equal(extractCreationToolLabelFromFilename("001-答案-mosaic.txt"), null);
});

test("local uploads are tool-assisted only when every successful image has an extracted answer", () => {
  assert.equal(getLocalUploadCreationMethod(["答案一", "答案二"]), "creation_tool_assisted");
  assert.equal(getLocalUploadCreationMethod(["答案一", null]), "player_manual");
  assert.equal(getLocalUploadCreationMethod(["答案一", "  "]), "player_manual");
  assert.equal(getLocalUploadCreationMethod([]), "player_manual");
});

test("successful upload results stay paired with filenames and determine the whole-set creation method", () => {
  const recognized = imageFile("001-答案一-mosaic.jpg");
  const unrecognized = imageFile("002-答案二.jpg");
  const items = filesToUploadableImages([
    { file: recognized, path: "questions/001-答案一-mosaic.jpg" },
    { file: unrecognized, path: "questions/002-答案二.jpg" },
  ]);
  const successResult = (path: string, url: string) => ({
    ok: true as const,
    path,
    url,
    r2Key: path,
    publicId: path,
    rawBytes: 128,
    uploadBytes: 64,
    usedOriginal: false,
  });

  const mixed = buildLocalUploadQuestionImport(items, [
    successResult("questions/001-答案一-mosaic.jpg", "https://assets.example.com/one.webp"),
    successResult("questions/002-答案二.jpg", "https://assets.example.com/two.webp"),
  ]);
  assert.deepEqual(mixed.questions, [
    { key: "questions/001-答案一-mosaic.jpg", imageUrl: "https://assets.example.com/one.webp", labelText: "答案一" },
    { key: "questions/002-答案二.jpg", imageUrl: "https://assets.example.com/two.webp", labelText: null },
  ]);
  assert.equal(mixed.creationMethod, "player_manual");

  const recognizedOnly = buildLocalUploadQuestionImport(items, [
    successResult("questions/001-答案一-mosaic.jpg", "https://assets.example.com/one.webp"),
    { ok: false as const, path: "questions/002-答案二.jpg", error: "failed", rawBytes: 128 },
  ]);
  assert.equal(recognizedOnly.creationMethod, "creation_tool_assisted");
});

test("local upload drafts can be reordered without mutating the original list", () => {
  const questions = [
    { key: "easy.jpg", imageUrl: "https://assets.example.com/easy.webp", labelText: null },
    { key: "medium.jpg", imageUrl: "https://assets.example.com/medium.webp", labelText: null },
    { key: "hard.jpg", imageUrl: "https://assets.example.com/hard.webp", labelText: null },
  ];

  const reordered = moveLocalUploadDraftQuestionToIndex(questions, "hard.jpg", 0);

  assert.deepEqual(reordered.map((question) => question.key), ["hard.jpg", "easy.jpg", "medium.jpg"]);
  assert.deepEqual(questions.map((question) => question.key), ["easy.jpg", "medium.jpg", "hard.jpg"]);
  assert.equal(moveLocalUploadDraftQuestionToIndex(questions, "missing.jpg", 0), questions);

  const insertedBetween = moveLocalUploadDraftQuestionToIndex(questions, "easy.jpg", 2);
  assert.deepEqual(insertedBetween.map((question) => question.key), ["medium.jpg", "easy.jpg", "hard.jpg"]);
  const movedToEnd = moveLocalUploadDraftQuestionToIndex(questions, "easy.jpg", questions.length);
  assert.deepEqual(movedToEnd.map((question) => question.key), ["medium.jpg", "hard.jpg", "easy.jpg"]);

  const remaining = removeLocalUploadDraftQuestion(reordered, "easy.jpg");
  assert.deepEqual(remaining.map((question) => question.key), ["hard.jpg", "medium.jpg"]);
  assert.deepEqual(reordered.map((question) => question.key), ["hard.jpg", "easy.jpg", "medium.jpg"]);
});

test("local upload drop targets cover card edges, grid gaps, and trailing blank space", () => {
  const cardRects = [
    { key: "one", index: 0, left: 0, right: 160, top: 0, bottom: 90 },
    { key: "two", index: 1, left: 176, right: 336, top: 0, bottom: 90 },
    { key: "three", index: 2, left: 0, right: 160, top: 106, bottom: 196 },
  ];

  assert.deepEqual(findNearestLocalUploadDropTarget(-30, 45, cardRects), {
    insertionIndex: 0,
    cardKey: "one",
    side: "before",
  });
  assert.deepEqual(findNearestLocalUploadDropTarget(168, 45, cardRects), {
    insertionIndex: 1,
    cardKey: "one",
    side: "after",
  });
  assert.deepEqual(findNearestLocalUploadDropTarget(40, 100, cardRects), {
    insertionIndex: 2,
    cardKey: "three",
    side: "before",
  });
  assert.deepEqual(findNearestLocalUploadDropTarget(500, 150, cardRects), {
    insertionIndex: 3,
    cardKey: "three",
    side: "after",
  });
});

test("local upload drop target rejects unusable pointer or card geometry", () => {
  assert.equal(findNearestLocalUploadDropTarget(0, 0, []), null);
  assert.equal(findNearestLocalUploadDropTarget(Number.NaN, 0, [
    { key: "one", index: 0, left: 0, right: 160, top: 0, bottom: 90 },
  ]), null);
  assert.equal(findNearestLocalUploadDropTarget(0, 0, [
    { key: "invalid", index: 0, left: Number.NaN, right: 160, top: 0, bottom: 90 },
  ]), null);
});

test("folder drops read every current-level batch and ignore nested directories", async () => {
  const first = imageFile("001-答案一-mosaic.jpg");
  const second = imageFile("002-答案二-mosaic.jpg");
  const nested = directoryEntry("nested", [[]]);
  const folder = directoryEntry("questions", [
    [fileEntry("/questions/001-答案一-mosaic.jpg", first)],
    [fileEntry("/questions/002-答案二-mosaic.jpg", second), nested],
    [],
  ]);
  const loose = imageFile("003-答案三-mosaic.jpg");
  const dataTransfer = {
    items: [
      transferItem(fileEntry("/003-答案三-mosaic.jpg", loose), loose),
      transferItem(folder),
    ],
    files: [],
  } as unknown as DataTransfer;

  const dropped = await readDroppedUploadFiles(dataTransfer);

  assert.deepEqual(dropped.files.map((item) => item.path), [
    "003-答案三-mosaic.jpg",
    "questions/001-答案一-mosaic.jpg",
    "questions/002-答案二-mosaic.jpg",
  ]);
  assert.equal(dropped.skippedDirectoryCount, 1);
});

test("plain file drops keep the browser file-list fallback and explicit folder paths remain distinct", async () => {
  const first = imageFile("same.jpg");
  const second = imageFile("same.jpg");
  const fallbackTransfer = {
    items: [],
    files: [first],
  } as unknown as DataTransfer;

  const fallback = await readDroppedUploadFiles(fallbackTransfer);
  assert.deepEqual(fallback.files.map((item) => item.path), ["same.jpg"]);

  const uploadable = filesToUploadableImages([
    { file: first, path: "folder-a/same.jpg" },
    { file: second, path: "folder-b/same.jpg" },
  ]);
  assert.deepEqual(uploadable.map((item) => item.path), ["folder-a/same.jpg", "folder-b/same.jpg"]);
  assert.deepEqual(toUploadSourceFiles([first]).map((item) => item.path), ["same.jpg"]);
});
