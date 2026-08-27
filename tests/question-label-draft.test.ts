import assert from "node:assert/strict";
import test from "node:test";
import {
  clearQuestionLabelDraft,
  getPlayerAnswerLabelDraft,
  getQuestionLabelDraftStorage,
  getQuestionLabelDraftStorageKey,
  MAX_QUESTION_LABEL_DRAFT_LENGTH,
  readQuestionLabelDraft,
  writeQuestionLabelDraft,
} from "../src/lib/questionLabelDraft";

class MemoryStorage implements Pick<Storage, "getItem" | "setItem" | "removeItem"> {
  private readonly values = new Map<string, string>();

  getItem(key: string) {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string) {
    this.values.set(key, value);
  }

  removeItem(key: string) {
    this.values.delete(key);
  }
}

test("question label drafts are isolated by game and question", () => {
  const storage = new MemoryStorage();
  const firstKey = getQuestionLabelDraftStorageKey("game-1", "question-1");
  const secondKey = getQuestionLabelDraftStorageKey("game-1", "question-2");

  writeQuestionLabelDraft(storage, firstKey, "答案一");
  writeQuestionLabelDraft(storage, secondKey, "答案二");

  assert.equal(readQuestionLabelDraft(storage, firstKey), "答案一");
  assert.equal(readQuestionLabelDraft(storage, secondKey), "答案二");
});

test("question label drafts preserve editable text and enforce the input limit", () => {
  const storage = new MemoryStorage();
  const key = getQuestionLabelDraftStorageKey("game-1", "question-1");
  const longDraft = `  ${"答".repeat(MAX_QUESTION_LABEL_DRAFT_LENGTH)}  `;

  writeQuestionLabelDraft(storage, key, longDraft);

  assert.equal(readQuestionLabelDraft(storage, key), longDraft.slice(0, MAX_QUESTION_LABEL_DRAFT_LENGTH));
});

test("empty and published question label drafts are removed", () => {
  const storage = new MemoryStorage();
  const key = getQuestionLabelDraftStorageKey("game-1", "question-1");

  writeQuestionLabelDraft(storage, key, "暂存答案");
  writeQuestionLabelDraft(storage, key, "");
  assert.equal(readQuestionLabelDraft(storage, key), "");

  writeQuestionLabelDraft(storage, key, "正式答案");
  clearQuestionLabelDraft(storage, key);
  assert.equal(readQuestionLabelDraft(storage, key), "");
});

test("selecting a player answer replaces the editable draft text", () => {
  const answers = [
    { id: "answer-1", answerText: "原玩家答案" },
    { id: "answer-2", answerText: "用于继续修改的玩家答案" },
  ];

  assert.equal(getPlayerAnswerLabelDraft(answers, "answer-2"), "用于继续修改的玩家答案");
  assert.equal(getPlayerAnswerLabelDraft(answers, "missing"), null);
});

test("unavailable browser storage falls back without throwing", () => {
  const brokenStorage: Pick<Storage, "getItem" | "setItem" | "removeItem"> = {
    getItem() { throw new Error("blocked"); },
    setItem() { throw new Error("blocked"); },
    removeItem() { throw new Error("blocked"); },
  };
  const key = getQuestionLabelDraftStorageKey("game-1", "question-1");

  assert.equal(readQuestionLabelDraft(brokenStorage, key), "");
  assert.doesNotThrow(() => writeQuestionLabelDraft(brokenStorage, key, "答案"));
  assert.doesNotThrow(() => clearQuestionLabelDraft(brokenStorage, key));
  assert.equal(getQuestionLabelDraftStorage(), null);
});
