/**
 * The sample screen: a thin renderer over `useCounter`. A deletable
 * illustration — `starting-an-app` lists what to remove when replacing it.
 */
import "./CounterScreen.css";

import { useId } from "react";

import { counterCopy, describeCounterError, describeLastChanged } from "../copy/counter";
import { Button, IconButton, Panel, Stack, Text } from "../design";
import { useCounter } from "./useCounter";

export function CounterScreen() {
  const { state, increment, decrement, reset, retry } = useCounter();
  const titleId = useId();

  return (
    <main className="counter-screen">
      <div className="counter-screen__panel">
        <Panel as="section" labelledBy={titleId}>
          <Stack gap="m" align="center">
            <Text as="h1" variant="title" id={titleId}>
              {counterCopy.title}
            </Text>
            {state.status === "loading" && <Text variant="secondary">{counterCopy.loading}</Text>}
            {state.status === "failed" && (
              <>
                <Text key={state.errorCount} variant="danger" role="alert">
                  {state.error === "unexpected"
                    ? counterCopy.loadFailed
                    : describeCounterError(state.error)}
                </Text>
                <Stack direction="row" gap="s" align="center">
                  <Button onClick={retry}>{counterCopy.retry}</Button>
                  {state.error !== "unexpected" &&
                    state.error.code === "storage" &&
                    state.error.kind === "corrupt" && (
                      <Button onClick={() => void reset()}>{counterCopy.reset}</Button>
                    )}
                </Stack>
              </>
            )}
            {state.status === "ready" && (
              <>
                <Text as="output" variant="largeTitle" role="status" labelledBy={titleId}>
                  {state.view.value}
                </Text>
                <Text variant="secondary">{describeLastChanged(state.view.lastChangedAt)}</Text>
                <Stack direction="row" gap="s" align="center">
                  <IconButton
                    label={counterCopy.decrement}
                    glyph="−"
                    onClick={() => void decrement()}
                  />
                  <IconButton
                    label={counterCopy.increment}
                    glyph="+"
                    onClick={() => void increment()}
                  />
                  <Button onClick={() => void reset()}>{counterCopy.reset}</Button>
                </Stack>
                {state.error !== null && (
                  <Text key={state.errorCount} variant="danger" role="alert">
                    {state.error === "unexpected"
                      ? counterCopy.unexpected
                      : describeCounterError(state.error)}
                  </Text>
                )}
              </>
            )}
          </Stack>
        </Panel>
      </div>
    </main>
  );
}
