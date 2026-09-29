import type { ButtonHTMLAttributes, ReactNode } from "react";

export interface ButtonProps extends Omit<
  ButtonHTMLAttributes<HTMLButtonElement>,
  "className" | "style"
> {
  /** `primary` for the one main action in a view; `secondary` otherwise. */
  readonly variant?: "primary" | "secondary";
  readonly children: ReactNode;
}

/** A push button with a text label. */
export function Button({ variant = "secondary", type = "button", children, ...rest }: ButtonProps) {
  const className = variant === "primary" ? "ui-button ui-button--primary" : "ui-button";
  return (
    <button {...rest} type={type} className={className}>
      {children}
    </button>
  );
}
