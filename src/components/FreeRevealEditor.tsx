"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";
import type { CSSProperties, PointerEvent as ReactPointerEvent } from "react";
import { moveRevealRect, resizeRevealRect } from "@/lib/freeRevealGeometry";
import type { RevealRect, RevealRegion } from "@/types/game";

type FreeRevealEditorProps = {
  committedRegions: RevealRegion[];
  draftRegions: RevealRect[];
  disabled?: boolean;
  maxRegions: number;
  onDraftRegionsChange: (regions: RevealRect[]) => void;
  onLimitReached: () => void;
};

type DragOperation =
  | { type: "create"; pointerId: number; startX: number; startY: number; index: number }
  | { type: "move"; pointerId: number; startX: number; startY: number; index: number; original: RevealRect }
  | { type: "resize"; pointerId: number; startX: number; startY: number; index: number; original: RevealRect; handle: ResizeHandle };

type ResizeHandle = "n" | "ne" | "e" | "se" | "s" | "sw" | "w" | "nw";

const VIEWBOX_SIZE = 1000;
const MIN_RECT_SIZE = 0.008;
const HANDLES: Array<{ name: ResizeHandle; x: number; y: number; cursor: CSSProperties["cursor"]; label: string }> = [
  { name: "nw", x: 0, y: 0, cursor: "nwse-resize", label: "调整左上角" },
  { name: "n", x: 0.5, y: 0, cursor: "ns-resize", label: "调整上边缘" },
  { name: "ne", x: 1, y: 0, cursor: "nesw-resize", label: "调整右上角" },
  { name: "e", x: 1, y: 0.5, cursor: "ew-resize", label: "调整右边缘" },
  { name: "se", x: 1, y: 1, cursor: "nwse-resize", label: "调整右下角" },
  { name: "s", x: 0.5, y: 1, cursor: "ns-resize", label: "调整下边缘" },
  { name: "sw", x: 0, y: 1, cursor: "nesw-resize", label: "调整左下角" },
  { name: "w", x: 0, y: 0.5, cursor: "ew-resize", label: "调整左边缘" },
];

export function FreeRevealMask({ regions, opacity }: { regions: readonly RevealRect[]; opacity?: number }) {
  const maskId = `free-reveal-mask-${useId().replaceAll(":", "")}`;
  return (
    <svg aria-hidden="true" className="pointer-events-none absolute inset-0 h-full w-full" viewBox={`0 0 ${VIEWBOX_SIZE} ${VIEWBOX_SIZE}`} preserveAspectRatio="none">
      <defs>
        <mask id={maskId} maskUnits="userSpaceOnUse" x="0" y="0" width={VIEWBOX_SIZE} height={VIEWBOX_SIZE}>
          <rect fill="white" x="0" y="0" width={VIEWBOX_SIZE} height={VIEWBOX_SIZE} />
          {regions.map((region, index) => (
            <rect
              fill="black"
              key={"id" in region ? String(region.id) : index}
              x={region.x * VIEWBOX_SIZE}
              y={region.y * VIEWBOX_SIZE}
              width={region.width * VIEWBOX_SIZE}
              height={region.height * VIEWBOX_SIZE}
            />
          ))}
        </mask>
      </defs>
      <rect
        fill="black"
        fillOpacity={opacity ?? "var(--free-reveal-mask-opacity, 0.4)"}
        height={VIEWBOX_SIZE}
        mask={`url(#${maskId})`}
        width={VIEWBOX_SIZE}
        x="0"
        y="0"
      />
    </svg>
  );
}

