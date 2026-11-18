// @vitest-environment jsdom
import MarkdownIt from "markdown-it"
import { describe, expect, it } from "vitest"
import { enhanceCallouts } from "@/lib/document-callouts"

const md = new MarkdownIt({ breaks: true, html: false, linkify: true })

function render(markdown: string): HTMLElement {
  const body = new DOMParser().parseFromString(md.render(markdown), "text/html").body
  enhanceCallouts(body)
  return body
}

describe("enhanceCallouts", () => {
  it.each([
    ["📘", "info"],
    ["👍", "success"],
    ["🚧", "warn"],
    ["❗️", "danger"],
  ])("tags %s blockquotes as %s callouts", (icon, tone) => {
    const quote = render(`> ${icon} Title\n>\n> Body text.`).querySelector("blockquote")!
    expect(quote.getAttribute("data-callout")).toBe(tone)
    expect(quote.getAttribute("data-callout-icon")).toBe(icon)
    expect(quote.querySelector("[data-callout-title]")?.textContent).toBe("Title")
  })

  it("strips a heading marker from the title", () => {
    const quote = render("> 🚧 ### Top-up takes priority\n>\n> If Settlement Balance is not enough.").querySelector("blockquote")!
    expect(quote.querySelector("[data-callout-title]")?.textContent).toBe("Top-up takes priority")
    expect(quote.textContent).not.toContain("#")
    expect(quote.querySelectorAll("p")).toHaveLength(2)
  })

  it("splits a title and body joined by a soft break", () => {
    const quote = render("> 👍 Protected\n> Withdrawals always work.").querySelector("blockquote")!
    expect(quote.querySelector("[data-callout-title]")?.textContent).toBe("Protected")
    expect(quote.querySelectorAll("p")[1]?.textContent).toBe("Withdrawals always work.")
  })

  it("keeps a single-line callout as body text", () => {
    const quote = render("> 💡 Just a tip.").querySelector("blockquote")!
    expect(quote.getAttribute("data-callout")).toBe("info")
    expect(quote.querySelector("[data-callout-title]")).toBeNull()
    expect(quote.textContent?.trim()).toBe("Just a tip.")
  })

  it("leaves ordinary quotes alone", () => {
    const quote = render("> Plain quote.").querySelector("blockquote")!
    expect(quote.hasAttribute("data-callout")).toBe(false)
  })
})
