/**
 * Test helpers for the IPC boundary. They live in ui/src/ipc/ so the rule "only
 * ui/src/ipc/ imports @tauri-apps/*" holds for tests too. Production code never
 * imports this module.
 */
import { emit } from "@tauri-apps/api/event";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";

export type CommandHandler = (args: unknown) => unknown;

/**
 * Mock the Rust side: each command answers with its handler, an unmocked command fails
 * loudly, and events are simulated (`shouldMockEvents`). Returns the commands called,
 * in order (event-plugin calls are handled by the mock and not recorded).
 */
export function mockCommands(handlers: Readonly<Record<string, CommandHandler>>): string[] {
  const calls: string[] = [];
  mockIPC(
    (cmd, args) => {
      calls.push(cmd);
      const handler = handlers[cmd];
      if (handler === undefined) throw new Error(`unexpected command ${cmd}`);
      return handler(args);
    },
    { shouldMockEvents: true },
  );
  return calls;
}

/**
 * A rejected command reply, as Tauri delivers one: the command's error value itself
 * (a plain `{ code: … }` object from Rust), not an `Error`.
 */
export function rejectWith(payload: unknown): Promise<never> {
  return Promise.resolve().then(() => {
    throw payload;
  });
}

/** Deliver an event as if Rust had emitted it. Requires `mockCommands` first. */
export const emitEvent = (name: string, payload: unknown): Promise<void> => emit(name, payload);

/** The mocked event plugin's internals, for asserting that a listener was removed. */
export function eventInternals(): { unregisterListener: (event: string, id: number) => void } {
  return (
    window as unknown as {
      __TAURI_EVENT_PLUGIN_INTERNALS__: { unregisterListener: (event: string, id: number) => void };
    }
  ).__TAURI_EVENT_PLUGIN_INTERNALS__;
}

/** Remove every IPC mock. The test setup calls it after each test. */
export const resetIpcMocks = (): void => {
  clearMocks();
};
