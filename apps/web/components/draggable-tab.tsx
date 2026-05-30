import { useState, DragEvent } from "react";
import { GripVertical } from "lucide-react";
import { cn } from "@/lib/utils";

export interface DraggableTabProps {
  id: string;
  children: React.ReactNode;
  onDragStart?: (id: string) => void;
  onDragEnd?: (id: string) => void;
  onDrop?: (draggedId: string, droppedId: string) => void;
  isDragging?: boolean;
  isOver?: boolean;
  className?: string;
}

export function DraggableTab({
  id,
  children,
  onDragStart,
  onDragEnd,
  onDrop,
  isDragging = false,
  isOver = false,
  className,
}: DraggableTabProps) {
  const handleDragStart = (e: DragEvent<HTMLDivElement>) => {
    e.dataTransfer.setData("text/plain", id);
    e.dataTransfer.effectAllowed = "move";
    onDragStart?.(id);
  };

  const handleDragEnd = () => {
    onDragEnd?.(id);
  };

  const handleDragOver = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
  };

  const handleDrop = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    const draggedId = e.dataTransfer.getData("text/plain");
    if (draggedId && draggedId !== id) {
      onDrop?.(draggedId, id);
    }
  };

  return (
    <div
      draggable
      onDragStart={handleDragStart}
      onDragEnd={handleDragEnd}
      onDragOver={handleDragOver}
      onDrop={handleDrop}
      className={cn(
        "relative group cursor-grab active:cursor-grabbing",
        isDragging && "opacity-50",
        isOver && "ring-2 ring-blue-500 ring-offset-2",
        className
      )}
    >
      <div className="absolute left-0 top-1/2 -translate-y-1/2 -translate-x-full opacity-0 group-hover:opacity-100 transition-opacity pr-1">
        <GripVertical className="h-4 w-4 text-gray-400" />
      </div>
      {children}
    </div>
  );
}

export interface TabOrderProps {
  items: Array<{ id: string; [key: string]: unknown }>;
  onReorder: (newOrder: string[]) => void;
  renderItem: (item: unknown, index: number) => React.ReactNode;
  className?: string;
}

export function TabOrder({ items, onReorder, renderItem, className }: TabOrderProps) {
  const [draggedId, setDraggedId] = useState<string | null>(null);
  const [overId, setOverId] = useState<string | null>(null);

  const handleDragStart = (id: string) => {
    setDraggedId(id);
  };

  const handleDragEnd = () => {
    setDraggedId(null);
    setOverId(null);
  };

  const handleDrop = (draggedId: string, droppedId: string) => {
    const newOrder = reorderItems(
      items.map(i => i.id),
      draggedId,
      droppedId
    );
    onReorder(newOrder);
  };

  const handleDragOver = (id: string) => {
    setOverId(id);
  };

  return (
    <div className={cn("flex gap-1", className)}>
      {items.map((item, index) => (
        <DraggableTab
          key={item.id}
          id={item.id}
          isDragging={draggedId === item.id}
          isOver={overId === item.id}
          onDragStart={handleDragStart}
          onDragEnd={handleDragEnd}
          onDrop={handleDrop}
          onDragOver={handleDragOver}
        >
          {renderItem(item, index)}
        </DraggableTab>
      ))}
    </div>
  );
}

function reorderItems(items: string[], draggedId: string, droppedId: string): string[] {
  const draggedIndex = items.indexOf(draggedId);
  const droppedIndex = items.indexOf(droppedId);

  if (draggedIndex === -1 || droppedIndex === -1) {
    return items;
  }

  const newItems = [...items];
  const [removed] = newItems.splice(draggedIndex, 1);
  newItems.splice(droppedIndex, 0, removed);

  return newItems;
}
