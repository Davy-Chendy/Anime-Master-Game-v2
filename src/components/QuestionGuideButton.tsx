"use client";

import { useEffect, useId, useState } from "react";
import { Button } from "@/components/Button";

export function QuestionGuideButton({ className = "" }: { className?: string }) {
  const [isOpen, setIsOpen] = useState(false);
  const titleId = useId();

  useEffect(() => {
    if (!isOpen) {
      return;
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setIsOpen(false);
      }
    }

    window.addEventListener("keydown", handleKeyDown);

    return () => {
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [isOpen]);

  return (
    <>
      <Button className={className} type="button" onClick={() => setIsOpen(true)}>
        如何出题
      </Button>

      {isOpen ? (
        <div
          aria-labelledby={titleId}
          aria-modal="true"
          className="fixed inset-0 z-50 grid place-items-center bg-slate-950/45 px-4 py-6"
          role="dialog"
        >
          <div className="w-full max-w-lg rounded-lg border border-[var(--line)] bg-white p-5 shadow-2xl">
            <div className="flex items-start justify-between gap-4">
              <div>
                <h2 className="text-xl font-bold text-slate-950" id={titleId}>
                  如何出题
                </h2>
                <p className="mt-2 text-sm leading-6 text-slate-700">
                  建议每个题库准备 <span className="font-bold text-[var(--primary)]">10 张</span> 左右
                </p>
              </div>
              <button
                aria-label="关闭"
                className="grid h-9 w-9 shrink-0 place-items-center rounded-md border border-[var(--line)] text-xl leading-none text-slate-600 transition hover:bg-slate-50"
                type="button"
                onClick={() => setIsOpen(false)}
              >
                ×
              </button>
            </div>

            <div className="mt-5 space-y-4 text-sm leading-6 text-slate-700">
              <section className="rounded-md border border-[var(--line)] bg-slate-50 p-4">
                <h3 className="font-semibold text-slate-950">方法一：自行准备题库</h3>
                <p className="mt-2">先把图片放进一个文件夹。游戏时上传这个文件夹中的图片即可</p>
              </section>

              <section className="rounded-md border border-[var(--line)] bg-slate-50 p-4">
                <h3 className="font-semibold text-slate-950">方法二：使用动画截图工具</h3>
                <p className="mt-2">可以用在线工具快速找到目标动画截图，构建题库</p>
                <div className="mt-3">
                  <a
                    className="inline-flex min-h-11 items-center justify-center rounded-md bg-[var(--primary)] px-4 py-2 text-sm font-semibold text-white shadow-sm transition hover:-translate-y-0.5 hover:shadow-md focus:outline-none focus:ring-4 focus:ring-rose-100"
                    href="https://screenshot-picker.animaster.dpdns.org/"
                    rel="noreferrer"
                    target="_blank"
                  >
                    打开动画截图工具
                  </a>
                  <p className="mt-2 text-xs text-[var(--muted)]">
                    会在新标签页打开。整理好截图或链接后，被选为出题人时可在房间里上传或导入
                  </p>
                </div>
              </section>
            </div>

            <div className="mt-5 flex justify-end">
              <Button type="button" variant="secondary" onClick={() => setIsOpen(false)}>
                知道了
              </Button>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}
