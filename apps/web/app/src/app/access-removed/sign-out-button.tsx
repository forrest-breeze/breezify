"use client"

import { useState } from "react"
import { signOutAndRedirect } from "@/lib/auth/sign-out"

export function SignOutButton() {
  const [busy, setBusy] = useState(false)
  return (
    <button
      type="button"
      disabled={busy}
      onClick={() => {
        setBusy(true)
        void signOutAndRedirect()
      }}
      className="rounded-md border px-4 py-2 hover:bg-accent disabled:opacity-60"
    >
      {busy ? "Signing out..." : "Sign out"}
    </button>
  )
}
