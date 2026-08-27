const QUESTION_LABEL_DRAFT_STORAGE_PREFIX = "animeMaster.questionLabelDraft";
export const MAX_QUESTION_LABEL_DRAFT_LENGTH = 80;

type QuestionLabelDraftStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

export function getQuestionLabelDraftStorage() {
  if (typeof window === "undefined") return null;

  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

export function getQuestionLabelDraftStorageKey(gameSessionId: string, questionId: string) {
  return `${QUESTION_LABEL_DRAFT_STORAGE_PREFIX}:${gameSessionId}:${questionId}`;
}

export function readQuestionLabelDraft(storage: QuestionLabelDraftStorage | null, storageKey: string) {
  if (!storage) return "";

  try {
    return (storage.getItem(storageKey) ?? "").slice(0, MAX_QUESTION_LABEL_DRAFT_LENGTH);
  } catch {
    return "";
  }
}

export function writeQuestionLabelDraft(storage: QuestionLabelDraftStorage | null, storageKey: string, value: string) {
  if (!storage) return;

  try {
    const nextValue = value.slice(0, MAX_QUESTION_LABEL_DRAFT_LENGTH);
    if (nextValue) {
      storage.setItem(storageKey, nextValue);
    } else {
      storage.removeItem(storageKey);
    }
  } catch {
    // Restricted browser modes can reject sessionStorage; the in-memory draft remains available.
  }
}

export function clearQuestionLabelDraft(storage: QuestionLabelDraftStorage | null, storageKey: string) {
  if (!storage) return;

  try {
    storage.removeItem(storageKey);
  } catch {
    // Restricted browser modes can reject sessionStorage; there is nothing else to clear.
  }
}

export function getPlayerAnswerLabelDraft(
  answers: ReadonlyArray<{ id: string; answerText: string }>,
  answerId: string,
) {
  return answers.find((answer) => answer.id === answerId)?.answerText ?? null;
}
