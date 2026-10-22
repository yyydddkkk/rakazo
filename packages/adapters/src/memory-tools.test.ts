import { describe, expect, it } from "vitest";
import { appendMemoryFact } from "./memory-tools.js";

describe("appendMemoryFact", () => {
  it("keeps existing memory and adds the fact on its own line", () => {
    expect(appendMemoryFact("Save trip files to Drive.\n", "The client is Combient.")).toBe(
      "Save trip files to Drive.\nThe client is Combient.\n",
    );
  });

  it.each(["Berlin\r\nother\n", "  Berlin  \nother\n", "before\n\tBerlin\t\nafter\n"])(
    "preserves whitespace-tolerant single-line duplicates in %j",
    (existing) => {
      expect(appendMemoryFact(existing, "Berlin")).toBe(existing);
    },
  );

  it.each(["Intro.\n\n", "line  \n", "line  ", "line\r\n", "   "])(
    "preserves existing Markdown whitespace in %j when appending",
    (existing) => {
      const separator = existing.endsWith("\n") ? "" : "\n";
      expect(appendMemoryFact(existing, "new fact")).toBe(`${existing}${separator}new fact\n`);
    },
  );

  it("starts an empty document with the fact", () => {
    expect(appendMemoryFact("", "  durable fact  ")).toBe("durable fact\n");
  });

  it("leaves memory unchanged for a fact it already holds or an empty fact", () => {
    expect(appendMemoryFact("a\ndurable fact\n", "durable fact")).toBe("a\ndurable fact\n");
    expect(appendMemoryFact("a\n", "   ")).toBe("a\n");
  });
});

describe("multiline memory facts", () => {
  it("recognizes a complete block at the beginning, middle, or end", () => {
    for (const existing of [
      "Office:\nBerlin\n",
      "before\nOffice:\nBerlin\nafter\n",
      "before\nOffice:\nBerlin",
    ]) {
      expect(appendMemoryFact(existing, "Office:\nBerlin")).toBe(existing);
    }
  });

  it.each([
    ["Office:\r\nBerlin\r\n", "Office:\nBerlin"],
    ["Office:\nBerlin\n", "Office:\r\nBerlin"],
    ["before\r\nOffice:\r\nBerlin\r\nafter\r\n", "Office:\nBerlin"],
  ])("matches multiline blocks across newline formats", (existing, fact) => {
    expect(appendMemoryFact(existing, fact)).toBe(existing);
  });

  it("does not match partial lines or nonconsecutive lines", () => {
    for (const existing of [
      "Main Office:\nBerlin\n",
      "Office:\nBerlin Mitte\n",
      "Office:\nother\nBerlin\n",
    ]) {
      expect(appendMemoryFact(existing, "Office:\nBerlin")).toBe(`${existing}Office:\nBerlin\n`);
    }
  });
});
