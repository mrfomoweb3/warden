import { describe, expect, it } from "vitest";
import { validStep } from "./researcher.js";

describe("validStep", () => {
  const vendors = ["search-a", "search-b"];
  it("accepts whitelisted tools with valid arguments", () => {
    expect(validStep({ action: "search", vendor: "search-b", q: " sui price " }, vendors)).toEqual({ action: "search", vendor: "search-b", q: "sui price" });
    expect(validStep({ action: "price", symbol: "sui" }, vendors)).toEqual({ action: "price", symbol: "SUI" });
    expect(validStep({ action: "done", answer: "Up 3%." }, vendors)).toEqual({ action: "done", answer: "Up 3%." });
  });
  it("rejects anything the model makes up", () => {
    expect(validStep({ action: "search", vendor: "evil.example", q: "x" }, vendors)).toBeNull();
    expect(validStep({ action: "price", symbol: "../risk/0x1" }, vendors)).toBeNull();
    expect(validStep({ action: "fetch", url: "https://x" }, vendors)).toBeNull();
    expect(validStep(null, vendors)).toBeNull();
  });
});
