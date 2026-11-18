import { Node } from "@tiptap/core"
import { cardIcon, cardTone, isSafeCardHref, parseFormula } from "@/lib/document-tabs"

// Keep imported tab groups intact while their contents remain editable.
// The reader adds the interactive tab bar; the editor shows every section.
export const DocumentTabs = Node.create({
  name: "documentTabs",
  group: "block",
  content: "documentTab+",
  defining: true,
  parseHTML: () => [{ tag: "div[data-document-tabs]" }],
  renderHTML: () => ["div", { "data-document-tabs": "" }, 0],
})

export const DocumentTab = Node.create({
  name: "documentTab",
  content: "block+",
  defining: true,
  draggable: true,
  addAttributes() {
    return {
      title: {
        default: "Section",
        parseHTML: (element) => element.getAttribute("data-document-tab"),
        renderHTML: (attributes) => ({ "data-document-tab": attributes.title }),
      },
    }
  },
  parseHTML: () => [{ tag: "section[data-document-tab]" }],
  renderHTML: ({ HTMLAttributes }) => ["section", HTMLAttributes, 0],
})

// Card groups keep their title and link as attributes; the body stays editable.
// The rendered title link is regenerated from attributes, never parsed as content.
export const DocumentCards = Node.create({
  name: "documentCards",
  group: "block",
  content: "documentCard+",
  defining: true,
  parseHTML: () => [{ tag: "div[data-document-cards]" }],
  renderHTML: () => ["div", { "data-document-cards": "" }, 0],
})

export const DocumentCard = Node.create({
  name: "documentCard",
  content: "block+",
  defining: true,
  draggable: true,
  addAttributes() {
    return {
      title: {
        default: "Card",
        parseHTML: (element) => element.getAttribute("data-document-card"),
        renderHTML: (attributes) => ({ "data-document-card": attributes.title }),
      },
      href: {
        default: null,
        parseHTML: (element) => {
          const href = element.getAttribute("data-card-href")
          return href && isSafeCardHref(href) ? href.trim() : null
        },
        renderHTML: (attributes) => (attributes.href ? { "data-card-href": attributes.href } : {}),
      },
      icon: {
        default: null,
        parseHTML: (element) => cardIcon(element.getAttribute("data-card-icon")),
        renderHTML: (attributes) => {
          const icon = cardIcon(attributes.icon)
          return icon ? { "data-card-icon": icon } : {}
        },
      },
      eyebrow: {
        default: null,
        parseHTML: (element) => element.getAttribute("data-card-eyebrow") || null,
        renderHTML: (attributes) => (attributes.eyebrow ? { "data-card-eyebrow": attributes.eyebrow } : {}),
      },
      tone: {
        default: null,
        parseHTML: (element) => cardTone(element.getAttribute("data-card-tone")),
        renderHTML: (attributes) => {
          const tone = cardTone(attributes.tone)
          return tone ? { "data-card-tone": tone } : {}
        },
      },
    }
  },
  parseHTML: () => [{ tag: "section[data-document-card]", contentElement: "[data-card-body]" }],
  renderHTML: ({ node, HTMLAttributes }) => {
    const title: string = node.attrs.title
    const href: string | null = node.attrs.href && isSafeCardHref(node.attrs.href) ? node.attrs.href : null
    const icon = cardIcon(node.attrs.icon)
    const eyebrow: string | null = node.attrs.eyebrow || null
    return [
      "section",
      HTMLAttributes,
      ...(icon ? [["span", { "data-card-glyph": "", "aria-hidden": "true", contenteditable: "false" }, icon]] : []),
      ...(eyebrow ? [["p", { "data-card-eyebrow-text": "", contenteditable: "false" }, eyebrow]] : []),
      ["p", { "data-card-title": "", contenteditable: "false" }, href ? ["a", { href }, title] : title],
      ["div", { "data-card-body": "" }, 0],
    ]
  },
})

