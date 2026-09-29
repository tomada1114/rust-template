import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { Button, IconButton, Panel, Stack, Text } from ".";

describe("Button", () => {
  it("is a secondary button of type button by default", () => {
    render(<Button>Save</Button>);
    const button = screen.getByRole("button", { name: "Save" });
    expect(button).toHaveAttribute("type", "button");
    expect(button).toHaveClass("ui-button");
    expect(button).not.toHaveClass("ui-button--primary");
  });

  it("marks the primary variant and forwards clicks", async () => {
    const onClick = vi.fn();
    render(
      <Button variant="primary" onClick={onClick}>
        Go
      </Button>,
    );
    await userEvent.click(screen.getByRole("button", { name: "Go" }));
    expect(onClick).toHaveBeenCalledOnce();
    expect(screen.getByRole("button", { name: "Go" })).toHaveClass("ui-button--primary");
  });
});

describe("IconButton", () => {
  it("takes its accessible name from the label, not the glyph", () => {
    render(<IconButton label="Increment" glyph="+" />);
    const button = screen.getByRole("button", { name: "Increment" });
    expect(button).toHaveTextContent("+");
    expect(button.querySelector("[aria-hidden='true']")).not.toBeNull();
  });
});

describe("Stack", () => {
  it("applies the direction, gap, and alignment classes", () => {
    const { container } = render(
      <Stack direction="row" gap="s" align="center">
        <span>a</span>
      </Stack>,
    );
    expect(container.firstChild).toHaveClass(
      "ui-stack--row",
      "ui-stack--gap-s",
      "ui-stack--align-center",
    );
  });

  it("defaults to a stretched column with medium gaps", () => {
    const { container } = render(
      <Stack>
        <span>a</span>
      </Stack>,
    );
    expect(container.firstChild).toHaveClass(
      "ui-stack--column",
      "ui-stack--gap-m",
      "ui-stack--align-stretch",
    );
  });
});

describe("Panel", () => {
  it("becomes a named region when it is a labelled section", () => {
    render(
      <Panel as="section" labelledBy="t">
        <h2 id="t">Title</h2>
      </Panel>,
    );
    expect(screen.getByRole("region", { name: "Title" })).toHaveClass("ui-panel");
  });

  it("is a plain div by default", () => {
    const { container } = render(<Panel>content</Panel>);
    expect(container.firstChild?.nodeName).toBe("DIV");
  });
});

describe("Text", () => {
  it("renders a paragraph in the body style by default", () => {
    render(<Text>hello</Text>);
    const text = screen.getByText("hello");
    expect(text.nodeName).toBe("P");
    expect(text).toHaveClass("ui-text--body");
  });

  it("renders the requested element, style, and role", () => {
    render(
      <Text as="h1" variant="title" id="x">
        heading
      </Text>,
    );
    expect(screen.getByRole("heading", { name: "heading" })).toHaveClass("ui-text--title");
    render(
      <Text variant="danger" role="alert">
        oops
      </Text>,
    );
    expect(screen.getByRole("alert")).toHaveClass("ui-text--danger");
  });
});
