// @vitest-environment happy-dom

import { act } from "react"
import { hydrateRoot } from "react-dom/client"
import { renderToString } from "react-dom/server"
import { cleanup, render } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { APP_THEME_INIT_SCRIPT } from "@/lib/app-theme-init"
import { AppThemeInitScript } from "./app-theme-init-script"

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe("AppThemeInitScript", () => {
  it("is in the server's HTML, where it runs before the first paint", () => {
    expect(renderToString(<AppThemeInitScript />)).toBe(
      `<script>${APP_THEME_INIT_SCRIPT}</script>`,
    )
  })

  it("hydrates without an error", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {})
    const container = document.createElement("div")
    container.innerHTML = renderToString(<AppThemeInitScript />)
    document.body.appendChild(container)
    const recoverable = vi.fn()
    let root: ReturnType<typeof hydrateRoot>
    await act(async () => {
      root = hydrateRoot(container, <AppThemeInitScript />, { onRecoverableError: recoverable })
    })
    expect(recoverable).not.toHaveBeenCalled()
    expect(errors).not.toHaveBeenCalled()
    await act(async () => root.unmount())
    container.remove()
  })

  it("renders nothing when React renders it in the browser", () => {
    // Next's React build reports any script it creates on the client
    // ("Encountered a script tag while rendering React component"); the React
    // used in these tests does not, so the check is that none is created.
    const { container } = render(<AppThemeInitScript />)
    expect(container.innerHTML).toBe("")
  })
})
