import { describe, expect, it } from "vitest";

import { COUNTER_CHANGED, onCounterChanged } from "./events";
import { emitEvent, mockCommands } from "./testing";

describe("onCounterChanged", () => {
  it("listens to the event name Rust emits", () => {
    expect(COUNTER_CHANGED).toBe("counter-changed");
  });

  it("hands the payload to the handler until unlistened", async () => {
    mockCommands({});
    const seen: unknown[] = [];
    const unlisten = await onCounterChanged((view) => seen.push(view));
    await emitEvent("counter-changed", { value: 4, lastChangedAt: 9, revision: 1 });
    unlisten();
    await emitEvent("counter-changed", { value: 5, lastChangedAt: 10, revision: 2 });
    expect(seen).toEqual([{ value: 4, lastChangedAt: 9, revision: 1 }]);
  });
});
