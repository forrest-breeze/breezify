// @vitest-environment happy-dom

import { fireEvent, render, screen, within } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"
import { PORTAL_SCHEMA_VERSION, type PortalLayout } from "@/lib/portal/schema"
import { PortalThemeControls } from "./portal-theme-controls"

function layout(): PortalLayout {
  return {
    schemaVersion: PORTAL_SCHEMA_VERSION,
    theme: {
      brandName: "Acme",
      tagline: "Docs",
      logoUrl: "",
      accentColor: "#2f5520",
      navLinks: [],
      cta: null,
      font: "sans",
      appearance: "auto",
    },
    header: {
      id: "header",
      type: "portal-header",
      search: { enabled: true, placeholder: "Search or ask AI" },
    },
    body: [],
    footer: { id: "footer", type: "footer", showPoweredBy: true },
  }
}

describe("PortalThemeControls", () => {
  it("shows separate light and dark logo controls plus favicon branding", () => {
    render(
      <PortalThemeControls layout={layout()} onLayoutChange={vi.fn()} />,
    )

    expect(screen.getByLabelText("Light mode logo upload")).toBeInTheDocument()
    expect(screen.getByLabelText("Dark mode logo upload")).toBeInTheDocument()
    expect(screen.getByLabelText("Light mode favicon upload")).toBeInTheDocument()
    expect(screen.getByLabelText("Dark mode favicon upload")).toBeInTheDocument()
    expect(screen.getByRole("switch", { name: "Circular Logo" })).toBeInTheDocument()
    expect(
      screen.getByRole("switch", { name: "Circular Favicon" }),
    ).toBeInTheDocument()
  })

  it("updates the visible logo text and keeps the internal portal name aligned", () => {
    const onLayoutChange = vi.fn()
    render(
      <PortalThemeControls layout={layout()} onLayoutChange={onLayoutChange} />,
    )

    const input = screen.getByLabelText("Logo Text")
    fireEvent.change(input, { target: { value: "" } })

    expect(input).toHaveValue("")
    expect(onLayoutChange).not.toHaveBeenCalled()

    fireEvent.change(input, { target: { value: "Beta" } })
    fireEvent.blur(input)

    expect(onLayoutChange).toHaveBeenCalledTimes(1)
    expect(onLayoutChange.mock.calls[0]?.[0].theme.brandName).toBe("Beta")
    expect(onLayoutChange.mock.calls[0]?.[0].theme.logoText).toBe("Beta")
  })

  it("allows empty logo text to hide the copy without clearing the portal name", () => {
    const onLayoutChange = vi.fn()
    render(
      <PortalThemeControls layout={layout()} onLayoutChange={onLayoutChange} />,
    )

    const input = screen.getByLabelText("Logo Text")
    fireEvent.change(input, { target: { value: "" } })
    fireEvent.blur(input)

    expect(onLayoutChange).toHaveBeenCalledTimes(1)
    expect(onLayoutChange.mock.calls[0]?.[0].theme.logoText).toBe("")
    expect(onLayoutChange.mock.calls[0]?.[0].theme.brandName).toBe("Acme")
  })

  it("persists the circular logo option", () => {
    const onLayoutChange = vi.fn()
    render(
      <PortalThemeControls layout={layout()} onLayoutChange={onLayoutChange} />,
    )

    fireEvent.click(screen.getByRole("switch", { name: "Circular Logo" }))

    expect(onLayoutChange).toHaveBeenCalledTimes(1)
    expect(onLayoutChange.mock.calls[0]?.[0].theme.circularLogo).toBe(true)
  })

  it("uses the workspace logo as the default rounded favicon and can make it circular", () => {
    const onLayoutChange = vi.fn()
    render(
      <PortalThemeControls
        layout={layout()}
        onLayoutChange={onLayoutChange}
        workspaceLogoUrl="/workspace-logo.svg"
      />,
    )

    const faviconDropzone = screen.getByRole("button", {
      name: "Light mode favicon. Click to upload.",
    })
    const inheritedFavicon = faviconDropzone.querySelector(
      'img[src="/workspace-logo.svg"]',
    )
    expect(inheritedFavicon?.parentElement).toHaveClass("rounded-xl")

    fireEvent.click(screen.getByRole("switch", { name: "Circular Favicon" }))

    expect(onLayoutChange).toHaveBeenCalledTimes(1)
    expect(onLayoutChange.mock.calls[0]?.[0].theme.faviconShape).toBe("circle")
  })

  it("previews the light favicon for dark mode until a dark one is set, then removes only the dark one", () => {
    const onLayoutChange = vi.fn()
    const base = layout()
    base.theme.faviconUrl = "/favicon-light.png"
    const { rerender } = render(
      <PortalThemeControls layout={base} onLayoutChange={onLayoutChange} />,
    )
    const darkDropzone = () =>
      screen.getByRole("button", { name: "Dark mode favicon. Click to upload." })

    expect(darkDropzone().querySelector('img[src="/favicon-light.png"]')).not.toBeNull()
    expect(within(darkDropzone()).queryByRole("button", { name: "Remove" })).toBeNull()

    const withDark = layout()
    withDark.theme.faviconUrl = "/favicon-light.png"
    withDark.theme.darkFaviconUrl = "/favicon-dark.png"
    rerender(
      <PortalThemeControls layout={withDark} onLayoutChange={onLayoutChange} />,
    )

    expect(darkDropzone().querySelector('img[src="/favicon-dark.png"]')).not.toBeNull()
    fireEvent.click(within(darkDropzone()).getByRole("button", { name: "Remove" }))

    expect(onLayoutChange).toHaveBeenCalledTimes(1)
    const next = onLayoutChange.mock.calls[0]?.[0].theme
    expect(next.darkFaviconUrl).toBe("")
    expect(next.faviconUrl).toBe("/favicon-light.png")
  })
})
