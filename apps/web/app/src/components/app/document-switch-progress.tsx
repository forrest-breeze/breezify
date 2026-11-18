"use client"

import { createContext, useContext } from "react"

/**
 * Lets a surface that hosts the document outlet (the Preview builder) draw the
 * "opening document" progress bar itself, inside its own frame, instead of the
 * outlet's default bar pinned to the top of the window.
 *
 * When a reporter is provided, the outlet calls it with `true` while it holds
 * the previous document on screen for the next one, and `false` once it swaps.
 */
export const DocumentSwitchReporterContext = createContext<
  ((switching: boolean) => void) | null
>(null)

export function useDocumentSwitchReporter(): ((switching: boolean) => void) | null {
  return useContext(DocumentSwitchReporterContext)
}
