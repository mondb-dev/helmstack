import { describe, expect, it } from "vitest";

import { meterLevel, terminalLineClass, TERMINAL_LEVEL_CLASS } from "../src/renderer/ui/dataview.js";

describe("terminalLineClass", () => {
  it("maps each level to its semantic class", () => {
    expect(terminalLineClass("system")).toBe("terminal-line terminal-system");
    expect(terminalLineClass("agent")).toBe("terminal-line terminal-agent");
    expect(terminalLineClass("ai")).toBe("terminal-line terminal-ai");
    expect(terminalLineClass("error")).toBe("terminal-line terminal-error");
    expect(terminalLineClass("nav")).toBe("terminal-line terminal-nav");
  });

  it("covers every level in the map", () => {
    for (const level of Object.keys(TERMINAL_LEVEL_CLASS)) {
      expect(terminalLineClass(level as keyof typeof TERMINAL_LEVEL_CLASS)).toContain("terminal-line");
    }
  });
});

describe("meterLevel", () => {
  it("higher-is-better: ≥90 good, ≥70 warn, else bad", () => {
    expect(meterLevel(95)).toBe("good");
    expect(meterLevel(90)).toBe("good");
    expect(meterLevel(75)).toBe("warn");
    expect(meterLevel(70)).toBe("warn");
    expect(meterLevel(40)).toBe("bad");
  });

  it("respects custom thresholds", () => {
    expect(meterLevel(60, { good: 50, warn: 30 })).toBe("good");
    expect(meterLevel(35, { good: 50, warn: 30 })).toBe("warn");
    expect(meterLevel(10, { good: 50, warn: 30 })).toBe("bad");
  });

  it("lower-is-better flips the comparison (e.g. error rate)", () => {
    expect(meterLevel(5, { good: 10, warn: 30, higherIsBetter: false })).toBe("good");
    expect(meterLevel(20, { good: 10, warn: 30, higherIsBetter: false })).toBe("warn");
    expect(meterLevel(50, { good: 10, warn: 30, higherIsBetter: false })).toBe("bad");
  });
});
