"use client";

/* eslint-disable react-hooks/set-state-in-effect */

import { useState, useEffect } from "react";
import { X, ArrowRight, ArrowLeft, Check } from "lucide-react";
import { cn } from "@/lib/utils";

interface TourStep {
  id: string;
  target: string;
  title: string;
  content: string;
  position?: "top" | "bottom" | "left" | "right" | "center";
  action?: () => void;
}

interface OnboardingTourProps {
  steps: TourStep[];
  onComplete?: () => void;
  onSkip?: () => void;
  className?: string;
}

export function OnboardingTour({ steps, onComplete, onSkip, className }: OnboardingTourProps) {
  const [currentStep, setCurrentStep] = useState(0);
  const [isOpen, setIsOpen] = useState(true);
  const [highlightedElement, setHighlightedElement] = useState<HTMLElement | null>(null);

  useEffect(() => {
    if (!isOpen) {
      return;
    }

    const step = steps[currentStep];
    if (step.position === "center") {
      return;
    }

    const element = document.querySelector(step.target) as HTMLElement;
    setHighlightedElement(element);

    if (element) {
      element.scrollIntoView({ behavior: "smooth", block: "center" });
      element.style.outline = "2px solid #3B82F6";
      element.style.outlineOffset = "4px";
    }

    return () => {
      if (element) {
        element.style.outline = "";
        element.style.outlineOffset = "";
      }
    };
  }, [currentStep, isOpen, steps]);

  const handleNext = () => {
    const step = steps[currentStep];
    step.action?.();

    if (currentStep < steps.length - 1) {
      setCurrentStep(currentStep + 1);
    } else {
      handleComplete();
    }
  };

  const handlePrevious = () => {
    if (currentStep > 0) {
      setCurrentStep(currentStep - 1);
    }
  };

  const handleComplete = () => {
    setIsOpen(false);
    onComplete?.();
  };

  const handleSkip = () => {
    setIsOpen(false);
    onSkip?.();
  };

  if (!isOpen) {
    return null;
  }

  const step = steps[currentStep];
  const progress = ((currentStep + 1) / steps.length) * 100;

  return (
    <div className={cn("fixed inset-0 z-50 pointer-events-none", className)}>
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/50" onClick={handleSkip} />

      {/* Highlight overlay */}
      {highlightedElement && step.position !== "center" && (
        <div
          className="absolute border-2 border-blue-500 rounded-lg pointer-events-none"
          style={{
            top: highlightedElement.offsetTop - 8,
            left: highlightedElement.offsetLeft - 8,
            width: highlightedElement.offsetWidth + 16,
            height: highlightedElement.offsetHeight + 16,
            boxShadow: "0 0 0 9999px rgba(0, 0, 0, 0.5)",
          }}
        />
      )}

      {/* Tooltip */}
      <div
        className={cn(
          "absolute bg-white dark:bg-gray-900 rounded-xl shadow-2xl p-6 max-w-md pointer-events-auto",
          step.position === "center" && "top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2",
          step.position === "top" && "bottom-4 left-1/2 -translate-x-1/2",
          step.position === "bottom" && "top-4 left-1/2 -translate-x-1/2",
          step.position === "left" && "right-4 top-1/2 -translate-y-1/2",
          step.position === "right" && "left-4 top-1/2 -translate-y-1/2"
        )}
      >
        {/* Close button */}
        <button
          onClick={handleSkip}
          className="absolute top-4 right-4 p-1 hover:bg-gray-100 dark:hover:bg-gray-800 rounded transition-colors"
        >
          <X className="h-4 w-4 text-gray-500" />
        </button>

        {/* Progress bar */}
        <div className="mb-4">
          <div className="h-1 bg-gray-200 dark:bg-gray-700 rounded-full overflow-hidden">
            <div
              className="h-full bg-blue-500 transition-all duration-300"
              style={{ width: `${progress}%` }}
            />
          </div>
          <div className="text-xs text-gray-500 dark:text-gray-400 mt-1">
            Step {currentStep + 1} of {steps.length}
          </div>
        </div>

        {/* Content */}
        <div className="mb-6">
          <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-2">
            {step.title}
          </h3>
          <p className="text-gray-600 dark:text-gray-400">{step.content}</p>
        </div>

        {/* Navigation */}
        <div className="flex items-center justify-between">
          <button
            onClick={handlePrevious}
            disabled={currentStep === 0}
            className={cn(
              "flex items-center gap-1 px-3 py-1.5 rounded-lg text-sm font-medium transition-colors",
              currentStep === 0
                ? "opacity-50 cursor-not-allowed"
                : "bg-gray-100 dark:bg-gray-800 text-gray-700 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-700"
            )}
          >
            <ArrowLeft className="h-4 w-4" />
            Previous
          </button>

          <button
            onClick={handleSkip}
            className="text-sm text-gray-500 dark:text-gray-400 hover:underline"
          >
            Skip tour
          </button>

          <button
            onClick={handleNext}
            className={cn(
              "flex items-center gap-1 px-3 py-1.5 rounded-lg text-sm font-medium transition-colors",
              currentStep === steps.length - 1
                ? "bg-green-600 hover:bg-green-700 text-white"
                : "bg-blue-600 hover:bg-blue-700 text-white"
            )}
          >
            {currentStep === steps.length - 1 ? (
              <>
                <Check className="h-4 w-4" />
                Complete
              </>
            ) : (
              <>
                Next
                <ArrowRight className="h-4 w-4" />
              </>
            )}
          </button>
        </div>
      </div>
    </div>
  );
}

export function useOnboardingTour(hasSeenKey: string) {
  const [hasSeen, setHasSeen] = useState(false);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    try {
      const stored = localStorage.getItem(hasSeenKey);
      setHasSeen(stored === "true");
    } catch {
      setHasSeen(false);
    }
  }, [hasSeenKey]);

  const markAsSeen = () => {
    if (typeof window === "undefined") {
      return;
    }

    try {
      localStorage.setItem(hasSeenKey, "true");
      setHasSeen(true);
    } catch (error) {
      console.error("Failed to mark onboarding as seen:", error);
    }
  };

  const reset = () => {
    if (typeof window === "undefined") {
      return;
    }

    try {
      localStorage.removeItem(hasSeenKey);
      setHasSeen(false);
    } catch (error) {
      console.error("Failed to reset onboarding:", error);
    }
  };

  return { hasSeen, markAsSeen, reset };
}
