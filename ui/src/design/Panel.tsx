import type { ReactNode } from "react";

export interface PanelProps {
  /** `section` when the panel has a heading, so it becomes a landmark region. */
  readonly as?: "div" | "section";
  readonly labelledBy?: string;
  readonly children: ReactNode;
}

/** A raised surface grouping related content. */
export function Panel({ as: Element = "div", labelledBy, children }: PanelProps) {
  return (
    <Element className="ui-panel" aria-labelledby={labelledBy}>
      {children}
    </Element>
  );
}
