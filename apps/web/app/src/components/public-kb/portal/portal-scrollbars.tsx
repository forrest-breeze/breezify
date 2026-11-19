"use client"

import { useEffect } from "react"

// How long a scrollbar thumb lingers after the last scroll event.
const HIDE_DELAY_MS = 600

/**
 * Auto-hiding scrollbars for every scroll container inside a
 * `[data-portal-scrollbars]` region (and the page itself on portal pages).
 *
 * Thumbs are transparent by default (see `[data-portal-scrollbars]` in
 * index.css). One capture-phase listener marks whichever element is scrolling
 * with `[data-scrolling]`, which paints its thumb in the portal accent until
 * shortly after scrolling stops. Renders nothing.
 */
export function PortalScrollbars(): null {
  useEffect(() => {
    // The page scrollbar belongs to <html>, outside the portal root that
    // defines the accent, so mirror the accent onto <html>.
    const html = document.documentElement
    const root = document.querySelector("[data-portal-root]")
    const accent = root
      ? getComputedStyle(root).getPropertyValue("--portal-accent").trim()
      : ""
    if (accent) html.style.setProperty("--portal-accent", accent)
    return () => {
      if (accent) html.style.removeProperty("--portal-accent")
    }
  }, [])

  useEffect(() => {
    // Where scrollbars take up layout space (a mouse is attached, or the OS is
    // set to always show them) the page scrollbar's track is a visible strip
    // down the right edge. A transparent track shows whatever is behind the
    // document — the app's own background, or the builder's preview frame —
    // which reads as the portal being cut off whenever that differs from the
    // portal's theme. Paint the track in the portal's page background instead.
    // That color depends on the root's light/dark class and custom background,
    // so keep following it as those change.
    const html = document.documentElement
    const root = document.querySelector("[data-portal-root]")
    if (!root) return
    const sync = (): void => {
      html.style.setProperty(
        "--portal-page-background",
        getComputedStyle(root).backgroundColor,
      )
    }
    sync()
    const observer = new MutationObserver(sync)
    observer.observe(root, { attributes: true })
    return () => {
      observer.disconnect()
      html.style.removeProperty("--portal-page-background")
    }
  }, [])

  useEffect(() => {
    const timers = new WeakMap<Element, ReturnType<typeof setTimeout>>()
    const onScroll = (event: Event): void => {
      const target =
        event.target === document
          ? document.documentElement
          : event.target instanceof Element
            ? event.target
            : null
      if (!target) return
      const inRegion =
        target === document.documentElement
          ? document.querySelector("[data-portal-root]") !== null
          : target.closest("[data-portal-scrollbars]") !== null
      if (!inRegion || !(target instanceof HTMLElement)) return
      target.dataset.scrolling = ""
      const pending = timers.get(target)
      if (pending) clearTimeout(pending)
      timers.set(
        target,
        setTimeout(() => {
          delete target.dataset.scrolling
          timers.delete(target)
        }, HIDE_DELAY_MS),
      )
    }
    document.addEventListener("scroll", onScroll, { capture: true, passive: true })
    return () => document.removeEventListener("scroll", onScroll, { capture: true })
  }, [])
  return null
}
