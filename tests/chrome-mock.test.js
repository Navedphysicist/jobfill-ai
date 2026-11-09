import { describe, it, expect, afterEach } from "vitest";

describe("chrome mock contract", () => {
  afterEach(() => chrome.runtime.__clearListeners());

  it("__dump returns the stored object", async () => {
    await chrome.storage.local.set({ a: 1, b: [2] });
    expect(chrome.storage.local.__dump()).toEqual({ a: 1, b: [2] });
  });

  it("isolation part 1: writes a key", async () => {
    await chrome.storage.local.set({ leaky: true });
    expect(chrome.storage.local.__dump()).toEqual({ leaky: true });
  });

  it("isolation part 2: key from previous test is absent", async () => {
    expect(chrome.storage.local.__dump()).toEqual({});
  });

  it("sendMessage resolves async return-true + deferred sendResponse", async () => {
    chrome.runtime.onMessage.addListener((msg, _s, send) => {
      setTimeout(() => send({ echoed: msg.x }), 0);
      return true;
    });
    expect(await chrome.runtime.sendMessage({ x: 5 })).toEqual({ echoed: 5 });
  });

  it("sendMessage resolves synchronous sendResponse", async () => {
    chrome.runtime.onMessage.addListener((msg, _s, send) => {
      send({ sync: msg.x });
    });
    expect(await chrome.runtime.sendMessage({ x: 7 })).toEqual({ sync: 7 });
  });

  it("onInstalled and onStartup listeners register and can be invoked", () => {
    const seen = [];
    chrome.runtime.onInstalled.addListener((d) => seen.push(["i", d.reason]));
    chrome.runtime.onStartup.addListener(() => seen.push(["s"]));
    for (const fn of chrome.runtime.onInstalled.__listeners) fn({ reason: "install" });
    for (const fn of chrome.runtime.onStartup.__listeners) fn();
    expect(seen).toEqual([["i", "install"], ["s"]]);
  });

  it("__reset does not clear listeners; __clearListeners does", async () => {
    chrome.runtime.onMessage.addListener((m, _s, send) => send("hi"));
    chrome.storage.local.__reset();
    expect(await chrome.runtime.sendMessage({})).toBe("hi");
    chrome.runtime.__clearListeners();
    expect(await chrome.runtime.sendMessage({})).toBeUndefined();
  });
});
