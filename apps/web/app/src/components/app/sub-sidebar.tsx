"use client"

import { cn } from "@/lib/utils"
import { ScrollArea } from "@/components/ui/scroll-area"
import { useResizable } from "@/hooks/use-resizable"
import { useSubSidebar } from "@/components/app/sub-sidebar-context"
import {
  Sheet,
  SheetContent,
  SheetTitle,
} from "@/components/ui/sheet"

interface SubSidebarProps {
  title?: string
  /** Rendered at the right edge of the title row. */
  headerAction?: React.ReactNode
  children: React.ReactNode
  /** Pinned below the content. Takes no room while it renders nothing. */
  footer?: React.ReactNode
  /** Disable the outer viewport when a child owns a bounded scroll region. */
  scrollContent?: boolean
}

export function SubSidebar({
  title,
  headerAction,
  children,
  footer,
  scrollContent = true,
}: SubSidebarProps) {
  const { isOpen, width, setWidth } = useSubSidebar()
  const { handleRef, isDragging } = useResizable({
    initialWidth: width,
    minWidth: 200,
    maxWidth: 800,
    onWidthChange: setWidth,
  })

  return (
    <aside
      className={cn(
        "relative hidden shrink-0 border-r border-border lg:flex lg:flex-col min-h-0 h-full",
        !isDragging && "transition-all duration-300"
      )}
      style={{ width: isOpen ? width : 0, overflow: isOpen ? undefined : "hidden" }}
    >
      {isOpen && (
        <>
          {title && (
            <div className="flex h-14 shrink-0 items-center justify-between gap-2 px-4">
              <span className="shrink-0 text-sm font-semibold">{title}</span>
              {headerAction ? (
                <div className="flex min-w-0 justify-end">{headerAction}</div>
              ) : null}
            </div>
          )}

          <div className="flex-1 min-h-0">
            {scrollContent ? (
              <ScrollArea className="h-full [&_[data-slot=scroll-area-scrollbar]]:hidden">
                <div className="flex min-h-full flex-col px-2 pb-4">
                  {children}
                </div>
              </ScrollArea>
            ) : (
              <div
                data-slot="sub-sidebar-contained-content"
                className="flex h-full min-h-0 flex-col px-2"
              >
                {children}
              </div>
            )}
          </div>

          {footer ? (
            <div
              data-slot="sub-sidebar-footer"
              className="shrink-0 bg-background px-2 pb-4 empty:hidden"
            >
              {footer}
            </div>
          ) : null}

          {/* Drag handle */}
          <div
            ref={handleRef}
            className={cn(
              "absolute right-0 top-0 z-10 h-full w-1 cursor-col-resize",
              "before:absolute before:inset-y-0 before:-left-2 before:-right-2 before:content-['']",
              isDragging && "bg-primary/30"
            )}
          />
        </>
      )}
    </aside>
  )
}

interface MobileSubSidebarProps {
  title?: string
  /** Rendered at the right edge of the title row. */
  headerAction?: React.ReactNode
  children: React.ReactNode
  /** Pinned below the content. Takes no room while it renders nothing. */
  footer?: React.ReactNode
  /** Disable the outer viewport when a child owns a bounded scroll region. */
  scrollContent?: boolean
  open: boolean
  onOpenChange: (open: boolean) => void
}

export function MobileSubSidebar({
  title,
  headerAction,
  children,
  footer,
  scrollContent = true,
  open,
  onOpenChange,
}: MobileSubSidebarProps) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" showCloseButton={false} className="w-[260px] p-0 flex flex-col">
        {title && (
          <div className="flex h-14 shrink-0 items-center justify-between gap-2 border-b border-border px-4">
            <SheetTitle className="shrink-0 text-sm font-semibold">{title}</SheetTitle>
            {headerAction ? (
              <div className="flex min-w-0 justify-end">{headerAction}</div>
            ) : null}
          </div>
        )}
        <div className="flex-1 min-h-0">
          {scrollContent ? (
            <ScrollArea className="h-full">
              <div className="px-2 pb-4">{children}</div>
            </ScrollArea>
          ) : (
            <div
              data-slot="sub-sidebar-contained-content"
              className="flex h-full min-h-0 flex-col px-2"
            >
              {children}
            </div>
          )}
        </div>
        {footer ? (
          <div
            data-slot="sub-sidebar-footer"
            className="shrink-0 bg-background px-2 pb-4 empty:hidden"
          >
            {footer}
          </div>
        ) : null}
      </SheetContent>
    </Sheet>
  )
}
