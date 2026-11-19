// @vitest-environment happy-dom

import { cleanup, render, screen } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const harness = vi.hoisted(() => ({
  pathname: "/knowledge/doc-1",
  routeRoot: "",
}))

vi.mock("next/navigation", () => ({
  usePathname: () => harness.pathname,
}))

vi.mock("@/components/app/documents-sub-nav", () => ({
  DocumentsSubNav: ({ routeRoot }: { routeRoot: string }) => {
    harness.routeRoot = routeRoot
    return <div>Document tree</div>
  },
}))

import { KnowledgeSubNav } from "./knowledge-sub-nav"

beforeEach(() => {
  harness.pathname = "/knowledge/doc-1"
  harness.routeRoot = ""
})

afterEach(cleanup)

describe("KnowledgeSubNav", () => {
  it("renders the document tree with no view tabs", () => {
    render(<KnowledgeSubNav />)

    expect(screen.getByText("Document tree")).toBeInTheDocument()
    expect(screen.queryByRole("tablist")).not.toBeInTheDocument()
    expect(screen.queryByRole("tab")).not.toBeInTheDocument()
  })

  it("keeps the tree on the surface it was opened from", () => {
    const view = render(<KnowledgeSubNav />)
    expect(harness.routeRoot).toBe("knowledge")

    harness.pathname = "/editor/doc-1"
    view.rerender(<KnowledgeSubNav />)
    expect(harness.routeRoot).toBe("editor")
  })

  it("renders the tree header above the tree", () => {
    render(<KnowledgeSubNav treeHeader={<button type="button">Pages</button>} />)

    const header = screen.getByRole("button", { name: "Pages" })
    const tree = screen.getByText("Document tree")
    expect(
      header.compareDocumentPosition(tree) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy()
  })
})
