"use client"

import { useEffect, useRef, useState, type RefObject } from "react"
import { Menu as MenuPrimitive } from "@base-ui/react/menu"
import { ArrowUpRight, Check, ChevronDown, Copy } from "lucide-react"
import { cn } from "@/lib/utils"

// "Copy page" split button + menu: copy the page as Markdown, view it as
// Markdown, or open it in an AI assistant.
//
// Every Markdown action goes through the page's `.md` twin
// (`<portal>/doc/<ref>.md`, served by /api/public/llms via the proxy), which
// renders from the stored document rather than the page chrome. A page with no
// public twin (an unpublished draft in the builder preview) still copies:
// the rendered article is converted to Markdown in the browser instead.
interface PortalCopyPageButtonProps {
  /** Container whose rendered article is the copy fallback. */
  targetRef: RefObject<HTMLElement | null>
  /** Prepended to the fallback copy — the title sits outside the container. */
  heading?: string
  /**
   * The page's Markdown twin, `<hrefBase>/doc/<ref>.md` (see
   * portalDocMarkdownHref). Without it the menu offers only the copy.
   */
  markdownHref?: string
  className?: string
}

type AssistantId = "chatgpt" | "claude" | "perplexity"

// Shelved for now: the menu offers only Copy page and View as Markdown. Keep the
// "Open in …" implementation so it can return by flipping this flag.
const ASSISTANT_LINKS_ENABLED = false

const ASSISTANTS: Array<{
  id: AssistantId
  label: string
  url: (prompt: string) => string
}> = [
  {
    id: "chatgpt",
    label: "Open in ChatGPT",
    url: (q) => `https://chatgpt.com/?hints=search&q=${encodeURIComponent(q)}`,
  },
  {
    id: "claude",
    label: "Open in Claude",
    url: (q) => `https://claude.ai/new?q=${encodeURIComponent(q)}`,
  },
  {
    id: "perplexity",
    label: "Open in Perplexity",
    url: (q) => `https://www.perplexity.ai/search/new?q=${encodeURIComponent(q)}`,
  },
]

function absolute(path: string): string {
  return new URL(path, window.location.origin).toString()
}

async function renderedMarkdown(
  target: HTMLElement | null,
  heading: string | undefined,
): Promise<string> {
  if (!target) return ""
  const { documentHtmlToMarkdown } = await import("@/lib/document-export")
  const body = documentHtmlToMarkdown(target.innerHTML).trim() || target.innerText.trim()
  const title = heading?.trim()
  return title ? `# ${title}\n\n${body}` : body
}

export function PortalCopyPageButton({
  targetRef,
  heading,
  markdownHref,
  className,
}: PortalCopyPageButtonProps): React.ReactElement {
  const [copied, setCopied] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  // Portal the menu into the portal root so it inherits the portal's theme
  // tokens and light/dark class (the document body carries the app's).
  const [container, setContainer] = useState<HTMLElement | null>(null)
  useEffect(() => {
    setContainer(
      rootRef.current?.closest<HTMLElement>("[data-portal-root]") ?? document.body,
    )
  }, [])

  async function copy(): Promise<void> {
    let text = ""
    if (markdownHref) {
      try {
        const response = await fetch(markdownHref, { headers: { accept: "text/markdown" } })
        if (response.ok) text = (await response.text()).trim()
      } catch {
        // Fall through to the rendered article.
      }
    }
    if (!text) text = await renderedMarkdown(targetRef.current, heading)
    if (!text) return
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1500)
    } catch {
      // Clipboard access can be denied (permissions, insecure origin). Leave the
      // button in its resting state rather than claiming a copy that never was.
      setCopied(false)
    }
  }

  function openAssistant(url: (prompt: string) => string): void {
    if (!markdownHref) return
    const prompt = `Read ${absolute(markdownHref)} so I can ask questions about it.`
    window.open(url(prompt), "_blank", "noopener,noreferrer")
  }

  const itemClass =
    "flex w-full cursor-default items-center gap-3 rounded-md px-2 py-2 text-left outline-none data-highlighted:bg-muted"

  return (
    <div
      ref={rootRef}
      className={cn(
        "inline-flex h-9 shrink-0 items-stretch overflow-hidden rounded-lg border border-border bg-muted/40 text-sm font-medium text-muted-foreground",
        className,
      )}
    >
      <button
        type="button"
        onClick={() => void copy()}
        className="inline-flex items-center gap-2 px-3 transition-colors hover:bg-muted hover:text-foreground"
      >
        {copied ? <Check className="size-4" /> : <Copy className="size-4" />}
        {copied ? "Copied" : "Copy page"}
      </button>
      <MenuPrimitive.Root>
        <MenuPrimitive.Trigger
          aria-label="More page actions"
          className="group inline-flex items-center border-l border-border px-2 transition-colors hover:bg-muted hover:text-foreground data-popup-open:bg-muted data-popup-open:text-foreground"
        >
          <ChevronDown className="size-4 transition-transform group-data-popup-open:rotate-180" />
        </MenuPrimitive.Trigger>
        <MenuPrimitive.Portal container={container}>
          <MenuPrimitive.Positioner
            className="isolate z-50 outline-none"
            side="bottom"
            align="end"
            sideOffset={6}
          >
            <MenuPrimitive.Popup className="w-72 origin-(--transform-origin) rounded-xl border border-border bg-background p-1 text-foreground shadow-lg outline-none data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95">
              <MenuPrimitive.Item className={itemClass} onClick={() => void copy()}>
                <ItemIcon>
                  <Copy className="size-4" />
                </ItemIcon>
                <ItemText title="Copy page" description="Copy page as Markdown for LLMs" />
              </MenuPrimitive.Item>
              {markdownHref && ASSISTANT_LINKS_ENABLED ? ASSISTANTS.slice(0, 2).map((assistant) => (
                <MenuPrimitive.Item
                  key={assistant.id}
                  className={itemClass}
                  onClick={() => openAssistant(assistant.url)}
                >
                  <ItemIcon>
                    <AssistantIcon id={assistant.id} />
                  </ItemIcon>
                  <ItemText title={assistant.label} description="Ask questions about this page" external />
                </MenuPrimitive.Item>
              )) : null}
              {markdownHref ? (
              <MenuPrimitive.Item
                className={itemClass}
                onClick={() => window.open(markdownHref, "_blank", "noopener,noreferrer")}
              >
                <ItemIcon>
                  <MarkdownIcon />
                </ItemIcon>
                <ItemText title="View as Markdown" description="View this page as plain text" external />
              </MenuPrimitive.Item>
              ) : null}
              {markdownHref && ASSISTANT_LINKS_ENABLED ? ASSISTANTS.slice(2).map((assistant) => (
                <MenuPrimitive.Item
                  key={assistant.id}
                  className={itemClass}
                  onClick={() => openAssistant(assistant.url)}
                >
                  <ItemIcon>
                    <AssistantIcon id={assistant.id} />
                  </ItemIcon>
                  <ItemText title={assistant.label} description="Ask questions about this page" external />
                </MenuPrimitive.Item>
              )) : null}
            </MenuPrimitive.Popup>
          </MenuPrimitive.Positioner>
        </MenuPrimitive.Portal>
      </MenuPrimitive.Root>
    </div>
  )
}

