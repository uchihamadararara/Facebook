import { describe, expect, it } from "vitest";
import { makeSlots, statusAfterPause } from "../src/scheduler";

describe("random publishing slots", () => {
  it("keeps every slot inside the local publishing window", () => {
    const slots = makeSlots(4, 8 * 60, 20 * 60, 60);
    expect(slots.length).toBeGreaterThan(0);
    expect(slots.every(value => value >= 8 * 60 && value <= 20 * 60)).toBe(true);
  });
  it("respects the minimum gap between new slots", () => {
    const slots = makeSlots(5, 8 * 60, 22 * 60, 90);
    for (let i = 1; i < slots.length; i++) expect(slots[i] - slots[i - 1]).toBeGreaterThanOrEqual(90);
  });
  it("does not schedule too close to existing manual or scheduled posts", () => {
    const occupied = [9 * 60, 14 * 60];
    const slots = makeSlots(8, 8 * 60, 22 * 60, 90, occupied);
    for (const slot of slots) for (const prior of occupied) expect(Math.abs(slot - prior)).toBeGreaterThanOrEqual(90);
  });
  it("returns no slot when the window is exhausted", () => {
    expect(makeSlots(3, 20, 10, 15)).toEqual([]);
  });
  it("keeps future paused jobs scheduled instead of publishing them early", () => {
    const now = new Date("2026-11-01T09:00:00.000Z");
    expect(statusAfterPause("scheduled", "2026-11-01T12:00:00.000Z", now)).toBe("scheduled");
    expect(statusAfterPause("scheduled", "2026-11-01T08:00:00.000Z", now)).toBe("queued");
    expect(statusAfterPause("queued", "2026-11-01T12:00:00.000Z", now)).toBe("queued");
  });
});
