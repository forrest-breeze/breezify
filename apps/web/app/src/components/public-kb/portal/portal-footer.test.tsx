// @vitest-environment happy-dom

import { render, screen } from "@testing-library/react"
import { describe, expect, it } from "vitest"
import { portalLayoutSchema, type FooterBlock } from "@/lib/portal/schema"
import { PortalFooter } from "./portal-footer"

function footer(patch: Partial<FooterBlock> = {}): FooterBlock {
  return { id: "footer", type: "footer", showPoweredBy: false, ...patch }
}

describe("PortalFooter Powered by Breeze credit", () => {
  it("renders nothing when the credit is off and the footer has no content", () => {
    const { container } = render(
      <PortalFooter footer={footer()} allowPoweredByRemoval />,
    )
    expect(container).toBeEmptyDOMElement()
  })

  it("leaves the credit out of a footer that has content", () => {
    render(<PortalFooter footer={footer({ note: "© Acme" })} allowPoweredByRemoval />)
    expect(screen.getByText("© Acme")).toBeInTheDocument()
    expect(screen.queryByText("Powered by")).toBeNull()
  })

  it("shows the credit once it is turned on", () => {
    render(
      <PortalFooter footer={footer({ showPoweredBy: true })} allowPoweredByRemoval />,
    )
    expect(screen.getByText("Powered by")).toBeInTheDocument()
  })

  it("always shows the credit when the plan cannot remove branding", () => {
    render(<PortalFooter footer={footer()} allowPoweredByRemoval={false} />)
    expect(screen.getByText("Powered by")).toBeInTheDocument()
  })

  it("defaults a footer saved without a choice to credit off", () => {
    const parsed = portalLayoutSchema.shape.footer.parse({ id: "footer", type: "footer" })
    expect(parsed?.showPoweredBy).toBe(false)
  })
})
