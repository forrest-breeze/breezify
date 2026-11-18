import { describe, expect, it } from "vitest";
import { hasWorkspaceRole, requireWorkspaceRole } from "./workspace-role";

describe("hasWorkspaceRole", () => {
  it("allows roles at or above the minimum", () => {
    expect(hasWorkspaceRole("owner", "editor")).toBe(true);
    expect(hasWorkspaceRole("admin", "editor")).toBe(true);
    expect(hasWorkspaceRole("editor", "editor")).toBe(true);
  });

  it("rejects roles below the minimum", () => {
    expect(hasWorkspaceRole("viewer", "editor")).toBe(false);
    expect(hasWorkspaceRole("agent-only", "editor")).toBe(false);
    expect(hasWorkspaceRole("editor", "admin")).toBe(false);
  });

  it("fails closed on missing or unknown roles", () => {
    expect(hasWorkspaceRole(undefined, "viewer")).toBe(false);
    expect(hasWorkspaceRole(null, "viewer")).toBe(false);
    expect(hasWorkspaceRole("superuser", "viewer")).toBe(false);
    expect(hasWorkspaceRole("toString", "viewer")).toBe(false);
  });
});

describe("requireWorkspaceRole", () => {
  it("returns null when allowed", () => {
    expect(requireWorkspaceRole("editor", "editor")).toBeNull();
  });

  it("returns a 403 when not allowed", async () => {
    const res = requireWorkspaceRole("viewer", "editor");
    expect(res?.status).toBe(403);
    expect(await res?.json()).toMatchObject({ code: "insufficient_role" });
  });
});
