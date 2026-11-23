"use client"

import { useHasHydrated } from "@/hooks/use-has-hydrated"
import { APP_THEME_INIT_SCRIPT } from "@/lib/app-theme-init"

/**
 * The theme init script, in the server's HTML only.
 *
 * It has to run while the HTML is parsed, so it is rendered on the server and
 * kept through hydration. A script React creates on the client never runs,
 * and React reports each one as an error: that happens whenever this layout
 * is rendered in the browser instead (a client-side navigation into the app,
 * or the re-render after a failed hydration). There the theme provider's
 * effect applies the theme, so nothing is rendered.
 */
export function AppThemeInitScript(): React.JSX.Element | null {
  const hydrated = useHasHydrated()
  if (hydrated) return null
  return <script dangerouslySetInnerHTML={{ __html: APP_THEME_INIT_SCRIPT }} />
}
