import { describe, expect, it, vi } from "vitest";

describe("shell navigation", () => {
  it("uses the latest router navigate without replacing the guard", async () => {
    const { guardShellNavigate } = await import("./shell-navigation");
    const first = vi.fn();
    const latest = vi.fn();
    let navigate = first;
    const guarded = guardShellNavigate(
      () => navigate,
      () => true,
    );
    guarded("/app/a");
    navigate = latest;
    guarded("/app/b");
    expect(first).toHaveBeenCalledExactlyOnceWith("/app/a", undefined);
    expect(latest).toHaveBeenCalledExactlyOnceWith("/app/b", undefined);
  });

  it("ignores late work after the shell unmounts", async () => {
    const { guardShellNavigate } = await import("./shell-navigation");
    const navigate = vi.fn();
    let alive = true;
    const guarded = guardShellNavigate(
      () => navigate,
      () => alive,
    );
    guarded("/app/bot-b", { replace: true });
    guarded(-1);
    expect(navigate.mock.calls).toEqual([["/app/bot-b", { replace: true }], [-1]]);
    alive = false;
    guarded("/app/bot-a");
    guarded(-1);
    expect(navigate).toHaveBeenCalledTimes(2);
  });
});
