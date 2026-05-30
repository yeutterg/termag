import { cn } from "@/lib/utils";

export type TransitionType =
  | "fade"
  | "slide-up"
  | "slide-down"
  | "slide-left"
  | "slide-right"
  | "scale"
  | "bounce";

export interface TransitionProps {
  children: React.ReactNode;
  type?: TransitionType;
  duration?: number;
  delay?: number;
  className?: string;
  show?: boolean;
}

const transitionClasses: Record<TransitionType, string> = {
  fade: "animate-in fade-in",
  "slide-up": "animate-in slide-in-from-bottom",
  "slide-down": "animate-in slide-in-from-top",
  "slide-left": "animate-in slide-in-from-right",
  "slide-right": "animate-in slide-in-from-left",
  scale: "animate-in zoom-in",
  bounce: "animate-in bounce-in",
};

export function Transition({
  children,
  type = "fade",
  duration = 300,
  delay = 0,
  className,
  show = true,
}: TransitionProps) {
  if (!show) {
    return null;
  }

  const style = {
    animationDuration: `${duration}ms`,
    animationDelay: `${delay}ms`,
  };

  return (
    <div className={cn(transitionClasses[type], className)} style={style}>
      {children}
    </div>
  );
}

export interface StaggerTransitionProps {
  children: React.ReactNode[];
  staggerDelay?: number;
  type?: TransitionType;
  className?: string;
}

export function StaggerTransition({
  children,
  staggerDelay = 100,
  type = "fade",
  className,
}: StaggerTransitionProps) {
  return (
    <div className={className}>
      {children.map((child, index) => (
        <Transition key={index} type={type} delay={index * staggerDelay}>
          {child}
        </Transition>
      ))}
    </div>
  );
}

export interface HoverScaleProps {
  children: React.ReactNode;
  scale?: number;
  className?: string;
}

export function HoverScale({ children, scale = 1.05, className }: HoverScaleProps) {
  return (
    <div
      className={cn("transition-transform duration-200", className)}
      style={{ "--tw-scale": scale } as React.CSSProperties}
      onMouseEnter={e => {
        e.currentTarget.style.transform = `scale(${scale})`;
      }}
      onMouseLeave={e => {
        e.currentTarget.style.transform = "scale(1)";
      }}
    >
      {children}
    </div>
  );
}

export interface PulseProps {
  children: React.ReactNode;
  className?: string;
  duration?: number;
}

export function Pulse({ children, className, duration = 2000 }: PulseProps) {
  return (
    <div className={cn("animate-pulse", className)} style={{ animationDuration: `${duration}ms` }}>
      {children}
    </div>
  );
}

export interface SpinProps {
  children: React.ReactNode;
  className?: string;
  duration?: number;
}

export function Spin({ children, className, duration = 1000 }: SpinProps) {
  return (
    <div className={cn("animate-spin", className)} style={{ animationDuration: `${duration}ms` }}>
      {children}
    </div>
  );
}