export function FreeRevealEditor({
  committedRegions,
  draftRegions,
  disabled = false,
  maxRegions,
  onDraftRegionsChange,
  onLimitReached,
}: FreeRevealEditorProps) {
  const svgRef = useRef<SVGSVGElement | null>(null);
  const operationRef = useRef<DragOperation | null>(null);
  const draftRef = useRef(draftRegions);
  const [selectedIndex, setSelectedIndex] = useState<number | null>(null);
  draftRef.current = draftRegions;

  useEffect(() => {
    if (selectedIndex != null && selectedIndex >= draftRegions.length) setSelectedIndex(null);
  }, [draftRegions.length, selectedIndex]);

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        const operation = operationRef.current;
        if (operation?.type === "create") {
          onDraftRegionsChange(draftRef.current.filter((_, index) => index !== operation.index));
        } else if (operation) {
          const next = [...draftRef.current];
          next[operation.index] = operation.original;
          onDraftRegionsChange(next);
        }
        if (operation && svgRef.current?.hasPointerCapture(operation.pointerId)) {
          svgRef.current.releasePointerCapture(operation.pointerId);
        }
        operationRef.current = null;
        setSelectedIndex(null);
      }
      if ((event.key === "Delete" || event.key === "Backspace") && selectedIndex != null) {
        const target = event.target;
        if (target instanceof HTMLElement && target.closest("input, textarea, [contenteditable='true']")) return;
        event.preventDefault();
        onDraftRegionsChange(draftRef.current.filter((_, index) => index !== selectedIndex));
        setSelectedIndex(null);
      }
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onDraftRegionsChange, selectedIndex]);

  const visibleRegions = useMemo(() => [...committedRegions, ...draftRegions], [committedRegions, draftRegions]);
  const selectedRegion = selectedIndex == null ? null : draftRegions[selectedIndex] ?? null;

  function point(event: { clientX: number; clientY: number }) {
    const bounds = svgRef.current?.getBoundingClientRect();
    if (!bounds) return { x: 0, y: 0 };
    return {
      x: Math.min(1, Math.max(0, (event.clientX - bounds.left) / bounds.width)),
      y: Math.min(1, Math.max(0, (event.clientY - bounds.top) / bounds.height)),
    };
  }

  function beginCreate(event: ReactPointerEvent<SVGSVGElement>) {
    if (disabled || event.button !== 0 || event.target !== event.currentTarget) return;
    if (draftRegions.length >= maxRegions) {
      onLimitReached();
      return;
    }
    const start = point(event);
    const index = draftRegions.length;
    const next = [...draftRegions, { x: start.x, y: start.y, width: 0.0001, height: 0.0001 }];
    onDraftRegionsChange(next);
    setSelectedIndex(index);
    operationRef.current = { type: "create", pointerId: event.pointerId, startX: start.x, startY: start.y, index };
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function beginMove(event: ReactPointerEvent<SVGRectElement>, index: number) {
    if (disabled || event.button !== 0) return;
    event.stopPropagation();
    const start = point(event);
    operationRef.current = { type: "move", pointerId: event.pointerId, startX: start.x, startY: start.y, index, original: draftRegions[index] };
    setSelectedIndex(index);
    svgRef.current?.setPointerCapture(event.pointerId);
  }

  function beginResize(event: ReactPointerEvent<HTMLElement>, index: number, handle: ResizeHandle) {
    if (disabled || event.button !== 0) return;
    event.stopPropagation();
    const start = point(event);
    operationRef.current = { type: "resize", pointerId: event.pointerId, startX: start.x, startY: start.y, index, original: draftRegions[index], handle };
    svgRef.current?.setPointerCapture(event.pointerId);
  }

  function handlePointerMove(event: ReactPointerEvent<SVGSVGElement>) {
    const operation = operationRef.current;
    if (!operation || operation.pointerId !== event.pointerId) return;
    const current = point(event);
    const next = [...draftRef.current];
    if (operation.type === "create") {
      next[operation.index] = {
        x: Math.min(operation.startX, current.x),
        y: Math.min(operation.startY, current.y),
        width: Math.max(0.0001, Math.abs(current.x - operation.startX)),
        height: Math.max(0.0001, Math.abs(current.y - operation.startY)),
      };
    } else if (operation.type === "move") {
      next[operation.index] = moveRevealRect(operation.original, current.x - operation.startX, current.y - operation.startY);
    } else {
      next[operation.index] = resizeRevealRect(operation.original, operation.handle, current.x - operation.startX, current.y - operation.startY, MIN_RECT_SIZE, MIN_RECT_SIZE);
    }
    onDraftRegionsChange(next);
  }

  function finishPointer(event: ReactPointerEvent<SVGSVGElement>) {
    const operation = operationRef.current;
    if (!operation || operation.pointerId !== event.pointerId) return;
    operationRef.current = null;
    if (operation.type === "create") {
      const region = draftRef.current[operation.index];
      if (!region || region.width < MIN_RECT_SIZE || region.height < MIN_RECT_SIZE) {
        onDraftRegionsChange(draftRef.current.filter((_, index) => index !== operation.index));
        setSelectedIndex(null);
      }
    }
    if (svgRef.current?.hasPointerCapture(event.pointerId)) svgRef.current.releasePointerCapture(event.pointerId);
  }

  function deleteSelected() {
    if (selectedIndex == null) return;
    onDraftRegionsChange(draftRegions.filter((_, index) => index !== selectedIndex));
    setSelectedIndex(null);
  }

  return (
    <div className="absolute inset-0" style={{ "--free-reveal-mask-opacity": 0.4 } as CSSProperties}>
      <FreeRevealMask regions={visibleRegions} />
      <svg
        aria-label="自由框选区域"
        className={disabled ? "absolute inset-0 h-full w-full" : "absolute inset-0 h-full w-full touch-none cursor-crosshair"}
        preserveAspectRatio="none"
        ref={svgRef}
        role="application"
        viewBox={`0 0 ${VIEWBOX_SIZE} ${VIEWBOX_SIZE}`}
        onPointerCancel={finishPointer}
        onPointerDown={beginCreate}
        onPointerMove={handlePointerMove}
        onPointerUp={finishPointer}
      >
        {committedRegions.map((region) => (
          <rect
            className="pointer-events-none"
            fill="none"
            key={region.id}
            stroke="rgba(255,255,255,0.82)"
            strokeDasharray="8 6"
            strokeWidth="2"
            vectorEffect="non-scaling-stroke"
            x={region.x * VIEWBOX_SIZE}
            y={region.y * VIEWBOX_SIZE}
            width={region.width * VIEWBOX_SIZE}
            height={region.height * VIEWBOX_SIZE}
          />
        ))}
        {draftRegions.map((region, index) => {
          const selected = selectedIndex === index;
          return (
            <g key={index}>
              <rect
                className={disabled ? "pointer-events-none" : "cursor-move"}
                fill="transparent"
                stroke={selected ? "#fb7185" : "#fda4af"}
                strokeWidth={selected ? 3 : 2}
                vectorEffect="non-scaling-stroke"
                x={region.x * VIEWBOX_SIZE}
                y={region.y * VIEWBOX_SIZE}
                width={region.width * VIEWBOX_SIZE}
                height={region.height * VIEWBOX_SIZE}
                onPointerDown={(event) => beginMove(event, index)}
              />
            </g>
          );
        })}
      </svg>
      {!disabled && selectedIndex != null && selectedRegion
        ? HANDLES.map((handle) => (
            <button
              aria-label={handle.label}
              className="absolute z-20 flex h-6 w-6 -translate-x-1/2 -translate-y-1/2 touch-none items-center justify-center rounded-full bg-transparent p-0 focus:outline-none focus-visible:ring-2 focus-visible:ring-white"
              key={handle.name}
              style={{
                cursor: handle.cursor,
                left: `${(selectedRegion.x + selectedRegion.width * handle.x) * 100}%`,
                top: `${(selectedRegion.y + selectedRegion.height * handle.y) * 100}%`,
              }}
              type="button"
              onPointerDown={(event) => beginResize(event, selectedIndex, handle.name)}
            >
              <span className="block h-3 w-3 rounded-full border-2 border-rose-600 bg-white shadow-sm" />
            </button>
          ))
        : null}
      {!disabled && selectedIndex != null ? (
        <button
          className="absolute right-3 top-3 z-30 rounded-md border border-white/70 bg-slate-950/75 px-3 py-2 text-xs font-semibold text-white shadow-sm hover:bg-slate-950 focus:outline-none focus-visible:ring-2 focus-visible:ring-white"
          type="button"
          onClick={deleteSelected}
        >
          删除
        </button>
      ) : null}
    </div>
  );
}
