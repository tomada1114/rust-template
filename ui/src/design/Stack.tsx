import type { ReactNode } from "react";

export interface StackProps {
  readonly direction?: "column" | "row";
  readonly gap?: "s" | "m" | "l";
  readonly align?: "start" | "center" | "stretch";
  readonly children: ReactNode;
}

/** Lays its children out in a row or a column, spaced by a token. */
export function Stack({
  direction = "column",
  gap = "m",
  align = "stretch",
  children,
}: StackProps) {
  return (
    <div
      className={`ui-stack ui-stack--${direction} ui-stack--gap-${gap} ui-stack--align-${align}`}
    >
      {children}
    </div>
  );
}
