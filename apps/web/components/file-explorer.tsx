"use client";

import { useState, useRef, useCallback } from "react";
import {
  File,
  Folder,
  FolderOpen,
  ChevronRight,
  ChevronDown,
  Upload,
  X,
  FileText,
  Image as ImageIcon,
  Code,
  Archive,
} from "lucide-react";
import { cn } from "@/lib/utils";

export interface FileNode {
  id: string;
  name: string;
  type: "file" | "folder";
  path: string;
  children?: FileNode[];
  size?: number;
  mimeType?: string;
}

interface FileExplorerProps {
  files: FileNode[];
  onFileSelect?: (file: FileNode) => void;
  onFileUpload?: (files: File[]) => void;
  onFileDelete?: (fileId: string) => void;
  selectedFileId?: string;
  className?: string;
}

export function FileExplorer({
  files,
  onFileSelect,
  onFileUpload,
  onFileDelete,
  selectedFileId,
  className,
}: FileExplorerProps) {
  const [expandedFolders, setExpandedFolders] = useState<Set<string>>(new Set());
  const [dragOver, setDragOver] = useState(false);
  const dropZoneRef = useRef<HTMLDivElement>(null);

  const toggleFolder = useCallback((folderId: string) => {
    setExpandedFolders(prev => {
      const next = new Set(prev);
      if (next.has(folderId)) {
        next.delete(folderId);
      } else {
        next.add(folderId);
      }
      return next;
    });
  }, []);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(true);
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
  }, []);

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setDragOver(false);

      const droppedFiles = Array.from(e.dataTransfer.files);
      if (droppedFiles.length > 0 && onFileUpload) {
        onFileUpload(droppedFiles);
      }
    },
    [onFileUpload]
  );

  const getFileIcon = (file: FileNode) => {
    if (file.type === "folder") {
      return expandedFolders.has(file.id) ? (
        <FolderOpen className="h-4 w-4 text-blue-500" />
      ) : (
        <Folder className="h-4 w-4 text-blue-500" />
      );
    }

    const ext = file.name.split(".").pop()?.toLowerCase();
    if (["jpg", "jpeg", "png", "gif", "svg", "webp"].includes(ext || "")) {
      return <ImageIcon className="h-4 w-4 text-purple-500" />;
    }
    if (["js", "ts", "jsx", "tsx", "py", "rb", "go", "rs"].includes(ext || "")) {
      return <Code className="h-4 w-4 text-green-500" />;
    }
    if (["zip", "tar", "gz", "rar"].includes(ext || "")) {
      return <Archive className="h-4 w-4 text-orange-500" />;
    }
    return <FileText className="h-4 w-4 text-gray-500" />;
  };

  const formatFileSize = (bytes?: number) => {
    if (!bytes) {
      return "";
    }
    const units = ["B", "KB", "MB", "GB"];
    let size = bytes;
    let unitIndex = 0;
    while (size >= 1024 && unitIndex < units.length - 1) {
      size /= 1024;
      unitIndex++;
    }
    return `${size.toFixed(1)} ${units[unitIndex]}`;
  };

  const renderFileNode = (node: FileNode, level: number = 0): React.ReactNode => {
    const isExpanded = expandedFolders.has(node.id);
    const isSelected = selectedFileId === node.id;

    return (
      <div key={node.id}>
        <div
          className={cn(
            "flex items-center gap-2 px-2 py-1.5 rounded cursor-pointer transition-colors",
            "hover:bg-gray-100 dark:hover:bg-gray-800",
            isSelected && "bg-blue-100 dark:bg-blue-900 text-blue-700 dark:text-blue-300"
          )}
          style={{ paddingLeft: `${level * 16 + 8}px` }}
          onClick={() => {
            if (node.type === "folder") {
              toggleFolder(node.id);
            } else if (onFileSelect) {
              onFileSelect(node);
            }
          }}
        >
          {node.type === "folder" && (
            <button
              onClick={e => {
                e.stopPropagation();
                toggleFolder(node.id);
              }}
              className="p-0.5 hover:bg-gray-200 dark:hover:bg-gray-700 rounded"
            >
              {isExpanded ? (
                <ChevronDown className="h-3 w-3" />
              ) : (
                <ChevronRight className="h-3 w-3" />
              )}
            </button>
          )}
          {getFileIcon(node)}
          <span className="flex-1 text-sm truncate">{node.name}</span>
          {node.size && (
            <span className="text-xs text-gray-500 dark:text-gray-400">
              {formatFileSize(node.size)}
            </span>
          )}
          {onFileDelete && node.type === "file" && (
            <button
              onClick={e => {
                e.stopPropagation();
                onFileDelete(node.id);
              }}
              className="p-0.5 hover:bg-red-100 dark:hover:bg-red-900 rounded opacity-0 group-hover:opacity-100 transition-opacity"
            >
              <X className="h-3 w-3 text-gray-400 hover:text-red-500" />
            </button>
          )}
        </div>
        {isExpanded && node.children && (
          <div>{node.children.map(child => renderFileNode(child, level + 1))}</div>
        )}
      </div>
    );
  };

  return (
    <div
      ref={dropZoneRef}
      className={cn(
        "flex flex-col h-full bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-lg",
        className
      )}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-gray-200 dark:border-gray-700">
        <h3 className="font-semibold text-gray-900 dark:text-gray-100">Files</h3>
        <button
          onClick={() => {
            const input = document.createElement("input");
            input.type = "file";
            input.multiple = true;
            input.onchange = e => {
              const target = e.target as HTMLInputElement;
              if (target.files && onFileUpload) {
                onFileUpload(Array.from(target.files));
              }
            };
            input.click();
          }}
          className="p-1.5 hover:bg-gray-100 dark:hover:bg-gray-800 rounded-lg transition-colors"
          title="Upload files"
        >
          <Upload className="h-4 w-4 text-gray-600 dark:text-gray-400" />
        </button>
      </div>

      {/* File Tree */}
      <div className="flex-1 overflow-y-auto p-2">
        {files.length === 0 ? (
          <div
            className={cn(
              "flex flex-col items-center justify-center h-full border-2 border-dashed rounded-lg transition-colors",
              dragOver
                ? "border-blue-500 bg-blue-50 dark:bg-blue-950"
                : "border-gray-300 dark:border-gray-600"
            )}
          >
            <Upload className="h-8 w-8 text-gray-400 mb-2" />
            <p className="text-sm text-gray-500 dark:text-gray-400">
              {dragOver ? "Drop files here" : "Drag files here or click upload"}
            </p>
          </div>
        ) : (
          <div className="group">{files.map(file => renderFileNode(file))}</div>
        )}
      </div>

      {/* Footer */}
      {files.length > 0 && (
        <div className="px-4 py-2 border-t border-gray-200 dark:border-gray-700 text-xs text-gray-500 dark:text-gray-400">
          {files.length} {files.length === 1 ? "item" : "items"}
        </div>
      )}
    </div>
  );
}