function dataAttribute(attribute: string, key: string) {
  return {
    default: null,
    parseHTML: (element: HTMLElement) => element.getAttribute(attribute) || null,
    renderHTML: (attributes: Record<string, string | null>) => (attributes[key] ? { [attribute]: attributes[key] } : {}),
  }
}

// Numbered steps: title and note are attributes, the body is editable.
export const DocumentSteps = Node.create({
  name: "documentSteps",
  group: "block",
  content: "documentStep+",
  defining: true,
  parseHTML: () => [{ tag: "div[data-document-steps]" }],
  renderHTML: () => ["div", { "data-document-steps": "" }, 0],
})

export const DocumentStep = Node.create({
  name: "documentStep",
  content: "block+",
  defining: true,
  draggable: true,
  addAttributes() {
    return {
      title: {
        default: "Step",
        parseHTML: (element) => element.getAttribute("data-document-step"),
        renderHTML: (attributes) => ({ "data-document-step": attributes.title }),
      },
      note: dataAttribute("data-step-note", "note"),
    }
  },
  parseHTML: () => [{ tag: "section[data-document-step]", contentElement: "[data-step-body]" }],
  renderHTML: ({ node, HTMLAttributes }) => [
    "section",
    HTMLAttributes,
    ["p", { "data-step-title": "", contenteditable: "false" }, node.attrs.title],
    ["div", { "data-step-body": "" }, 0],
    ...(node.attrs.note ? [["p", { "data-step-note-text": "", contenteditable: "false" }, node.attrs.note]] : []),
  ],
})

// Timeline phases: label, title and transition are attributes.
export const DocumentTimeline = Node.create({
  name: "documentTimeline",
  group: "block",
  content: "documentPhase+",
  defining: true,
  parseHTML: () => [{ tag: "div[data-document-timeline]" }],
  renderHTML: () => ["div", { "data-document-timeline": "" }, 0],
})

export const DocumentPhase = Node.create({
  name: "documentPhase",
  content: "block+",
  defining: true,
  draggable: true,
  addAttributes() {
    return {
      title: {
        default: "Phase",
        parseHTML: (element) => element.getAttribute("data-document-phase"),
        renderHTML: (attributes) => ({ "data-document-phase": attributes.title }),
      },
      label: dataAttribute("data-phase-label", "label"),
      transition: dataAttribute("data-phase-transition", "transition"),
    }
  },
  parseHTML: () => [{ tag: "section[data-document-phase]", contentElement: "[data-phase-body]" }],
  renderHTML: ({ node, HTMLAttributes }) => [
    "section",
    HTMLAttributes,
    ...(node.attrs.label ? [["p", { "data-phase-label-text": "", contenteditable: "false" }, node.attrs.label]] : []),
    ["p", { "data-phase-title": "", contenteditable: "false" }, node.attrs.title],
    ["div", { "data-phase-body": "" }, 0],
    ...(node.attrs.transition ? [["p", { "data-phase-transition-text": "", contenteditable: "false" }, node.attrs.transition]] : []),
  ],
})

// Formula: an atom whose only state is the expression string; the chips are
// regenerated from it on render.
export const DocumentFormula = Node.create({
  name: "documentFormula",
  group: "block",
  atom: true,
  draggable: true,
  addAttributes() {
    return {
      expression: {
        default: "",
        parseHTML: (element) => element.getAttribute("data-document-formula") ?? "",
        renderHTML: (attributes) => ({ "data-document-formula": attributes.expression }),
      },
    }
  },
  parseHTML: () => [{ tag: "div[data-document-formula]" }],
  renderHTML: ({ node, HTMLAttributes }) => [
    "div",
    HTMLAttributes,
    ...parseFormula(node.attrs.expression ?? "").map((part) =>
      part.kind === "op"
        ? ["span", { "data-formula-op": "" }, part.symbol]
        : [
            "span",
            part.result ? { "data-formula-term": "", "data-formula-result": "" } : { "data-formula-term": "" },
            ["strong", {}, part.label],
            ...(part.caption ? [["small", {}, part.caption]] : []),
          ],
    ),
  ],
})
