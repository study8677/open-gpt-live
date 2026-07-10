import { describe, expect, it } from "vitest";
import {
  beginRequest,
  canAcceptRequestEvent,
  cancelActiveRequests,
  settleRequest,
  transitionRequest,
  type RequestLifecycleRegistry
} from "./request-lifecycle";

describe("request lifecycle", () => {
  it("tracks an active voice turn through playback", () => {
    const registry: RequestLifecycleRegistry = new Map();
    beginRequest(registry, "voice-1", "recording", 1);

    expect(transitionRequest(registry, "voice-1", "transcribing", 2)).toBe(true);
    expect(transitionRequest(registry, "voice-1", "responding", 3)).toBe(true);
    expect(transitionRequest(registry, "voice-1", "playing", 4)).toBe(true);
    expect(canAcceptRequestEvent(registry, "voice-1", ["playing"])).toBe(true);
  });

  it("rejects late events after cancellation", () => {
    const registry: RequestLifecycleRegistry = new Map();
    beginRequest(registry, "voice-1", "recording", 1);
    settleRequest(registry, "voice-1", "cancelled", 2);

    expect(canAcceptRequestEvent(registry, "voice-1")).toBe(false);
    expect(transitionRequest(registry, "voice-1", "playing", 3)).toBe(false);
  });

  it("cancels only non-terminal requests after a disconnect", () => {
    const registry: RequestLifecycleRegistry = new Map();
    beginRequest(registry, "active", "responding", 1);
    beginRequest(registry, "done", "responding", 1);
    settleRequest(registry, "done", "completed", 2);

    expect(cancelActiveRequests(registry, 3)).toEqual(["active"]);
    expect(canAcceptRequestEvent(registry, "active")).toBe(false);
  });
});
