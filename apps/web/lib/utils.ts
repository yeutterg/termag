import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function statusLabel(status?: string) {
  switch (status) {
    case 'idle':
      return 'Idle';
    case 'working':
      return 'Working';
    case 'waiting':
      return 'Waiting';
    case 'error':
      return 'Error';
    default:
      return 'Sleeping';
  }
}

export function statusDot(status?: string) {
  switch (status) {
    case 'idle':
      return 'bg-good';
    case 'working':
      return 'bg-work';
    case 'waiting':
      return 'bg-warn';
    case 'error':
      return 'bg-bad';
    default:
      return 'bg-muted';
  }
}
