"use client";

import { AlertCircle, RefreshCw, Home, Settings, ExternalLink } from "lucide-react";
import { cn } from "@/lib/utils";

interface ErrorRecoveryProps {
  error: Error | string;
  onRetry?: () => void;
  onGoHome?: () => void;
  onSettings?: () => void;
  showDetails?: boolean;
  className?: string;
}

export function ErrorRecovery({
  error,
  onRetry,
  onGoHome,
  onSettings,
  showDetails = false,
  className,
}: ErrorRecoveryProps) {
  const errorMessage = typeof error === "string" ? error : error.message;
  const errorStack = typeof error === "object" && error.stack ? error.stack : undefined;

  const getSuggestions = (message: string): string[] => {
    const lowerMessage = message.toLowerCase();
    const suggestions: string[] = [];

    if (lowerMessage.includes("network") || lowerMessage.includes("fetch")) {
      suggestions.push("Check your internet connection");
      suggestions.push("Try refreshing the page");
    }

    if (lowerMessage.includes("auth") || lowerMessage.includes("unauthorized")) {
      suggestions.push("You may need to log in again");
      suggestions.push("Check your authentication settings");
    }

    if (lowerMessage.includes("database") || lowerMessage.includes("sql")) {
      suggestions.push("The database may be temporarily unavailable");
      suggestions.push("Try again in a few moments");
    }

    if (lowerMessage.includes("timeout")) {
      suggestions.push("The operation timed out. Try again");
      suggestions.push("Check if the server is responding");
    }

    if (suggestions.length === 0) {
      suggestions.push("Try refreshing the page");
      suggestions.push("If the problem persists, contact support");
    }

    return suggestions;
  };

  const suggestions = getSuggestions(errorMessage);

  return (
    <div className={cn("flex flex-col items-center justify-center min-h-[400px] p-6", className)}>
      <div className="max-w-md w-full text-center">
        {/* Error Icon */}
        <div className="mx-auto mb-4 p-4 bg-red-100 dark:bg-red-900/30 rounded-full w-fit">
          <AlertCircle className="h-8 w-8 text-red-600 dark:text-red-400" />
        </div>

        {/* Error Title */}
        <h2 className="text-xl font-semibold text-gray-900 dark:text-gray-100 mb-2">
          Something went wrong
        </h2>

        {/* Error Message */}
        <p className="text-gray-600 dark:text-gray-400 mb-6">{errorMessage}</p>

        {/* Suggestions */}
        {suggestions.length > 0 && (
          <div className="mb-6 p-4 bg-gray-50 dark:bg-gray-800 rounded-lg">
            <p className="text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
              Suggestions:
            </p>
            <ul className="text-sm text-gray-600 dark:text-gray-400 space-y-1">
              {suggestions.map((suggestion, index) => (
                <li key={index} className="flex items-start gap-2">
                  <span className="text-blue-500 mt-0.5">•</span>
                  {suggestion}
                </li>
              ))}
            </ul>
          </div>
        )}

        {/* Error Details (collapsible) */}
        {showDetails && errorStack && (
          <details className="mb-6 text-left">
            <summary className="cursor-pointer text-sm text-blue-600 dark:text-blue-400 hover:underline">
              Show error details
            </summary>
            <pre className="mt-2 p-3 bg-gray-100 dark:bg-gray-900 rounded text-xs overflow-auto max-h-40">
              {errorStack}
            </pre>
          </details>
        )}

        {/* Action Buttons */}
        <div className="flex flex-col sm:flex-row gap-3 justify-center">
          {onRetry && (
            <button
              onClick={onRetry}
              className="flex items-center justify-center gap-2 px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-lg font-medium transition-colors"
            >
              <RefreshCw className="h-4 w-4" />
              Try Again
            </button>
          )}

          {onGoHome && (
            <button
              onClick={onGoHome}
              className="flex items-center justify-center gap-2 px-4 py-2 bg-gray-100 dark:bg-gray-800 text-gray-700 dark:text-gray-300 rounded-lg font-medium hover:bg-gray-200 dark:hover:bg-gray-700 transition-colors"
            >
              <Home className="h-4 w-4" />
              Go Home
            </button>
          )}

          {onSettings && (
            <button
              onClick={onSettings}
              className="flex items-center justify-center gap-2 px-4 py-2 bg-gray-100 dark:bg-gray-800 text-gray-700 dark:text-gray-300 rounded-lg font-medium hover:bg-gray-200 dark:hover:bg-gray-700 transition-colors"
            >
              <Settings className="h-4 w-4" />
              Settings
            </button>
          )}
        </div>

        {/* Report Issue Link */}
        <a
          href="https://github.com/your-repo/issues"
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1 mt-4 text-sm text-blue-600 dark:text-blue-400 hover:underline"
        >
          <ExternalLink className="h-3 w-3" />
          Report this issue
        </a>
      </div>
    </div>
  );
}

interface ErrorBoundaryFallbackProps {
  error: Error;
  resetError: () => void;
}

export function ErrorBoundaryFallback({ error, resetError }: ErrorBoundaryFallbackProps) {
  return <ErrorRecovery error={error} onRetry={resetError} showDetails={true} />;
}
