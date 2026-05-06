'use client';

import { useState } from 'react';
import { cn } from '@/lib/utils';

interface TabLabelProps {
  name: string;
  liveTitle?: string | null;
  className?: string;
  onRename?: (next: string) => void;
}

export function TabLabel({ name, liveTitle, className, onRename }: TabLabelProps) {
  const [editing, setEditing] = useState(false);
  const display = liveTitle || name;

  if (!editing || !onRename) {
    return (
      <span
        className={cn(className, onRename && 'cursor-text')}
        title={onRename ? 'Double-click to rename' : undefined}
        onDoubleClick={(event) => {
          if (!onRename) return;
          event.stopPropagation();
          event.preventDefault();
          setEditing(true);
        }}
      >
        {display}
      </span>
    );
  }

  const commit = (value: string) => {
    const trimmed = value.trim();
    if (trimmed && trimmed !== name) onRename!(trimmed);
    setEditing(false);
  };

  return (
    <input
      autoFocus
      defaultValue={name}
      onFocus={(event) => event.currentTarget.select()}
      onClick={(event) => event.stopPropagation()}
      onMouseDown={(event) => event.stopPropagation()}
      onKeyDown={(event) => {
        if (event.key === 'Enter') {
          event.preventDefault();
          commit((event.target as HTMLInputElement).value);
        } else if (event.key === 'Escape') {
          event.preventDefault();
          setEditing(false);
        } else {
          event.stopPropagation();
        }
      }}
      onBlur={(event) => commit(event.currentTarget.value)}
      className={cn(className, '-mx-1 -my-0.5 min-w-0 rounded-sm bg-bg px-1 outline outline-1 outline-accent')}
    />
  );
}
