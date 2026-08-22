import assert from "node:assert/strict";
import test from "node:test";

import {
  buildLocalUploadQuestionImport,
  buildPreparedUrlImportDraft,
  extractCreationToolLabelFromFilename,
  fillBlankDraftAnswersFromFilenames,
  findNearestLocalUploadDropTarget,
  filesToUploadableImages,
  getAnswerCandidateFromFilename,
  getLocalUploadCreationMethod,
  moveLocalUploadDraftQuestionToIndex,
  readDroppedUploadFiles,
  removeLocalUploadDraftQuestion,
  toUploadSourceFiles,
  uploadRemoteImagesToR2,
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

test("ordinary filenames become explicit answer candidates without being applied automatically", () => {
  assert.equal(getAnswerCandidateFromFilename("孤独摇滚.jpg"), "孤独摇滚");
  assert.equal(getAnswerCandidateFromFilename("folder/葬送的芙莉莲.PNG"), "葬送的芙莉莲");
  assert.equal(getAnswerCandidateFromFilename("folder\\轻音少女.jpeg"), "轻音少女");
  assert.equal(getAnswerCandidateFromFilename("01-轻音少女.webp"), "01-轻音少女");
  assert.equal(getAnswerCandidateFromFilename("archive.name.final.jpeg"), "archive.name.final");
  assert.equal(getAnswerCandidateFromFilename(".jpg"), null);
  assert.equal(getAnswerCandidateFromFilename("   "), null);
  assert.equal(getAnswerCandidateFromFilename(`${"答".repeat(81)}.jpg`), null);
});

test("filename fill only populates blank draft answers and preserves existing labels", () => {
  const questions = [
    { key: "one", imageUrl: "https://assets.example.com/one.webp", labelText: null, sourceFileName: "孤独摇滚.jpg" },
    { key: "two", imageUrl: "https://assets.example.com/two.webp", labelText: "工具答案", sourceFileName: "不应覆盖.png" },
    { key: "three", imageUrl: "https://assets.example.com/three.webp", labelText: "  ", sourceFileName: "轻音少女.webp" },
    { key: "four", imageUrl: "https://assets.example.com/four.webp", labelText: null, sourceFileName: null },
    { key: "five", imageUrl: "https://assets.example.com/five.webp", labelText: null, sourceFileName: `${"长".repeat(81)}.jpg` },
  ];

  const filled = fillBlankDraftAnswersFromFilenames(questions);

  assert.deepEqual(filled.map((question) => question.labelText), ["孤独摇滚", "工具答案", "轻音少女", null, null]);
  assert.equal(questions[0]?.labelText, null);
  assert.equal(filled[1], questions[1]);
  assert.equal(filled[3], questions[3]);
});

test("filename fill handles a full 30-question local draft without changing question identity or order", () => {
  const questions = Array.from({ length: 30 }, (_, index) => ({
    key: `question-${index}`,
    imageUrl: `https://assets.example.com/${index}.webp`,
    labelText: null,
    sourceFileName: `动画${index + 1}.jpg`,
  }));

  const filled = fillBlankDraftAnswersFromFilenames(questions);

  assert.deepEqual(filled.map((question) => question.key), questions.map((question) => question.key));
  assert.deepEqual(filled.map((question) => question.imageUrl), questions.map((question) => question.imageUrl));
  assert.deepEqual(filled.map((question) => question.labelText), Array.from({ length: 30 }, (_, index) => `动画${index + 1}`));
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
    { key: "questions/001-答案一-mosaic.jpg", imageUrl: "https://assets.example.com/one.webp", labelText: "答案一", sourceFileName: "001-答案一-mosaic.jpg" },
    { key: "questions/002-答案二.jpg", imageUrl: "https://assets.example.com/two.webp", labelText: null, sourceFileName: "002-答案二.jpg" },
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
    { key: "easy.jpg", imageUrl: "https://assets.example.com/easy.webp", labelText: null, sourceFileName: "easy.jpg" },
    { key: "medium.jpg", imageUrl: "https://assets.example.com/medium.webp", labelText: null, sourceFileName: "medium.jpg" },
    { key: "hard.jpg", imageUrl: "https://assets.example.com/hard.webp", labelText: null, sourceFileName: "hard.jpg" },
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

test("prepared URL imports become stable editable drafts", () => {
  const draft = buildPreparedUrlImportDraft([
    { imageUrl: "https://assets.example.com/one.webp", labelText: " 答案一 ", r2Key: "question-images/one.webp" },
    { imageUrl: "https://assets.example.com/two.webp", labelText: "" },
    { imageUrl: "https://assets.example.com/two.webp", labelText: null },
  ]);

  assert.deepEqual(draft.map((question) => question.imageUrl), [
    "https://assets.example.com/one.webp",
    "https://assets.example.com/two.webp",
    "https://assets.example.com/two.webp",
  ]);
  assert.deepEqual(draft.map((question) => question.labelText), ["答案一", null, null]);
  assert.deepEqual(draft.map((question) => question.sourceFileName), [null, null, null]);
  assert.equal(new Set(draft.map((question) => question.key)).size, draft.length);
});

test("remote imports preserve order and labels while processing mobile-sized pools sequentially", async () => {
  const inputs = Array.from({ length: 30 }, (_, orderIndex) => ({
    imageUrl: `https://source.example.com/${orderIndex}.jpg`,
    labelText: `答案${orderIndex}`,
    orderIndex,
  }));
  let active = 0;
  let maxActive = 0;
  const result = await uploadRemoteImagesToR2(inputs, "room", "presenter", () => {}, {
    concurrency: 1,
    async fetchSource(input) {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await Promise.resolve();
      active -= 1;
      return { blob: new Blob([String(input.orderIndex)], { type: "image/jpeg" }), name: `${input.orderIndex}.jpg` };
    },
    async prepare(source) {
      return { blob: source.blob, uploadName: source.name, rawBytes: source.blob.size, uploadBytes: source.blob.size, usedOriginal: true };
    },
    async upload(prepared) {
      const index = prepared.uploadName.replace(".jpg", "");
      return { key: `question-images/${index}.jpg`, url: `https://assets.example.com/${index}.jpg`, publicId: index };
    },
  });

  assert.equal(maxActive, 1);
  assert.equal(result.failedQuestions.length, 0);
  assert.deepEqual(result.preparedQuestions.map((item) => item.orderIndex), inputs.map((item) => item.orderIndex));
  assert.deepEqual(result.preparedQuestions.map((item) => item.labelText), inputs.map((item) => item.labelText));
});

test("remote import retries can target only failures without repeating successful uploads", async () => {
  const inputs = [0, 1, 2].map((orderIndex) => ({ imageUrl: `https://source.example.com/${orderIndex}.jpg`, orderIndex }));
  const attempts = new Map<number, number>();
  const dependencies = {
    concurrency: 2,
    async fetchSource(input: { imageUrl: string; orderIndex: number }) {
      attempts.set(input.orderIndex, (attempts.get(input.orderIndex) ?? 0) + 1);
      if (input.orderIndex === 1 && attempts.get(1) === 1) throw new Error("temporary failure");
      return { blob: new Blob([String(input.orderIndex)], { type: "image/jpeg" }), name: `${input.orderIndex}.jpg` };
    },
    async prepare(source: { blob: Blob; name: string }) {
      return { blob: source.blob, uploadName: source.name, rawBytes: source.blob.size, uploadBytes: source.blob.size, usedOriginal: true };
    },
    async upload(prepared: { uploadName: string }) {
      return { key: prepared.uploadName, url: `https://assets.example.com/${prepared.uploadName}`, publicId: prepared.uploadName };
    },
  };
  const first = await uploadRemoteImagesToR2(inputs, "room", "presenter", () => {}, dependencies);
  assert.deepEqual(first.preparedQuestions.map((item) => item.orderIndex), [0, 2]);
  assert.deepEqual(first.failedQuestions.map((item) => item.orderIndex), [1]);

  const retry = await uploadRemoteImagesToR2(
    first.failedQuestions.map(({ error: _error, ...item }) => item),
    "room",
    "presenter",
    () => {},
    dependencies,
  );
  assert.deepEqual(retry.preparedQuestions.map((item) => item.orderIndex), [1]);
  assert.deepEqual(Object.fromEntries(attempts), { 0: 1, 1: 2, 2: 1 });
});

test("external URL imports fetch only through the authorized Worker source endpoint", async () => {
  const originalFetch = globalThis.fetch;
  const calls: Array<{ url: string; method: string; body: string }> = [];
  globalThis.fetch = async (input, init) => {
    calls.push({
      url: String(input),
      method: init?.method ?? "GET",
      body: typeof init?.body === "string" ? init.body : "",
    });
    return new Response(new Uint8Array([1, 2, 3]), {
      status: 200,
      headers: { "content-type": "image/jpeg", "content-length": "3" },
    });
  };
  try {
    const result = await uploadRemoteImagesToR2(
      [{ imageUrl: "https://blocked-overseas.example.com/one.jpg", labelText: "答案", orderIndex: 0 }],
      "room-1",
      "presenter-1",
      () => {},
      {
        concurrency: 1,
        async prepare(source) {
          return { blob: source.blob, uploadName: source.name, rawBytes: source.blob.size, uploadBytes: source.blob.size, usedOriginal: true };
        },
        async upload(prepared) {
          return { key: prepared.uploadName, url: `https://assets.example.com/${prepared.uploadName}`, publicId: prepared.uploadName };
        },
      },
    );
    assert.equal(result.failedQuestions.length, 0);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "/api/remote-image-source");
    assert.equal(calls[0].method, "POST");
    assert.deepEqual(JSON.parse(calls[0].body), {
      roomId: "room-1",
      presenterPlayerId: "presenter-1",
      imageUrl: "https://blocked-overseas.example.com/one.jpg",
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
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
