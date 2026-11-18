// @vitest-environment happy-dom
import { describe, expect, it } from "vitest"
import { renderDocumentHtml } from "@/lib/render-document-html"
import { parseFormula } from "@/lib/document-tabs"
import { documentHtmlToMarkdown } from "@/lib/document-export"
import { sanitizeElementTree } from "@/lib/sanitize-dom"

const parse = (html: string) => {
  const root = document.createElement("div")
  root.innerHTML = html
  return root
}

/** Render → sanitize → back to Markdown → render again must be stable. */
function roundTrip(markdown: string): { first: string; markdown: string; second: string } {
  const first = sanitizeElementTree(parse(renderDocumentHtml(markdown)))
  const back = documentHtmlToMarkdown(first)
  const second = sanitizeElementTree(parse(renderDocumentHtml(back)))
  return { first, markdown: back, second }
}

const balances = [
  "{% cards %}",
  '{% card title="Holds everything your users pay you" eyebrow="Balance #1 · Settlement Balance" tone="green" %}',
  "Money your users have paid, minus **refunds** and fees.",
  "{% endcard %}",
  '{% card title="Funds instant withdrawals for your users" eyebrow="Balance #2 · Payout Wallet" tone="blue" %}',
  "Funds your users' withdrawals.",
  "{% endcard %}",
  "{% endcards %}",
].join("\n")

const steps = [
  "{% steps %}",
  '{% step title="Settlement day arrives" note="Funds from Mon settled by Thu (T+3)" %}',
  "Breeze evaluates your total Settlement Balance.",
  "{% endstep %}",
  '{% step title="Merchant settlement" %}',
  "The remaining balance is deposited to your bank.",
  "{% endstep %}",
  "{% endsteps %}",
].join("\n")

const timeline = [
  "{% timeline %}",
  '{% phase label="Week 1–2" title="All payin to Payout Wallet" transition="Minimum Balance set by Breeze · after ~2 weeks" %}',
  "No merchant settlements are made during this period.",
  "{% endphase %}",
  '{% phase label="Week 2+" title="Standard settlement begins" %}',
  "Regular T+3 daily settlements start.",
  "{% endphase %}",
  "{% endtimeline %}",
].join("\n")

const formula = "{% formula %}Avg daily payouts | 21-day rolling average × 3 | days coverage = Minimum Balance{% endformula %}"

describe("card eyebrow and tone", () => {
  it("renders eyebrow text and a known tone, and drops unknown tones", () => {
    const root = parse(renderDocumentHtml(balances))
    const cards = root.querySelectorAll("[data-document-card]")
    expect(cards).toHaveLength(2)
    expect(cards[0].getAttribute("data-card-tone")).toBe("green")
    expect(cards[0].querySelector("[data-card-eyebrow-text]")?.textContent).toBe("Balance #1 · Settlement Balance")
    const bad = parse(renderDocumentHtml('{% cards %}\n{% card title="x" tone="hotpink" %}\nx\n{% endcard %}\n{% endcards %}'))
    expect(bad.querySelector("[data-card-tone]")).toBeNull()
  })

  it("round-trips through Markdown", () => {
    const { first, second, markdown } = roundTrip(balances)
    expect(markdown).toContain('eyebrow="Balance #1 · Settlement Balance" tone="green"')
    expect(second).toBe(first)
  })
})

describe("steps", () => {
  it("renders numbered steps with notes", () => {
    const root = parse(renderDocumentHtml(steps))
    const items = root.querySelectorAll("[data-document-steps] > [data-document-step]")
    expect(items).toHaveLength(2)
    expect(items[0].querySelector("[data-step-title]")?.textContent).toBe("Settlement day arrives")
    expect(items[0].querySelector("[data-step-note-text]")?.textContent).toBe("Funds from Mon settled by Thu (T+3)")
    expect(items[1].querySelector("[data-step-note-text]")).toBeNull()
  })

  it("round-trips through Markdown", () => {
    const { first, second } = roundTrip(steps)
    expect(second).toBe(first)
  })
})

describe("timeline", () => {
  it("renders phases with labels and transitions", () => {
    const root = parse(renderDocumentHtml(timeline))
    const phases = root.querySelectorAll("[data-document-timeline] > [data-document-phase]")
    expect(phases).toHaveLength(2)
    expect(phases[0].querySelector("[data-phase-label-text]")?.textContent).toBe("Week 1–2")
    expect(phases[0].querySelector("[data-phase-transition-text]")?.textContent).toContain("~2 weeks")
  })

  it("round-trips through Markdown", () => {
    const { first, second } = roundTrip(timeline)
    expect(second).toBe(first)
  })
})

describe("formula", () => {
  it("parses terms, captions, operators and the result", () => {
    expect(parseFormula("Avg daily payouts | 21-day rolling average × 3 | days coverage = Minimum Balance")).toEqual([
      { kind: "term", label: "Avg daily payouts", caption: "21-day rolling average", result: false },
      { kind: "op", symbol: "×" },
      { kind: "term", label: "3", caption: "days coverage", result: false },
      { kind: "op", symbol: "=" },
      { kind: "term", label: "Minimum Balance", caption: "", result: true },
    ])
  })

  it("renders inline and multi-line forms, but not inside code fences", () => {
    for (const source of [formula, formula.replace("%}A", "%}\nA").replace("Balance{%", "Balance\n{%")]) {
      const root = parse(renderDocumentHtml(source))
      expect(root.querySelectorAll("[data-formula-term]")).toHaveLength(3)
      expect(root.querySelector("[data-formula-result]")?.textContent).toBe("Minimum Balance")
    }
    const fenced = parse(renderDocumentHtml("```\n" + formula + "\n```"))
    expect(fenced.querySelector("[data-document-formula]")).toBeNull()
  })

  it("round-trips through Markdown", () => {
    const { first, second, markdown } = roundTrip(formula)
    expect(markdown).toBe(formula)
    expect(second).toBe(first)
  })
})

describe("editor directive detection", async () => {
  const { DIRECTIVE_SOURCE, RENDERED_DIRECTIVE } = await import("@/lib/document-tabs")
  it.each([balances, steps, timeline, formula])("recognizes every block type as directive source", (source) => {
    expect(DIRECTIVE_SOURCE.test(source)).toBe(true)
    expect(RENDERED_DIRECTIVE.test(renderDocumentHtml(source))).toBe(true)
  })
  it("rebuilds pasted-as-paragraph blocks when stored HTML is rendered", () => {
    for (const source of [steps, timeline, formula]) {
      const flattened = `<p>${source.replace(/\n/g, " ")}</p>`
      expect(RENDERED_DIRECTIVE.test(renderDocumentHtml(flattened))).toBe(true)
    }
  })
})
