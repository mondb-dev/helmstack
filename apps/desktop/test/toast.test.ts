import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { toast } from "../src/renderer/ui/toast.js";

const AUTO_MS = 4000;

describe("toast", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    document.body.replaceChildren();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("lazily creates a polite role=status region", () => {
    toast("hello");
    const region = document.getElementById("toast-region");
    expect(region?.getAttribute("role")).toBe("status");
    expect(region?.getAttribute("aria-live")).toBe("polite");
  });

  it("appends a kinded toast node with the message text", () => {
    toast("Saved", "success");
    const node = document.querySelector(".toast--success");
    expect(node?.querySelector(".toast__message")?.textContent).toBe("Saved");
  });

  it("auto-dismisses info/success after ~4s", () => {
    toast("Saved", "success");
    expect(document.querySelectorAll(".toast")).toHaveLength(1);
    vi.advanceTimersByTime(AUTO_MS);
    expect(document.querySelectorAll(".toast")).toHaveLength(0);
  });

  it("error toasts persist past the auto-dismiss window and carry role=alert", () => {
    toast("Boom", "error");
    expect(document.querySelector(".toast--error")?.getAttribute("role")).toBe("alert");
    vi.advanceTimersByTime(AUTO_MS * 3);
    expect(document.querySelectorAll(".toast--error")).toHaveLength(1);
  });

  it("error toast exposes a working close button", () => {
    const handle = toast("Boom", "error");
    const close = handle.element.querySelector(".toast__close") as HTMLButtonElement | null;
    expect(close).not.toBeNull();
    close!.click();
    expect(document.querySelectorAll(".toast")).toHaveLength(0);
  });

  it("handle.dismiss() removes the toast immediately", () => {
    const handle = toast("hi");
    handle.dismiss();
    expect(document.querySelectorAll(".toast")).toHaveLength(0);
  });

  it("stacks multiple toasts in the same region", () => {
    toast("one");
    toast("two");
    expect(document.querySelectorAll("#toast-region .toast")).toHaveLength(2);
  });
});
