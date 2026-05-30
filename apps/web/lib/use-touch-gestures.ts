/* eslint-disable react-hooks/exhaustive-deps */
/* eslint-disable @typescript-eslint/no-unused-vars */

import { useRef, useEffect, useCallback } from "react";

export interface TouchGestureHandlers {
  onPinch?: (scale: number) => void;
  onSwipeLeft?: () => void;
  onSwipeRight?: () => void;
  onSwipeUp?: () => void;
  onSwipeDown?: () => void;
  onLongPress?: () => void;
  onDoubleTap?: () => void;
}

export interface TouchGestureOptions {
  threshold?: number;
  longPressDelay?: number;
  doubleTapDelay?: number;
}

const DEFAULT_OPTIONS: Required<TouchGestureOptions> = {
  threshold: 50,
  longPressDelay: 500,
  doubleTapDelay: 300,
};

export function useTouchGestures(
  handlers: TouchGestureHandlers,
  options: TouchGestureOptions = {}
) {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  const lastTapRef = useRef<number>(0);
  const longPressTimerRef = useRef<NodeJS.Timeout | null>(null);
  const startXRef = useRef<number>(0);
  const startYRef = useRef<number>(0);

  const handleTouchStart = useCallback(
    (e: TouchEvent) => {
      const touch = e.touches[0];
      startXRef.current = touch.clientX;
      startYRef.current = touch.clientY;

      // Long press detection
      if (handlers.onLongPress) {
        longPressTimerRef.current = setTimeout(() => {
          handlers.onLongPress?.();
        }, opts.longPressDelay);
      }

      // Double tap detection
      const now = Date.now();
      if (handlers.onDoubleTap && now - lastTapRef.current < opts.doubleTapDelay) {
        handlers.onDoubleTap();
        lastTapRef.current = 0;
      } else {
        lastTapRef.current = now;
      }
    },
    [handlers, opts]
  );

  const handleTouchMove = useCallback((e: TouchEvent) => {
    // Cancel long press if user moves finger
    if (longPressTimerRef.current) {
      clearTimeout(longPressTimerRef.current);
      longPressTimerRef.current = null;
    }
  }, []);

  const handleTouchEnd = useCallback(
    (e: TouchEvent) => {
      if (longPressTimerRef.current) {
        clearTimeout(longPressTimerRef.current);
        longPressTimerRef.current = null;
      }

      const touch = e.changedTouches[0];
      const deltaX = touch.clientX - startXRef.current;
      const deltaY = touch.clientY - startYRef.current;

      // Detect swipe direction
      if (Math.abs(deltaX) > Math.abs(deltaY)) {
        // Horizontal swipe
        if (Math.abs(deltaX) > opts.threshold) {
          if (deltaX > 0) {
            handlers.onSwipeRight?.();
          } else {
            handlers.onSwipeLeft?.();
          }
        }
      } else {
        // Vertical swipe
        if (Math.abs(deltaY) > opts.threshold) {
          if (deltaY > 0) {
            handlers.onSwipeDown?.();
          } else {
            handlers.onSwipeUp?.();
          }
        }
      }
    },
    [handlers, opts]
  );

  const handleTouchCancel = useCallback(() => {
    if (longPressTimerRef.current) {
      clearTimeout(longPressTimerRef.current);
      longPressTimerRef.current = null;
    }
  }, []);

  useEffect(() => {
    return () => {
      if (longPressTimerRef.current) {
        clearTimeout(longPressTimerRef.current);
      }
    };
  }, []);

  return {
    onTouchStart: handleTouchStart,
    onTouchMove: handleTouchMove,
    onTouchEnd: handleTouchEnd,
    onTouchCancel: handleTouchCancel,
  };
}

export interface PinchGestureState {
  scale: number;
  isPinching: boolean;
}

export function usePinchGesture(onPinch?: (scale: number) => void) {
  const [state, setState] = useState<PinchGestureState>({
    scale: 1,
    isPinching: false,
  });
  const initialDistanceRef = useRef<number>(0);

  const getDistance = (touches: TouchList): number => {
    const dx = touches[0].clientX - touches[1].clientX;
    const dy = touches[0].clientY - touches[1].clientY;
    return Math.sqrt(dx * dx + dy * dy);
  };

  const handleTouchStart = useCallback((e: TouchEvent) => {
    if (e.touches.length === 2) {
      initialDistanceRef.current = getDistance(e.touches);
      setState({ scale: 1, isPinching: true });
    }
  }, []);

  const handleTouchMove = useCallback(
    (e: TouchEvent) => {
      if (e.touches.length === 2 && state.isPinching) {
        const currentDistance = getDistance(e.touches);
        const scale = currentDistance / initialDistanceRef.current;

        setState({ scale, isPinching: true });
        onPinch?.(scale);
      }
    },
    [state.isPinching, onPinch]
  );

  const handleTouchEnd = useCallback(() => {
    setState({ scale: 1, isPinching: false });
  }, []);

  return {
    ...state,
    onTouchStart: handleTouchStart,
    onTouchMove: handleTouchMove,
    onTouchEnd: handleTouchEnd,
  };
}
