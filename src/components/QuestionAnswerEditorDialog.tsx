"use client";

import { KeyboardEvent, useEffect, useId, useMemo, useRef, useState } from "react";
import { Button } from "@/components/Button";
import {
  fillBlankDraftAnswersFromFilenames,
  getAnswerCandidateFromFilename,
  type LocalUploadDraftQuestion,
} from "@/lib/r2Upload";

type QuestionAnswerEditorDialogProps = {
  questions: LocalUploadDraftQuestion[];
  onQuestionsChange: (questions: LocalUploadDraftQuestion[]) => void;
  onClose: () => void;
};

const focusableSelector = [
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "[tabindex]:not([tabindex='-1'])",
].join(",");

export function QuestionAnswerEditorDialog({
  questions,
  onQuestionsChange,
  onClose,
}: QuestionAnswerEditorDialogProps) {
  const titleId = useId();
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const closeButtonRef = useRef<HTMLButtonElement | null>(null);
  const [notice, setNotice] = useState("");
  const answerCount = useMemo(
    () => questions.filter((question) => Boolean(question.labelText?.trim())).length,
    [questions],
  );
  const hasSourceFilenames = questions.some((question) => Boolean(question.sourceFileName));

  useEffect(() => {
    const previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    closeButtonRef.current?.focus();

    return () => {
      document.body.style.overflow = previousOverflow;
      previouslyFocused?.focus();
    };
  }, []);

  function handleDialogKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === "Escape") {
      event.preventDefault();
      onClose();
      return;
    }

    if (event.key !== "Tab") {
      return;
    }

    const focusableItems = Array.from(dialogRef.current?.querySelectorAll<HTMLElement>(focusableSelector) ?? []);
    if (focusableItems.length === 0) {
      event.preventDefault();
      return;
    }

    const firstItem = focusableItems[0];
    const lastItem = focusableItems[focusableItems.length - 1];
    if (event.shiftKey && document.activeElement === firstItem) {
      event.preventDefault();
      lastItem.focus();
    } else if (!event.shiftKey && document.activeElement === lastItem) {
      event.preventDefault();
      firstItem.focus();
    }
  }

  function handleFillFromFilenames() {
    const fillableCount = questions.filter(
      (question) => !question.labelText?.trim() && Boolean(getAnswerCandidateFromFilename(question.sourceFileName)),
    ).length;
    const invalidFilenameCount = questions.filter(
      (question) => question.sourceFileName && !question.labelText?.trim() && !getAnswerCandidateFromFilename(question.sourceFileName),
    ).length;

    if (fillableCount === 0) {
      setNotice(
        invalidFilenameCount > 0
          ? "有文件名为空或超过 80 字，请手动填写。"
          : "没有需要填入的空白答案。",
      );
      return;
    }

    onQuestionsChange(fillBlankDraftAnswersFromFilenames(questions));
    setNotice(
      invalidFilenameCount > 0
        ? `已填入 ${fillableCount} 个答案，另有 ${invalidFilenameCount} 个文件名需要手动处理。`
        : `已从文件名填入 ${fillableCount} 个答案。`,
    );
  }

  function handleAnswerChange(questionKey: string, labelText: string) {
    setNotice("");
    onQuestionsChange(
      questions.map((question) => (question.key === questionKey ? { ...question, labelText } : question)),
    );
  }

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-slate-950/45 px-3 py-4 sm:px-5 sm:py-6">
      <div
        aria-labelledby={titleId}
        aria-modal="true"
        className="flex max-h-[92vh] w-full max-w-5xl flex-col overflow-hidden rounded-lg border border-[var(--line)] bg-white shadow-2xl"
        onKeyDown={handleDialogKeyDown}
        ref={dialogRef}
        role="dialog"
      >
        <div className="flex items-start justify-between gap-4 border-b border-[var(--line)] px-4 py-4 sm:px-5">
          <div className="min-w-0">
            <h2 className="text-lg font-semibold text-slate-950" id={titleId}>预设答案</h2>
            <p className="mt-1 text-sm leading-5 text-[var(--muted)]">
              建议在游戏中确认答案，可直接选用玩家回答；容易忘记的题也可提前填写。
            </p>
            <p className="mt-2 text-xs font-medium text-slate-600">已预设 {answerCount}/{questions.length} 个答案</p>
          </div>
          <button
            aria-label="关闭答案编辑"
            className="grid h-9 w-9 shrink-0 place-items-center rounded-md border border-[var(--line)] text-xl leading-none text-slate-600 transition hover:bg-slate-50 focus:outline-none focus:ring-4 focus:ring-rose-100"
            onClick={onClose}
            ref={closeButtonRef}
            type="button"
          >
            ×
          </button>
        </div>

        <div className="flex flex-col gap-3 border-b border-[var(--line)] bg-slate-50 px-4 py-3 sm:flex-row sm:items-center sm:justify-between sm:px-5">
          <p aria-live="polite" className="min-h-5 text-sm text-[var(--muted)]">
            {notice || (hasSourceFilenames ? "只填空白项，不覆盖已编辑答案。" : "答案可留空。")}
          </p>
          {hasSourceFilenames ? (
            <Button className="shrink-0" type="button" variant="secondary" onClick={handleFillFromFilenames}>
              从文件名填入
            </Button>
          ) : null}
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto p-4 sm:p-5">
          <div className="grid gap-3 md:grid-cols-2">
            {questions.map((question, index) => (
              <div className="grid grid-cols-[6rem_minmax(0,1fr)] gap-3 rounded-md border border-[var(--line)] bg-slate-50 p-3 sm:grid-cols-[8rem_minmax(0,1fr)]" key={question.key}>
                <img
                  alt={`第 ${index + 1} 题预览`}
                  className="aspect-video w-full rounded bg-black object-contain"
                  src={question.imageUrl}
                />
                <label className="min-w-0">
                  <span className="flex min-w-0 items-baseline gap-2">
                    <span className="shrink-0 text-sm font-semibold text-slate-950">第 {index + 1} 题</span>
                    {question.sourceFileName ? (
                      <span className="min-w-0 truncate text-xs text-[var(--muted)]" title={question.sourceFileName}>
                        {question.sourceFileName}
                      </span>
                    ) : null}
                  </span>
                  <input
                    className="mt-2 h-10 w-full rounded-md border border-[var(--line)] bg-white px-3 text-sm outline-none transition placeholder:text-slate-400 focus:border-[var(--primary)] focus:ring-4 focus:ring-rose-100"
                    maxLength={80}
                    placeholder="留空则在游戏中确认"
                    value={question.labelText ?? ""}
                    onChange={(event) => handleAnswerChange(question.key, event.target.value)}
                  />
                </label>
              </div>
            ))}
          </div>
        </div>

        <div className="flex justify-end border-t border-[var(--line)] bg-slate-50 px-4 py-3 sm:px-5">
          <Button type="button" onClick={onClose}>完成</Button>
        </div>
      </div>
    </div>
  );
}
