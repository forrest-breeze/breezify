// @vitest-environment jsdom

import { useRef } from "react"
import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { PortalCopyPageButton } from "./portal-copy-page-button"

const writeText = vi.fn<(text: string) => Promise<void>>()

function Harness({
  heading,
  markdownHref,
}: {
  heading?: string
  markdownHref?: string
}): React.ReactElement {
  const ref = useRef<HTMLDivElement>(null)
  return (
    <div>
      <PortalCopyPageButton targetRef={ref} heading={heading} markdownHref={markdownHref} />
      <div ref={ref}>
        <p>Rendered article</p>
      </div>
    </div>
  )
}

/**
 * userEvent.setup() installs its own clipboard stub, so the spy has to replace
 * it afterwards — hence a helper rather than a beforeEach.
 */
function stubClipboard(): void {
  Object.defineProperty(navigator, "clipboard", {
    value: { writeText },
    configurable: true,
  })
}

beforeEach(() => {
  writeText.mockReset()
  writeText.mockResolvedValue(undefined)
  // jsdom implements no layout, so innerText is absent — the copy path reads it
  // for its block-aware line breaks, which textContent would flatten.
  Object.defineProperty(HTMLElement.prototype, "innerText", {
    get(this: HTMLElement) {
      return this.textContent
    },
    configurable: true,
  })
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe("PortalCopyPageButton", () => {
  it("copies the page's Markdown twin and confirms", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response("# Quickstart\n\nFrom source", { status: 200 }))
    vi.stubGlobal("fetch", fetchMock)
    const user = userEvent.setup()
    stubClipboard()
    render(<Harness heading="Quickstart" markdownHref="/p/acme/doc/quickstart.md" />)

    await user.click(screen.getByRole("button", { name: "Copy page" }))

    await waitFor(() =>
      expect(writeText).toHaveBeenCalledWith("# Quickstart\n\nFrom source"),
    )
    expect(fetchMock.mock.calls[0]?.[0]).toBe("/p/acme/doc/quickstart.md")
    expect(await screen.findByRole("button", { name: "Copied" })).toBeInTheDocument()
  })

  it("falls back to the rendered article as Markdown without a twin", async () => {
    const fetchMock = vi.fn(async () => new Response("Not found", { status: 404 }))
    vi.stubGlobal("fetch", fetchMock)
    const user = userEvent.setup()
    stubClipboard()
    render(<Harness heading="Quickstart" markdownHref="/p/acme/doc/draft.md" />)

    await user.click(screen.getByRole("button", { name: "Copy page" }))

    await waitFor(() =>
      expect(writeText).toHaveBeenCalledWith("# Quickstart\n\nRendered article"),
    )
  })

  it("copies the rendered article alone when it already carries the title", async () => {
    const user = userEvent.setup()
    stubClipboard()
    render(<Harness />)

    await user.click(screen.getByRole("button", { name: "Copy page" }))

    await waitFor(() => expect(writeText).toHaveBeenCalledWith("Rendered article"))
  })

  it("stays in its resting state when the clipboard is unavailable", async () => {
    const user = userEvent.setup()
    stubClipboard()
    writeText.mockRejectedValue(new Error("denied"))
    render(<Harness heading="Quickstart" />)

    await user.click(screen.getByRole("button", { name: "Copy page" }))

    await waitFor(() => expect(writeText).toHaveBeenCalled())
    expect(screen.getByRole("button", { name: "Copy page" })).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "Copied" })).toBeNull()
  })
})
