"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import { GripVertical, X } from "lucide-react";
import { cn } from "@/lib/utils";

export interface SplitPaneProps {
  children: [React.ReactNode, React.ReactNode];
  direction?: "horizontal" | "vertical";
  defaultSize?: number;
  minSize?: number;
  maxSize?: number;
  className?: string;
  onResize?: (size: number) => void;
}

export function SplitPane({
  children,
  direction = "horizontal",
  defaultSize = 50,
  minSize = 20,
  maxSize = 80,
  className,
  onResize,
}: SplitPaneProps) {
  const [size, setSize] = useState(defaultSize);
  const [isResizing, setIsResizing] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const resizerRef = useRef<HTMLDivElement>(null);

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    setIsResizing(true);
  }, []);

  const handleMouseMove = useCallback(
    (e: MouseEvent) => {
      if (!isResizing || !containerRef.current) {
        return;
      }

      const containerRect = containerRef.current.getBoundingClientRect();
      let newSize: number;

      if (direction === "horizontal") {
        const containerWidth = containerRect.width;
        const offsetX = e.clientX - containerRect.left;
        newSize = (offsetX / containerWidth) * 100;
      } else {
        const containerHeight = containerRect.height;
        const offsetY = e.clientY - containerRect.top;
        newSize = (offsetY / containerHeight) * 100;
      }

      // Clamp size between min and max
      newSize = Math.max(minSize, Math.min(maxSize, newSize));
      setSize(newSize);
      onResize?.(newSize);
    },
    [isResizing, direction, minSize, maxSize, onResize]
  );

  const handleMouseUp = useCallback(() => {
    setIsResizing(false);
  }, []);

  useEffect(() => {
    if (isResizing) {
      window.addEventListener("mousemove", handleMouseMove);
      window.addEventListener("mouseup", handleMouseUp);
    }

    return () => {
      window.removeEventListener("mousemove", handleMouseMove);
      window.removeEventListener("mouseup", handleMouseUp);
    };
  }, [isResizing, handleMouseMove, handleMouseUp]);

  const handleDoubleClick = useCallback(() => {
    setSize(defaultSize);
    onResize?.(defaultSize);
  }, [defaultSize, onResize]);

  const isHorizontal = direction === "horizontal";

  return (
    <div
      ref={containerRef}
      className={cn("flex relative", isHorizontal ? "flex-row" : "flex-col", className)}
    >
      {/* First pane */}
      <div style={{ flex: `0 0 ${size}%` }} className="overflow-hidden">
        {children[0]}
      </div>

      {/* Resizer */}
      <div
        ref={resizerRef}
        onMouseDown={handleMouseDown}
        onDoubleClick={handleDoubleClick}
        className={cn(
          "flex items-center justify-center cursor-col hover:bg-blue-100 dark:hover:bg-blue-900 transition-colors z-10",
          isHorizontal ? "w-2 cursor-col-resize" : "h-2 cursor-row-resize"
        )}
        style={{ flex: "0 0 auto" }}
      >
        <GripVertical className={cn("h-4 w-4 text-gray-400", !isHorizontal && "rotate-90")} />
      </div>

      {/* Second pane */}
      <div style={{ flex: `0 0 ${100 - size}%` }} className="overflow-hidden">
        {children[1]}
      </div>
    </div>
  );
}

export interface ResizablePaneProps {
  children: React.ReactNode;
  onResize?: (size: number) => void;
  onClose?: () => void;
  showCloseButton?: boolean;
  className?: string;
}

export function ResizablePane({
  children,
  onResize,
  onClose,
  showCloseButton = false,
  className,
}: ResizablePaneProps) {
  const [isResizing, setIsResizing] = useState(false);
  const [size, setSize] = useState(300);
  const paneRef = useRef<HTMLDivElement>(null);
  const resizerRef = useRef<HTMLDivElement>(null);

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    setIsResizing(true);
  }, []);

  const handleMouseMove = useCallback(
    (e: MouseEvent) => {
      if (!isResizing || !paneRef.current) {
        return;
      }

      const paneRect = paneRef.current.getBoundingClientRect();
      const newSize = e.clientX - paneRect.left;
      setSize(newSize);
      onResize?.(newSize);
    },
    [isResizing, onResize]
  );

  const handleMouseUp = useCallback(() => {
    setIsResizing(false);
  }, []);

  useEffect(() => {
    if (isResizing) {
      window.addEventListener("mousemove", handleMouseMove);
      window.addEventListener("mouseup", handleMouseUp);
    }

    return () => {
      window.removeEventListener("mousemove", handleMouseMove);
      window.removeEventListener("mouseup", handleMouseUp);
    };
  }, [isResizing, handleMouseMove, handleMouseUp]);

  return (
    <div
      ref={paneRef}
      className={cn("relative flex", className)}
      style={{ width: isResizing ? `${size}px` : undefined }}
    >
      {children}

      {onClose && showCloseButton && (
        <button
          onClick={onClose}
          className="absolute top-2 right-2 p-1 hover:bg-gray-200 dark:hover:bg-gray-700 rounded transition-colors"
        >
          <X className="h-4 w-4 text-gray-500" />
        </button>
      )}

      <div
        ref={resizerRef}
        onMouseDown={handleMouseDown}
        className="absolute right-0 top-0 bottom-0 w-2 cursor-col-resize hover:bg-blue-100 dark:hover:bg-blue-900 transition-colors"
      >
        <GripVertical className="h-4 w-4 text-gray-400 absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2" />
      </div>
    </div>
  );
}
