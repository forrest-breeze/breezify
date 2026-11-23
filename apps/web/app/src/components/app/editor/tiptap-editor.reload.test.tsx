// @vitest-environment happy-dom

import { cleanup, render, waitFor } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { TiptapEditor } from "./tiptap-editor"

vi.mock("mermaid", () => ({
  default: {
    initialize: vi.fn(),
    render: vi.fn().mockResolvedValue({ svg: "<svg></svg>" }),
  },
}))

afterEach(cleanup)

/** The HTML the editor holds once it has loaded `content`. */
async function loaded(content: string): Promise<string> {
  const onCreate = vi.fn<(html: string) => void>()
  render(<TiptapEditor content={content} onCreate={onCreate} />)
  await waitFor(() => expect(onCreate).toHaveBeenCalled())
  const html = onCreate.mock.calls[0]![0]
  cleanup()
  return html
}

// A page is Markdown when it is imported and HTML once the editor has saved
// it. Opening the saved page must give back the page that was saved: the
// editor once read its own HTML as Markdown, which ended at the first blank
// line inside a code sample or a diagram and mangled everything after it.
describe("TiptapEditor reopening a saved page", () => {
  const PAGE = [
    "Intro with 2 * 3 * 4, a snake_case_name and [brackets](not-a-link-in-html).",
    "",
    "```typescript",
    'import { PaymentPage } from "@example/ui";',
    "",
    "return <PaymentPage url={paymentPageUrl} />;",
    "```",
    "",
    "```json",
    "{",
    '  "address": {',
    '    "city": "New York"',
    "  }",
    "}",
    "```",
    "",
    "```mermaid",
    "sequenceDiagram",
    "    participant Merchant",
    "",
    "    Merchant->>Breeze: Request payout",
    "```",
    "",
    "- one",
    "- two",
    "",
    "Last paragraph.",
  ].join("\n")

  it("holds the same document after a save and reload", async () => {
    const saved = await loaded(PAGE)
    // What a save stores, and the next visit loads.
    const reopened = await loaded(saved)
    expect(reopened).toBe(saved)
    // And again: reopening is not a slow drift either.
    expect(await loaded(reopened)).toBe(saved)
  })

  it("keeps code samples whole, with their blank lines and indentation", async () => {
    const reopened = await loaded(await loaded(PAGE))
    const container = document.createElement("div")
    container.innerHTML = reopened
    // Code samples, and a diagram's source wherever the editor keeps it.
    const sources = [
      ...[...container.querySelectorAll("pre")]
        // The diagram also carries a plain-text fallback of its source.
        .filter((pre) => !pre.closest("[data-source]"))
        .map((pre) => pre.textContent),
      ...[...container.querySelectorAll("[data-source]")].map((node) =>
        node.getAttribute("data-source"),
      ),
    ]
    expect(sources).toEqual([
      'import { PaymentPage } from "@example/ui";\n\nreturn <PaymentPage url={paymentPageUrl} />;',
      '{\n  "address": {\n    "city": "New York"\n  }\n}',
      // Blank line and arrows included.
      "sequenceDiagram\n    participant Merchant\n\n    Merchant->>Breeze: Request payout",
    ])
  })

  it("does not read saved text as Markdown", async () => {
    const saved = "<img src=\"https://example.com/a.png\" alt=\"a\"><p>2 * 3 * 4 and [not a link](x) and # not a heading</p>"
    const reopened = await loaded(saved)
    expect(reopened).toContain("<p>2 * 3 * 4 and [not a link](x) and # not a heading</p>")
    expect(reopened).not.toContain("<a ")
  })

  it("still reads an imported Markdown page as Markdown", async () => {
    const html = await loaded("## Title\n\n* one\n* two\n\nSee [the guide](https://example.com).")
    expect(html).toContain("<h2")
    expect(html).toContain("<ul")
    expect(html).toContain("<li><p>one</p></li>")
    expect(html).toContain('href="https://example.com"')
  })
})
