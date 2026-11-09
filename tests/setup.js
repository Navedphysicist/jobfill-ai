import { beforeEach } from "vitest";
import { createChromeMock } from "./chrome-mock.js";

globalThis.chrome = createChromeMock();

beforeEach(() => {
  chrome.storage.local.__reset();
  chrome.runtime.lastError = null;
});
