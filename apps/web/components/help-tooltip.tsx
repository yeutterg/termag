"use client";

import { useState, useRef, useEffect } from "react";
import { HelpCircle, X, ExternalLink } from "lucide-react";
import { cn } from "@/lib/utils";

interface HelpTooltipProps {
  content: string | React.ReactNode;
  title?: string;
  documentationLink?: string;
  placement?: "top" | "bottom" | "left" | "right";
  className?: string;
}

export function HelpTooltip({
  content,
  title,
  documentationLink,
  placement = "top",
  className,
}: HelpTooltipProps) {
  const [isOpen, setIsOpen] = useState(false);
  const tooltipRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (tooltipRef.current && !tooltipRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    };

    if (isOpen) {
      document.addEventListener("mousedown", handleClickOutside);
    }

    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
    };
  }, [isOpen]);

  const placementClasses = {
    top: "bottom-full left-1/2 -translate-x-1/2 mb-2",
    bottom: "top-full left-1/2 -translate-x-1/2 mt-2",
    left: "right-full top-1/2 -translate-y-1/2 mr-2",
    right: "left-full top-1/2 -translate-y-1/2 ml-2",
  };

  return (
    <div className={cn("relative inline-block", className)}>
      <button
        onClick={() => setIsOpen(!isOpen)}
        className="p-1 hover:bg-gray-100 dark:hover:bg-gray-800 rounded transition-colors"
        aria-label="Show help"
      >
        <HelpCircle className="h-4 w-4 text-gray-400 hover:text-gray-600 dark:hover:text-gray-300" />
      </button>

      {isOpen && (
        <div
          ref={tooltipRef}
          className={cn(
            "absolute z-50 w-80 bg-white dark:bg-gray-900 rounded-lg shadow-xl border border-gray-200 dark:border-gray-700 p-4",
            placementClasses[placement]
          )}
        >
          <div className="flex items-start justify-between mb-2">
            {title && <h4 className="font-semibold text-gray-900 dark:text-gray-100">{title}</h4>}
            <button
              onClick={() => setIsOpen(false)}
              className="p-1 hover:bg-gray-100 dark:hover:bg-gray-800 rounded transition-colors"
            >
              <X className="h-4 w-4 text-gray-500" />
            </button>
          </div>

          <div className="text-sm text-gray-600 dark:text-gray-400 mb-3">{content}</div>

          {documentationLink && (
            <a
              href={documentationLink}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-1 text-sm text-blue-600 dark:text-blue-400 hover:underline"
            >
              <ExternalLink className="h-3 w-3" />
              Learn more
            </a>
          )}
        </div>
      )}
    </div>
  );
}

interface HelpCenterProps {
  isOpen: boolean;
  onClose: () => void;
  sections: Array<{
    title: string;
    items: Array<{
      question: string;
      answer: string | React.ReactNode;
      link?: string;
    }>;
  }>;
}

export function HelpCenter({ isOpen, onClose, sections }: HelpCenterProps) {
  if (!isOpen) {
    return null;
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="bg-white dark:bg-gray-900 rounded-2xl shadow-2xl max-w-2xl w-full max-h-[90vh] overflow-hidden flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between p-6 border-b border-gray-200 dark:border-gray-800">
          <h2 className="text-xl font-semibold text-gray-900 dark:text-gray-100">Help Center</h2>
          <button
            onClick={onClose}
            className="p-2 hover:bg-gray-100 dark:hover:bg-gray-800 rounded-lg transition-colors"
          >
            <X className="h-5 w-5 text-gray-500" />
          </button>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-6">
          {sections.map((section, sectionIndex) => (
            <div key={sectionIndex} className="mb-8">
              <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-4">
                {section.title}
              </h3>
              <div className="space-y-4">
                {section.items.map((item, itemIndex) => (
                  <div
                    key={itemIndex}
                    className="border-b border-gray-200 dark:border-gray-700 pb-4 last:border-0 last:pb-0"
                  >
                    <h4 className="font-medium text-gray-900 dark:text-gray-100 mb-2">
                      {item.question}
                    </h4>
                    <div className="text-sm text-gray-600 dark:text-gray-400 mb-2">
                      {item.answer}
                    </div>
                    {item.link && (
                      <a
                        href={item.link}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="flex items-center gap-1 text-sm text-blue-600 dark:text-blue-400 hover:underline"
                      >
                        <ExternalLink className="h-3 w-3" />
                        View documentation
                      </a>
                    )}
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>

        {/* Footer */}
        <div className="p-4 border-t border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800">
          <div className="flex items-center justify-between">
            <span className="text-sm text-gray-600 dark:text-gray-400">Need more help?</span>
            <a
              href="https://github.com/your-repo/issues"
              target="_blank"
              rel="noopener noreferrer"
              className="text-sm text-blue-600 dark:text-blue-400 hover:underline"
            >
              Contact support
            </a>
          </div>
        </div>
      </div>
    </div>
  );
}
