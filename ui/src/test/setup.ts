// Test setup for the `ui` Vitest project. @tauri-apps/api/mocks needs
// crypto.getRandomValues, which Node 26 provides globally inside jsdom as well.
import "@testing-library/jest-dom/vitest";

import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

import { resetIpcMocks } from "../ipc/testing";

afterEach(async () => {
  cleanup();
  // Unmounting starts async unlistens; let them reach the mocks before removing them.
  await new Promise((resolve) => setTimeout(resolve, 0));
  resetIpcMocks();
});
