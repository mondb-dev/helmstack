import { beforeEach, describe, expect, it } from "vitest";

import { mountAddressBar } from "../src/renderer/panels/address-bar.js";

function setup() {
  document.body.innerHTML = '<input id="a" />';
  const input = document.getElementById("a") as HTMLInputElement;
  let url = "https://a.test/";
  const bar = mountAddressBar({ input, currentValue: () => url });
  bar.sync();
  return { input, bar, navigate: (next: string) => { url = next; bar.sync(); } };
}

const type = (input: HTMLInputElement, value: string) => {
  input.value = value;
  input.dispatchEvent(new Event("input", { bubbles: true }));
};

describe("address bar dirty flag", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it("follows agent navigations even when focused programmatically", () => {
    const { input, navigate } = setup();
    input.focus();
    navigate("https://b.test/");
    expect(input.value).toBe("https://b.test/");
  });

  it("keeps what the user typed until submit, blur or Escape", () => {
    const { input, bar, navigate } = setup();
    input.focus();
    type(input, "exam");
    navigate("https://b.test/");
    expect(input.value).toBe("exam");
    expect(bar.isDirty()).toBe(true);

    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(input.value).toBe("https://b.test/");
    expect(bar.isDirty()).toBe(false);

    type(input, "x");
    bar.markSubmitted();
    expect(bar.isDirty()).toBe(false);
    navigate("https://c.test/");
    expect(input.value).toBe("https://c.test/");

    type(input, "y");
    input.dispatchEvent(new Event("blur"));
    expect(input.value).toBe("https://c.test/");
    expect(bar.isDirty()).toBe(false);
  });
});
