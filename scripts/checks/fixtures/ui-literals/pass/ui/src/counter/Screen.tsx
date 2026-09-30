// ui-literals fixture: styles through var(--…) only. A comment: #fff, rgb(0 0 0).
import "./Screen.css";

const LABEL = "Set the color to red";
const STATUS = "Status: red";
const ISSUE = "Build #1234";
const size = 2;
const VARIANT = "red";

export function Screen() {
  return (
    <div
      style={{
        padding: "var(--space-2)",
        color: "var(--color-accent)",
        fontFamily: "var(--font-family-mono)",
        fontSize: "var(--font-size-body)",
        width: 360,
        "--local-width": `${String(size * 180)}px`,
        maxWidth: "var(--local-width)",
      }}
      data-variant={VARIANT}
      aria-label="The red button"
      title={`${String(size)}px wide, color: ${LABEL}`}
    >
      {STATUS} {ISSUE} white text in JSX is not a style
    </div>
  );
}