function ItemIcon({ children }: { children: React.ReactNode }): React.ReactElement {
  return (
    <span className="grid size-9 shrink-0 place-items-center rounded-md border border-border text-muted-foreground">
      {children}
    </span>
  )
}

function ItemText({
  title,
  description,
  external = false,
}: {
  title: string
  description: string
  external?: boolean
}): React.ReactElement {
  return (
    <span className="min-w-0">
      <span className="flex items-center gap-1 text-sm font-medium text-foreground">
        {title}
        {external ? <ArrowUpRight className="size-3.5 text-muted-foreground" aria-hidden="true" /> : null}
      </span>
      <span className="block text-xs text-muted-foreground">{description}</span>
    </span>
  )
}

function MarkdownIcon(): React.ReactElement {
  return (
    <svg viewBox="0 0 24 24" className="size-4" fill="none" stroke="currentColor" strokeWidth={1.6} aria-hidden="true">
      <rect x="2" y="5" width="20" height="14" rx="2" />
      <path d="M6 15V9l2.5 3L11 9v6M16 9v6m0 0-2-2m2 2 2-2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

// Simplified marks — monochrome, drawn in currentColor to match the menu.
function AssistantIcon({ id }: { id: AssistantId }): React.ReactElement {
  if (id === "claude") {
    return (
      <svg viewBox="0 0 24 24" className="size-4" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" aria-hidden="true">
        {Array.from({ length: 12 }, (_, i) => {
          const angle = (i * Math.PI) / 6
          const inner = 2.5
          const outer = i % 2 === 0 ? 9.5 : 7.5
          return (
            <line
              key={i}
              x1={12 + inner * Math.cos(angle)}
              y1={12 + inner * Math.sin(angle)}
              x2={12 + outer * Math.cos(angle)}
              y2={12 + outer * Math.sin(angle)}
            />
          )
        })}
      </svg>
    )
  }
  if (id === "perplexity") {
    return (
      <svg viewBox="0 0 24 24" className="size-4" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinejoin="round" aria-hidden="true">
        <path d="M12 2v20M5 4l7 6 7-6M5 4v6h14V4M5 10l-1 0v7l8-7M19 10h1v7l-8-7M7 14v6l5-4 5 4v-6" />
      </svg>
    )
  }
  return (
    <svg viewBox="0 0 24 24" className="size-4" fill="none" stroke="currentColor" strokeWidth={1.5} aria-hidden="true">
      {Array.from({ length: 6 }, (_, i) => (
        <rect
          key={i}
          x="9"
          y="3"
          width="6"
          height="12"
          rx="3"
          transform={`rotate(${i * 60} 12 12)`}
        />
      ))}
    </svg>
  )
}
