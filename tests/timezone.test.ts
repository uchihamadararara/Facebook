import { describe, expect, it } from "vitest";
import { addLocalDays, localDateAt, localTimeToUtcIso, validateTimezone } from "../src/timezone";

describe("timezone planner helpers", () => {
  it("uses the requested local timezone", () => {
    const instant = new Date("2026-11-01T00:00:00.000Z");
    expect(localDateAt(instant, "Asia/Kolkata")).toBe("2026-11-01");
    expect(localDateAt(instant, "America/Los_Angeles")).toBe("2026-10-31");
  });
  it("adds calendar days without drifting by timezone", () => {
    expect(addLocalDays("2026-12-31", 1)).toBe("2027-01-01");
  });
  it("maps a local Kolkata slot to UTC correctly", () => {
    expect(localTimeToUtcIso("2026-11-02", 8 * 60, "Asia/Kolkata")).toBe("2026-11-02T02:30:00.000Z");
  });
  it("rejects invalid timezone names", () => {
    expect(() => validateTimezone("Mars/Olympus")).toThrow();
  });
});
