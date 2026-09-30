import { describe, expect, it } from "vitest";

import {
  evaluateOnPush,
  isWholeExpression,
  templateOnPush,
  truthy,
  type PushValue,
} from "./expressions.ts";

const lit = (value: string | number | boolean | null): PushValue => ({ kind: "literal", value });
const ctx = (path: string): PushValue => ({ kind: "context", path });
const UNKNOWN: PushValue = { kind: "unknown" };

describe("evaluateOnPush", () => {
  it("knows the event name and the contexts a push leaves empty", () => {
    expect(evaluateOnPush("github.event_name")).toEqual(lit("push"));
    expect(evaluateOnPush("github.head_ref")).toEqual(lit(""));
    expect(evaluateOnPush("github.event.pull_request.number")).toEqual(lit(null));
    expect(evaluateOnPush("GitHub.SHA")).toEqual(ctx("github.sha"));
  });

  it("reads literals and keywords", () => {
    expect(evaluateOnPush("'it''s'")).toEqual(lit("it's"));
    expect(evaluateOnPush("42")).toEqual(lit(42));
    expect(evaluateOnPush("true")).toEqual(lit(true));
    expect(evaluateOnPush("false")).toEqual(lit(false));
    expect(evaluateOnPush("null")).toEqual(lit(null));
  });

  it("follows && and || as GitHub does, returning an operand", () => {
    expect(
      evaluateOnPush("github.event_name == 'pull_request' && github.ref || github.sha"),
    ).toEqual(ctx("github.sha"));
    expect(evaluateOnPush("github.event_name == 'push' && github.ref || github.sha")).toEqual(
      ctx("github.ref"),
    );
    expect(evaluateOnPush("github.head_ref || github.run_id")).toEqual(ctx("github.run_id"));
  });

  it("compares case-insensitively and across types", () => {
    expect(evaluateOnPush("github.event_name == 'PUSH'")).toEqual(lit(true));
    expect(evaluateOnPush("github.event_name != 'push'")).toEqual(lit(false));
    expect(evaluateOnPush("1 == true")).toEqual(lit(true));
    expect(evaluateOnPush("null == 0")).toEqual(lit(true));
    expect(evaluateOnPush("false == false")).toEqual(lit(true));
    expect(evaluateOnPush("'1' == 1")).toEqual(lit(true));
  });

  it("negates and groups", () => {
    expect(evaluateOnPush("!(github.event_name == 'push')")).toEqual(lit(false));
    expect(evaluateOnPush("!github.sha")).toEqual(lit(false));
  });

  it("leaves what it cannot know unknown instead of guessing", () => {
    expect(evaluateOnPush("github.ref != 'refs/heads/main'")).toEqual(UNKNOWN);
    expect(evaluateOnPush("!inputs.cancel")).toEqual(UNKNOWN);
    expect(evaluateOnPush("inputs.x && github.sha")).toEqual(UNKNOWN);
    expect(evaluateOnPush("inputs.x || github.sha")).toEqual(UNKNOWN);
  });

  it("refuses what it does not read", () => {
    for (const source of [
      "format('{0}', github.sha)",
      "github.event.commits[0]",
      "github.run_number > 1",
      "'unterminated",
      "(github.sha",
      "github.sha ==",
      "github.sha &&",
      "github.sha ||",
      "!",
      ")",
      "",
      "github.sha github.ref",
    ]) {
      expect(evaluateOnPush(source), source).toBeUndefined();
    }
  });
});

describe("truthy", () => {
  it("is known for literals and the contexts a push always sets", () => {
    expect(truthy(lit(""))).toBe(false);
    expect(truthy(lit(0))).toBe(false);
    expect(truthy(lit("x"))).toBe(true);
    expect(truthy({ kind: "context", path: "github.sha" })).toBe(true);
    expect(truthy({ kind: "context", path: "matrix.os" })).toBeUndefined();
    expect(truthy({ kind: "unknown" })).toBeUndefined();
  });
});

describe("templateOnPush", () => {
  it("splits a group into its literal text and evaluated expressions", () => {
    expect(templateOnPush("ci-${{ github.workflow }}-${{ github.sha }}!")).toEqual([
      lit("ci-"),
      ctx("github.workflow"),
      lit("-"),
      ctx("github.sha"),
      lit("!"),
    ]);
    expect(templateOnPush("plain")).toEqual([lit("plain")]);
  });

  it("is undefined when one expression cannot be read", () => {
    expect(templateOnPush("${{ github.workflow }}-${{ format('{0}', github.sha) }}")).toBe(
      undefined,
    );
  });
});

describe("isWholeExpression", () => {
  it("is true only for one expression and nothing around it", () => {
    expect(isWholeExpression(" ${{ github.event_name == 'pull_request' }} ")).toBe(true);
    expect(isWholeExpression("x ${{ true }}")).toBe(false);
    expect(isWholeExpression("${{ true }}${{ false }}")).toBe(false);
    expect(isWholeExpression("true")).toBe(false);
  });
});
