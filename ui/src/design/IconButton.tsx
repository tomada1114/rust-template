import type { ButtonHTMLAttributes } from "react";

export interface IconButtonProps extends Omit<
  ButtonHTMLAttributes<HTMLButtonElement>,
  "className" | "style" | "children" | "aria-label"
> {
  /** The accessible name, read by VoiceOver and used by tests. Required. */
  readonly label: string;
  /** The visible glyph; hidden from assistive technology. */
  readonly glyph: string;
}

/** A button whose face is a glyph. Its name comes from `label`, never from the glyph. */
export function IconButton({ label, glyph, type = "button", ...rest }: IconButtonProps) {
  return (
    <button
      {...rest}
      type={type}
      aria-label={label}
      title={label}
      className="ui-button ui-icon-button"
    >
      <span aria-hidden="true">{glyph}</span>
    </button>
  );
}
