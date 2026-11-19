// @vitest-environment jsdom

import { act, fireEvent, render, screen } from "@testing-library/react"
import { beforeAll, describe, expect, it, vi } from "vitest"
import { PortalLivePreview, portalDocRefFromHref } from "./portal-live-preview"

vi.mock("./preview-mesh-background", () => ({
  PreviewMeshBackground: () => null,
}))

let notifyResize: () => void

beforeAll(() => {
  class ResizeObserverMock {
    constructor(callback: () => void) {
      notifyResize = callback
    }
    observe(): void {}
    disconnect(): void {}
    unobserve(): void {}
  }

  globalThis.ResizeObserver =
    ResizeObserverMock as unknown as typeof ResizeObserver
})

const baseProps = {
  previewSlug: "docs",
  projectSlug: null,
  pageSlug: null,
  surface: "default" as const,
  appearance: "light" as const,
  device: "desktop" as const,
  reloadKey: 0,
  dirty: false,
  onAppearanceChange: vi.fn(),
  onDeviceChange: vi.fn(),
}

describe("portalDocRefFromHref", () => {
  const origin = "http://localhost:3000"

  it("reads the doc ref from same-origin portal doc links", () => {
    expect(portalDocRefFromHref("/p/acme/doc/install", origin)).toBe("install")
    expect(portalDocRefFromHref("/p/acme/docs/doc/get-started/", origin)).toBe(
      "get-started",
    )
  })

  it("ignores page, folder and off-site links", () => {
    expect(portalDocRefFromHref("/p/acme/folder/guides", origin)).toBeNull()
    expect(portalDocRefFromHref("/portal-preview?page=api", origin)).toBeNull()
    expect(
      portalDocRefFromHref("https://example.com/doc/install", origin),
    ).toBeNull()
  })
})

