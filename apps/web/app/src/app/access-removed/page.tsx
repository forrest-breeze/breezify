import type { Metadata } from "next"
import { SignOutButton } from "./sign-out-button"

export const metadata: Metadata = { title: "Access removed" }

// Shown when an admin has deactivated the signed-in user (see
// app/(app)/layout.tsx). Holds no workspace data, so it needs no auth check.
export default function AccessRemovedPage() {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-4 p-6 text-center">
      <h1 className="text-2xl font-semibold">Your access has been removed</h1>
      <p className="text-muted-foreground max-w-md">
        An admin has deactivated your Breezify account. If you think this is a
        mistake, ask a workspace admin to reactivate you.
      </p>
      <SignOutButton />
    </div>
  )
}