export function useFileExplorer() {
  const [files, setFiles] = useState<FileNode[]>([]);

  const addFile = useCallback((file: File, parentId?: string) => {
    const newFile: FileNode = {
      id: `file-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
      name: file.name,
      type: "file",
      path: parentId ? `${parentId}/${file.name}` : file.name,
      size: file.size,
      mimeType: file.type,
    };

    if (parentId) {
      setFiles(prev => {
        const addToParent = (nodes: FileNode[]): FileNode[] => {
          return nodes.map(node => {
            if (node.id === parentId && node.type === "folder") {
              return {
                ...node,
                children: [...(node.children || []), newFile],
              };
            }
            if (node.children) {
              return { ...node, children: addToParent(node.children) };
            }
            return node;
          });
        };
        return addToParent(prev);
      });
    } else {
      setFiles(prev => [...prev, newFile]);
    }
  }, []);

  const addFolder = useCallback((name: string, parentId?: string) => {
    const newFolder: FileNode = {
      id: `folder-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
      name,
      type: "folder",
      path: parentId ? `${parentId}/${name}` : name,
      children: [],
    };

    if (parentId) {
      setFiles(prev => {
        const addToParent = (nodes: FileNode[]): FileNode[] => {
          return nodes.map(node => {
            if (node.id === parentId && node.type === "folder") {
              return {
                ...node,
                children: [...(node.children || []), newFolder],
              };
            }
            if (node.children) {
              return { ...node, children: addToParent(node.children) };
            }
            return node;
          });
        };
        return addToParent(prev);
      });
    } else {
      setFiles(prev => [...prev, newFolder]);
    }
  }, []);

  const deleteFile = useCallback((fileId: string) => {
    setFiles(prev => {
      const removeFromTree = (nodes: FileNode[]): FileNode[] => {
        return nodes
          .filter(node => {
            if (node.id === fileId) {
              return false;
            }
            if (node.children) {
              return { ...node, children: removeFromTree(node.children) };
            }
            return true;
          })
          .map(node => {
            if (node.children) {
              return { ...node, children: removeFromTree(node.children) };
            }
            return node;
          });
      };
      return removeFromTree(prev);
    });
  }, []);

  const handleFileUpload = useCallback(
    (uploadedFiles: File[]) => {
      uploadedFiles.forEach(file => addFile(file));
    },
    [addFile]
  );

  return {
    files,
    addFile,
    addFolder,
    deleteFile,
    handleFileUpload,
  };
}