describe("PortalLivePreview", () => {
  it.each([
    // Mobile reserves 2 × 10px for the phone bezel around the screen.
    ["mobile", 430, 844, 20],
    ["desktop", 1440, 900, 0],
  ] as const)("keeps the %s viewport when the preview panel resizes", (device, width, height, bezel) => {
    const panelWidth = vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(300)
    const panelHeight = vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(400)
    try {
      render(<PortalLivePreview {...baseProps} device={device} />)
      const iframe = screen.getByTitle("Portal preview")
      expect(iframe).toHaveStyle({ width: `${width}px`, height: `${height}px` })
      const scale = Math.min((300 - bezel) / width, (400 - bezel) / height)
      expect(iframe).toHaveStyle({ transform: `scale(${scale})` })
      expect(iframe.parentElement).toHaveStyle({
        width: `${Math.round(width * scale)}px`,
        height: `${Math.round(height * scale)}px`,
      })

      panelWidth.mockReturnValue(1800)
      panelHeight.mockReturnValue(1200)
      act(() => notifyResize())

      expect(screen.getByTitle("Portal preview")).toBe(iframe)
      expect(iframe).toHaveStyle({ width: `${width}px`, height: `${height}px`, transform: "scale(1)" })
      expect(iframe.parentElement).toHaveStyle({ width: `${width}px`, height: `${height}px` })
    } finally {
      panelWidth.mockRestore()
      panelHeight.mockRestore()
    }
  })

  it("lays the desktop preview out at the browser window's viewport, like the published portal", () => {
    const panelWidth = vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(960)
    const panelHeight = vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(800)
    const { innerWidth, innerHeight } = window
    const resizeWindow = (width: number, height: number): void => {
      act(() => {
        Object.assign(window, { innerWidth: width, innerHeight: height })
        window.dispatchEvent(new Event("resize"))
      })
    }
    try {
      render(<PortalLivePreview {...baseProps} />)
      const iframe = screen.getByTitle("Portal preview")

      // A wide window crosses breakpoints a fixed 1440px frame never reached.
      resizeWindow(1920, 1080)
      expect(screen.getByTitle("Portal preview")).toBe(iframe)
      expect(iframe).toHaveStyle({
        width: "1920px",
        height: "1080px",
        transform: "scale(0.5)",
      })
      expect(iframe.parentElement).toHaveStyle({ width: "960px", height: "540px" })

      // A small window still previews a standard desktop, not a tablet layout.
      resizeWindow(1100, 700)
      expect(iframe).toHaveStyle({ width: "1440px", height: "900px" })
    } finally {
      resizeWindow(innerWidth, innerHeight)
      panelWidth.mockRestore()
      panelHeight.mockRestore()
    }
  })

  it("keeps the mobile viewport fixed whatever the browser window's size", () => {
    const { innerWidth, innerHeight } = window
    try {
      act(() => {
        Object.assign(window, { innerWidth: 1920, innerHeight: 1080 })
        window.dispatchEvent(new Event("resize"))
      })
      render(<PortalLivePreview {...baseProps} device="mobile" />)
      expect(screen.getByTitle("Portal preview")).toHaveStyle({
        width: "430px",
        height: "844px",
      })
    } finally {
      act(() => {
        Object.assign(window, { innerWidth, innerHeight })
        window.dispatchEvent(new Event("resize"))
      })
    }
  })

  it("keeps plain doc links in the draft preview instead of opening the editor", () => {
    const onOpenDocument = vi.fn()
    render(<PortalLivePreview {...baseProps} onOpenDocument={onOpenDocument} />)
    const frame = screen.getByTitle("Portal preview") as HTMLIFrameElement
    const frameDocument = frame.contentDocument!
    const html = frameDocument.createElement("html")
    html.innerHTML =
      '<body><a href="/p/docs/doc/install"><span>Install</span></a><a href="/p/docs/folder/x">Folder</a></body>'
    frameDocument.replaceChildren(html)
    fireEvent.load(frame)

    const docClick = new MouseEvent("click", { bubbles: true, cancelable: true })
    frameDocument.querySelector("span")!.dispatchEvent(docClick)
    // Navigates the frame to /portal-preview?…&doc=install (not the public
    // /p/... href) and leaves edit mode to the explicit Edit control.
    expect(docClick.defaultPrevented).toBe(true)
    expect(onOpenDocument).not.toHaveBeenCalled()

    const folderClick = new MouseEvent("click", { bubbles: true, cancelable: true })
    frameDocument.querySelectorAll("a")[1]!.dispatchEvent(folderClick)
    expect(onOpenDocument).not.toHaveBeenCalled()
    expect(folderClick.defaultPrevented).toBe(false)
  })

  it("opens API reference endpoints including the root endpoint in the shared editor", () => {
    const onOpenDocument = vi.fn()
    render(<PortalLivePreview {...baseProps} onOpenDocument={onOpenDocument} />)
    const frame = screen.getByTitle("Portal preview") as HTMLIFrameElement
    const frameDocument = frame.contentDocument!
    const html = frameDocument.createElement("html")
    html.innerHTML = '<body><a href="/portal-preview?page=api" data-portal-document-ref="first-id">Edit document</a><a href="/portal-preview?page=api&doc=create" data-portal-document-ref="create-id">Create</a></body>'
    frameDocument.replaceChildren(html)
    fireEvent.load(frame)
    for (const link of frameDocument.querySelectorAll("a")) {
      const event = new MouseEvent("click", { bubbles: true, cancelable: true })
      link.dispatchEvent(event)
      expect(event.defaultPrevented).toBe(true)
    }
    expect(onOpenDocument.mock.calls).toEqual([["first-id"], ["create-id"]])
  })

  it("uses a rail-less release-feed skeleton for changelog surfaces", () => {
    render(<PortalLivePreview {...baseProps} surface="changelog" />)

    const skeleton = screen.getByRole("status", {
      name: "Loading changelog preview",
    })
    expect(skeleton).toHaveAttribute("data-preview-surface", "changelog")
    expect(skeleton.querySelector("aside")).not.toBeInTheDocument()
    expect(skeleton.querySelectorAll("main > div > div > div")).toHaveLength(4)
  })

  it("shows a skeleton for the first load only, then reloads behind the previous render", () => {
    const { rerender } = render(<PortalLivePreview {...baseProps} />)

    expect(
      screen.getByRole("status", { name: "Loading portal preview" }),
    ).toBeInTheDocument()

    fireEvent.load(screen.getByTitle("Portal preview"))

    expect(
      screen.queryByRole("status", { name: "Loading portal preview" }),
    ).not.toBeInTheDocument()

    const frame = screen.getByTitle("Portal preview")
    rerender(<PortalLivePreview {...baseProps} reloadKey={1} />)

    // Same frame element, new src: the previous render stays on screen (no
    // skeleton over the header and nav rail), with a progress bar instead.
    expect(screen.getByTitle("Portal preview")).toBe(frame)
    expect(frame.getAttribute("src")).toContain("v=1")
    expect(
      screen.queryByRole("status", { name: "Loading portal preview" }),
    ).not.toBeInTheDocument()
    expect(
      screen.getByRole("progressbar", { name: "Updating portal preview" }),
    ).toBeInTheDocument()

    fireEvent.load(frame)
    expect(
      screen.queryByRole("progressbar", { name: "Updating portal preview" }),
    ).not.toBeInTheDocument()
  })

  it("shows the skeleton again when the device changes", () => {
    const { rerender } = render(<PortalLivePreview {...baseProps} />)
    fireEvent.load(screen.getByTitle("Portal preview"))

    rerender(<PortalLivePreview {...baseProps} device="mobile" />)

    expect(
      screen.getByRole("status", { name: "Loading portal preview" }),
    ).toBeInTheDocument()
  })

  it("reports in-frame page navigation without reloading the frame", () => {
    const onPageChange = vi.fn()
    const { rerender } = render(
      <PortalLivePreview {...baseProps} onPageChange={onPageChange} />,
    )

    const iframe = screen.getByTitle("Portal preview") as HTMLIFrameElement
    fireEvent.load(iframe)
    const initialSrc = iframe.getAttribute("src")

    window.dispatchEvent(
      new MessageEvent("message", {
        data: { type: "breezify:portal-preview-page", page: "guides" },
        origin: window.location.origin,
        source: iframe.contentWindow,
      }),
    )

    expect(onPageChange).toHaveBeenCalledWith("guides")

    // The editor mirrors the reported page back down; the frame already shows it.
    rerender(
      <PortalLivePreview
        {...baseProps}
        pageSlug="guides"
        onPageChange={onPageChange}
      />,
    )

    expect(
      screen.queryByRole("status", { name: "Loading portal preview" }),
    ).not.toBeInTheDocument()
    expect(screen.getByTitle("Portal preview")).toHaveAttribute(
      "src",
      initialSrc ?? "",
    )
  })

  it("shows a document requested from the editor read-only once the editor closes", () => {
    const request = { ref: "install", page: null, key: 1 }
    const editor = <p>Editor</p>
    const { rerender } = render(
      <PortalLivePreview {...baseProps} content={editor} />,
    )
    expect(screen.queryByTitle("Portal preview")).not.toBeInTheDocument()

    rerender(
      <PortalLivePreview {...baseProps} content={editor} documentRequest={request} />,
    )
    rerender(<PortalLivePreview {...baseProps} documentRequest={request} />)

    const iframe = screen.getByTitle("Portal preview")
    expect(iframe.getAttribute("src")).toContain("doc=install")

    // Once it has loaded, later reloads return to the page's default doc…
    fireEvent.load(iframe)
    rerender(
      <PortalLivePreview {...baseProps} reloadKey={1} documentRequest={request} />,
    )
    expect(screen.getByTitle("Portal preview").getAttribute("src")).not.toContain(
      "doc=",
    )

    // …and so does closing a later editor that made no request.
    rerender(
      <PortalLivePreview
        {...baseProps}
        reloadKey={1}
        content={editor}
        documentRequest={request}
      />,
    )
    rerender(
      <PortalLivePreview {...baseProps} reloadKey={1} documentRequest={request} />,
    )
    expect(screen.getByTitle("Portal preview").getAttribute("src")).not.toContain(
      "doc=",
    )
  })

  it("keeps a requested document on its page while the host's page catches up", () => {
    const request = { ref: "auth", page: "api", key: 1 }
    const editor = <p>Editor</p>
    const { rerender } = render(
      <PortalLivePreview {...baseProps} content={editor} />,
    )
    rerender(
      <PortalLivePreview {...baseProps} content={editor} documentRequest={request} />,
    )
    rerender(
      <PortalLivePreview {...baseProps} pageSlug="api" documentRequest={request} />,
    )

    const src = screen.getByTitle("Portal preview").getAttribute("src")
    expect(src).toContain("page=api")
    expect(src).toContain("doc=auth")
  })

  it("reloads the frame when the editor switches page", () => {
    const { rerender } = render(<PortalLivePreview {...baseProps} />)

    fireEvent.load(screen.getByTitle("Portal preview"))
    rerender(<PortalLivePreview {...baseProps} pageSlug="guides" />)

    expect(
      screen.getByRole("progressbar", { name: "Updating portal preview" }),
    ).toBeInTheDocument()
    expect(screen.getByTitle("Portal preview").getAttribute("src")).toContain(
      "page=guides",
    )
  })
})
