import type { ReactNode } from "react";

export type TextVariant = "largeTitle" | "title" | "body" | "secondary" | "danger";

const CLASS: Readonly<Record<TextVariant, string>> = {
  largeTitle: "ui-text--large-title",
  title: "ui-text--title",
  body: "ui-text--body",
  secondary: "ui-text--secondary",
  danger: "ui-text--danger",
};

export interface TextProps {
  readonly variant?: TextVariant;
  readonly as?: "p" | "span" | "h1" | "h2" | "output";
  readonly id?: string;
  readonly role?: "alert" | "status";
  /** The id of the element that names this one, such as the heading a status reports for. */
  readonly labelledBy?: string;
  readonly children: ReactNode;
}

/** Text in one of the design system's styles. */
export function Text({
  variant = "body",
  as: Element = "p",
  id,
  role,
  labelledBy,
  children,
}: TextProps) {
  return (
    <Element id={id} role={role} aria-labelledby={labelledBy} className={CLASS[variant]}>
      {children}
    </Element>
  );
}
