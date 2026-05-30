"use client";

import { CheckCircle, XCircle, AlertTriangle, Info, X } from "lucide-react";
import { useToast } from "./toast-provider";
import { useEffect } from "react";
import { cn } from "@/lib/utils";

export function ToastContainer() {
  const { toasts, removeToast } = useToast();

  return (
    <div className="fixed top-4 right-4 z-50 flex flex-col gap-2 max-w-sm w-full">
      {toasts.map(toast => (
        <Toast key={toast.id} toast={toast} onRemove={() => removeToast(toast.id)} />
      ))}
    </div>
  );
}

function Toast({ toast, onRemove }: { toast: Toast; onRemove: () => void }) {
  useEffect(() => {
    // Auto-focus toast for screen readers
    const toastElement = document.getElementById(`toast-${toast.id}`);
    if (toastElement) {
      toastElement.focus();
    }
  }, [toast.id]);

  const icons = {
    success: <CheckCircle className="h-5 w-5 text-green-500" />,
    error: <XCircle className="h-5 w-5 text-red-500" />,
    warning: <AlertTriangle className="h-5 w-5 text-yellow-500" />,
    info: <Info className="h-5 w-5 text-blue-500" />,
  };

  const bgColors = {
    success: "bg-green-50 dark:bg-green-950 border-green-200 dark:border-green-800",
    error: "bg-red-50 dark:bg-red-950 border-red-200 dark:border-red-800",
    warning: "bg-yellow-50 dark:bg-yellow-950 border-yellow-200 dark:border-yellow-800",
    info: "bg-blue-50 dark:bg-blue-950 border-blue-200 dark:border-blue-800",
  };

  return (
    <div
      id={`toast-${toast.id}`}
      className={cn(
        "relative flex items-start gap-3 p-4 rounded-lg border shadow-lg animate-in slide-in-from-right-full fade-in duration-300",
        bgColors[toast.type]
      )}
      role="alert"
      tabIndex={0}
      onKeyDown={e => {
        if (e.key === "Escape") {
          onRemove();
        }
      }}
    >
      <div className="flex-shrink-0 mt-0.5">{icons[toast.type]}</div>

      <div className="flex-1 min-w-0">
        <h4 className="text-sm font-medium text-gray-900 dark:text-gray-100">{toast.title}</h4>
        {toast.description && (
          <p className="mt-1 text-sm text-gray-600 dark:text-gray-400">{toast.description}</p>
        )}
        {toast.action && (
          <button
            onClick={toast.action.onClick}
            className="mt-2 text-sm font-medium text-blue-600 dark:text-blue-400 hover:underline"
          >
            {toast.action.label}
          </button>
        )}
      </div>

      <button
        onClick={onRemove}
        className="flex-shrink-0 text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 transition-colors"
        aria-label="Close toast"
      >
        <X className="h-4 w-4" />
      </button>
    </div>
  );
}
