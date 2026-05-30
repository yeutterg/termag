"use client";

import { useState, useMemo } from "react";
import { Plus, Edit, Trash2, Copy, FolderOpen, X, Save } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  getSessionTemplates,
  createSessionTemplate,
  updateSessionTemplate,
  deleteSessionTemplate,
  type SessionTemplate,
  type CreateSessionTemplateInput,
} from "@/lib/session-templates";
import { useToast } from "./toast-provider";

interface SessionTemplatesDialogProps {
  isOpen: boolean;
  onClose: () => void;
  onSelectTemplate?: (template: SessionTemplate) => void;
  mode?: "manage" | "select";
}

export function SessionTemplatesDialog({
  isOpen,
  onClose,
  onSelectTemplate,
  mode = "manage",
}: SessionTemplatesDialogProps) {
  const [selectedCategory, setSelectedCategory] = useState<string>("All");
  const [editingTemplate, setEditingTemplate] = useState<SessionTemplate | null>(null);
  const [isCreating, setIsCreating] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const { success, error } = useToast();

  const templates = useMemo(() => {
    return getSessionTemplates();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, refresh]); // Re-load when dialog opens or refresh is triggered

  const loadTemplates = () => {
    setRefresh(prev => prev + 1);
  };

  const categories = ["All", "dev", "ops", "testing", "custom"];
  const filteredTemplates =
    selectedCategory === "All" ? templates : templates.filter(t => t.category === selectedCategory);

  const handleCreate = () => {
    setIsCreating(true);
    setEditingTemplate({
      id: "",
      name: "",
      description: "",
      category: "custom",
      agentType: "shell",
      rootKey: "workstation",
      relativePath: "~/Projects",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
  };

  const handleEdit = (template: SessionTemplate) => {
    setEditingTemplate(template);
    setIsCreating(false);
  };

  const handleSave = () => {
    if (!editingTemplate) {
      return;
    }

    try {
      if (isCreating) {
        const input: CreateSessionTemplateInput = {
          name: editingTemplate.name,
          description: editingTemplate.description,
          category: editingTemplate.category,
          agentType: editingTemplate.agentType,
          rootKey: editingTemplate.rootKey,
          relativePath: editingTemplate.relativePath,
          agentSpawnCommand: editingTemplate.agentSpawnCommand,
          ctrlSpawnCommand: editingTemplate.ctrlSpawnCommand,
          color: editingTemplate.color,
        };
        createSessionTemplate(input);
        success("Template created successfully");
      } else {
        updateSessionTemplate(editingTemplate.id, editingTemplate);
        success("Template updated successfully");
      }
      loadTemplates();
      setEditingTemplate(null);
      setIsCreating(false);
    } catch {
      error("Failed to save template");
    }
  };

  const handleDelete = (id: string) => {
    if (confirm("Are you sure you want to delete this template?")) {
      deleteSessionTemplate(id);
      loadTemplates();
      success("Template deleted");
    }
  };

  const handleDuplicate = (template: SessionTemplate) => {
    const input: CreateSessionTemplateInput = {
      name: `${template.name} (Copy)`,
      description: template.description,
      category: template.category,
      agentType: template.agentType,
      rootKey: template.rootKey,
      relativePath: template.relativePath,
      agentSpawnCommand: template.agentSpawnCommand,
      ctrlSpawnCommand: template.ctrlSpawnCommand,
      color: template.color,
    };
    createSessionTemplate(input);
    loadTemplates();
    success("Template duplicated");
  };

  const handleSelect = (template: SessionTemplate) => {
    onSelectTemplate?.(template);
    onClose();
  };

  if (!isOpen) {
    return null;
  }

  return (
    <div className="fixed inset-0 bg-black/50 backdrop-blur-sm z-50 flex items-center justify-center p-4">
      <div className="bg-white dark:bg-gray-900 rounded-2xl shadow-2xl max-w-4xl w-full max-h-[90vh] overflow-hidden flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between p-6 border-b border-gray-200 dark:border-gray-800">
          <div>
            <h2 className="text-xl font-semibold text-gray-900 dark:text-gray-100">
              {mode === "select" ? "Select Session Template" : "Session Templates"}
            </h2>
            <p className="text-sm text-gray-600 dark:text-gray-400">
              {mode === "select"
                ? "Choose a template to create a new session"
                : "Manage your session templates"}
            </p>
          </div>
          <button
            onClick={onClose}
            className="p-2 hover:bg-gray-100 dark:hover:bg-gray-800 rounded-lg transition-colors"
          >
            <X className="h-5 w-5 text-gray-500" />
          </button>
        </div>

        {/* Content */}
        {editingTemplate ? (
          <EditTemplateForm
            template={editingTemplate}
            isCreating={isCreating}
            onChange={setEditingTemplate}
            onSave={handleSave}
            onCancel={() => {
              setEditingTemplate(null);
              setIsCreating(false);
            }}
          />
        ) : (
          <>
            {/* Category Filter */}
            <div className="p-4 border-b border-gray-200 dark:border-gray-800">
              <div className="flex gap-2 flex-wrap">
                {categories.map(category => (
                  <button
                    key={category}
                    onClick={() => setSelectedCategory(category)}
                    className={cn(
                      "px-3 py-1.5 rounded-full text-sm font-medium transition-colors",
                      selectedCategory === category
                        ? "bg-blue-600 text-white"
                        : "bg-gray-100 dark:bg-gray-800 text-gray-700 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-700"
                    )}
                  >
                    {category}
                  </button>
                ))}
              </div>
            </div>

            {/* Templates List */}
            <div className="flex-1 overflow-y-auto p-4">
              {filteredTemplates.length === 0 ? (
                <div className="text-center py-12">
                  <FolderOpen className="h-12 w-12 mx-auto text-gray-400 mb-4" />
                  <p className="text-gray-500 dark:text-gray-400">No templates found</p>
                </div>
              ) : (
                <div className="grid gap-3">
                  {filteredTemplates.map(template => (
                    <div
                      key={template.id}
                      className="p-4 bg-gray-50 dark:bg-gray-800 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors"
                    >
                      <div className="flex items-start justify-between">
                        <div className="flex-1">
                          <div className="flex items-center gap-2 mb-1">
                            <h3 className="font-semibold text-gray-900 dark:text-gray-100">
                              {template.name}
                            </h3>
                            {template.isDefault && (
                              <span className="px-2 py-0.5 bg-blue-100 dark:bg-blue-900 text-blue-700 dark:text-blue-300 text-xs rounded">
                                Default
                              </span>
                            )}
                          </div>
                          {template.description && (
                            <p className="text-sm text-gray-600 dark:text-gray-400 mb-2">
                              {template.description}
                            </p>
                          )}
                          <div className="flex items-center gap-4 text-xs text-gray-500 dark:text-gray-400">
                            <span>{template.category}</span>
                            <span>{template.agentType}</span>
                            <span>{template.rootKey}</span>
                          </div>
                        </div>

                        <div className="flex items-center gap-1">
                          {mode === "select" && (
                            <button
                              onClick={() => handleSelect(template)}
                              className="p-2 hover:bg-gray-200 dark:hover:bg-gray-600 rounded transition-colors"
                              title="Use template"
                            >
                              <Copy className="h-4 w-4 text-gray-600 dark:text-gray-400" />
                            </button>
                          )}
                          <button
                            onClick={() => handleEdit(template)}
                            className="p-2 hover:bg-gray-200 dark:hover:bg-gray-600 rounded transition-colors"
                            title="Edit"
                          >
                            <Edit className="h-4 w-4 text-gray-600 dark:text-gray-400" />
                          </button>
                          <button
                            onClick={() => handleDuplicate(template)}
                            className="p-2 hover:bg-gray-200 dark:hover:bg-gray-600 rounded transition-colors"
                            title="Duplicate"
                          >
                            <Copy className="h-4 w-4 text-gray-600 dark:text-gray-400" />
                          </button>
                          {!template.isDefault && (
                            <button
                              onClick={() => handleDelete(template.id)}
                              className="p-2 hover:bg-gray-200 dark:hover:bg-gray-600 rounded transition-colors"
                              title="Delete"
                            >
                              <Trash2 className="h-4 w-4 text-red-500" />
                            </button>
                          )}
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* Footer */}
            {mode === "manage" && (
              <div className="p-4 border-t border-gray-200 dark:border-gray-800">
                <button
                  onClick={handleCreate}
                  className="flex items-center gap-2 px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-lg font-medium transition-colors"
                >
                  <Plus className="h-4 w-4" />
                  Create Template
                </button>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function EditTemplateForm({
  template,
  isCreating,
  onChange,
  onSave,
  onCancel,
}: {
  template: SessionTemplate;
  isCreating: boolean;
  onChange: (template: SessionTemplate) => void;
  onSave: () => void;
  onCancel: () => void;
}) {
  return (
    <div className="flex-1 overflow-y-auto p-6">
      <div className="space-y-4">
        <div>
          <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
            Name
          </label>
          <input
            type="text"
            value={template.name}
            onChange={e => onChange({ ...template, name: e.target.value })}
            className="w-full px-3 py-2 bg-white dark:bg-gray-800 border border-gray-300 dark:border-gray-600 rounded-lg focus:ring-2 focus:ring-blue-500 text-gray-900 dark:text-gray-100"
            placeholder="Template name"
          />
        </div>

        <div>
          <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
            Description
          </label>
          <textarea
            value={template.description || ""}
            onChange={e => onChange({ ...template, description: e.target.value })}
            className="w-full px-3 py-2 bg-white dark:bg-gray-800 border border-gray-300 dark:border-gray-600 rounded-lg focus:ring-2 focus:ring-blue-500 text-gray-900 dark:text-gray-100"
            rows={2}
            placeholder="Optional description"
          />
        </div>

        <div>
          <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
            Category
          </label>
          <select
            value={template.category}
            onChange={e =>
              onChange({ ...template, category: e.target.value as SessionTemplate["category"] })
            }
            className="w-full px-3 py-2 bg-white dark:bg-gray-800 border border-gray-300 dark:border-gray-600 rounded-lg focus:ring-2 focus:ring-blue-500 text-gray-900 dark:text-gray-100"
          >
            <option value="dev">Development</option>
            <option value="ops">Operations</option>
            <option value="testing">Testing</option>
            <option value="custom">Custom</option>
          </select>
        </div>

        <div>
          <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
            Agent Type
          </label>
          <select
            value={template.agentType}
            onChange={e =>
              onChange({ ...template, agentType: e.target.value as SessionTemplate["agentType"] })
            }
            className="w-full px-3 py-2 bg-white dark:bg-gray-800 border border-gray-300 dark:border-gray-600 rounded-lg focus:ring-2 focus:ring-blue-500 text-gray-900 dark:text-gray-100"
          >
            <option value="shell">Shell</option>
            <option value="codex">Codex</option>
            <option value="claude">Claude</option>
          </select>
        </div>

        <div>
          <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
            Root Key
          </label>
          <input
            type="text"
            value={template.rootKey}
            onChange={e => onChange({ ...template, rootKey: e.target.value })}
            className="w-full px-3 py-2 bg-white dark:bg-gray-800 border border-gray-300 dark:border-gray-600 rounded-lg focus:ring-2 focus:ring-blue-500 text-gray-900 dark:text-gray-100"
            placeholder="e.g., workstation"
          />
        </div>

        <div>
          <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
            Relative Path
          </label>
          <input
            type="text"
            value={template.relativePath}
            onChange={e => onChange({ ...template, relativePath: e.target.value })}
            className="w-full px-3 py-2 bg-white dark:bg-gray-800 border border-gray-300 dark:border-gray-600 rounded-lg focus:ring-2 focus:ring-blue-500 text-gray-900 dark:text-gray-100"
            placeholder="e.g., ~/Projects"
          />
        </div>

        <div>
          <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
            Agent Spawn Command
          </label>
          <input
            type="text"
            value={template.agentSpawnCommand || ""}
            onChange={e => onChange({ ...template, agentSpawnCommand: e.target.value })}
            className="w-full px-3 py-2 bg-white dark:bg-gray-800 border border-gray-300 dark:border-gray-600 rounded-lg focus:ring-2 focus:ring-blue-500 text-gray-900 dark:text-gray-100"
            placeholder="e.g., /bin/bash"
          />
        </div>

        <div>
          <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
            Ctrl Spawn Command
          </label>
          <input
            type="text"
            value={template.ctrlSpawnCommand || ""}
            onChange={e => onChange({ ...template, ctrlSpawnCommand: e.target.value })}
            className="w-full px-3 py-2 bg-white dark:bg-gray-800 border border-gray-300 dark:border-gray-600 rounded-lg focus:ring-2 focus:ring-blue-500 text-gray-900 dark:text-gray-100"
            placeholder="e.g., /bin/zsh"
          />
        </div>

        <div>
          <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
            Color
          </label>
          <input
            type="color"
            value={template.color || "#3B82F6"}
            onChange={e => onChange({ ...template, color: e.target.value })}
            className="w-full h-10 bg-white dark:bg-gray-800 border border-gray-300 dark:border-gray-600 rounded-lg cursor-pointer"
          />
        </div>
      </div>

      <div className="flex justify-end gap-3 mt-6">
        <button
          onClick={onCancel}
          className="px-4 py-2 bg-gray-100 dark:bg-gray-800 text-gray-700 dark:text-gray-300 rounded-lg font-medium hover:bg-gray-200 dark:hover:bg-gray-700 transition-colors"
        >
          Cancel
        </button>
        <button
          onClick={onSave}
          className="flex items-center gap-2 px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-lg font-medium transition-colors"
        >
          <Save className="h-4 w-4" />
          {isCreating ? "Create" : "Save"}
        </button>
      </div>
    </div>
  );
}
