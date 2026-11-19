"use client";

import React from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { RemoteIcon } from "@/components/ui/remote-icon";
import { SourceLogo } from "@/components/ui/source-logo";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { useHasHydrated } from "@/hooks/use-has-hydrated";
import { cn } from "@/lib/utils";
import { FileJson } from "lucide-react";
import { useGithubHostedDocs, useOpenApiSources } from "@/hooks/swr";

// ---------------------------------------------------------------------------
// Settings → Integrations layout.
// Two-pane master/detail: a vertical sidebar of integrations on the left,
// the active integration's configuration UI on the right. Each child page
// still owns its own config UI; this layout only wraps them with shared chrome.
// ---------------------------------------------------------------------------

interface IntegrationDef {
  id: string;
  name: string;
  logo?: string;
  icon?: React.ComponentType<{ className?: string; "aria-hidden"?: boolean | "true" }>;
  invertInDark?: boolean;
  href: string;
}

// The GitHub mark itself rather than a generic branch glyph. It is monochrome,
// so it takes the same muted tint as the other rows' icons.
function GitHubMark({ className }: { className?: string }): React.JSX.Element {
  return <SourceLogo source="github" className={className} />;
}

// Connected apps own a real, per-account connection state (fetched via SWR),
// so their rows render a loading skeleton then an "on" badge.
const CONNECTED_APPS: IntegrationDef[] = [
  {
    id: "openapi",
    name: "OpenAPI",
    icon: FileJson,
    href: "/settings/integrations/openapi",
  },
  {
    id: "github",
    name: "GitHub",
    icon: GitHubMark,
    href: "/settings/integrations/github",
  },
];

export default function IntegrationsLayout({
  children,
}: {
  children: React.ReactNode;
}): React.JSX.Element {
  const pathname = usePathname();

  const openApi = useOpenApiSources();
  const hostedDocs = useGithubHostedDocs();
  // The SWR cache is seeded synchronously on the client, so `isLoading` is
  // false on the first client render while the server always rendered the
  // loading branch — rendering a status slot before hydration mismatches the
  // trees. Hold the server shape (no badge) until hydration completes.
  const hydrated = useHasHydrated();

  // While the first fetch is in flight (SWR isLoading, no cached data) we return
  // "loading" so the row renders a skeleton instead of flashing "not_connected"
  // and then popping the "on" badge in once data arrives.
  type IntegrationStatus = "connected" | "not_connected" | "loading";
  const statusFor = (id: string): IntegrationStatus => {
    if (id === "openapi")
      return openApi.isLoading
        ? "loading"
        : (openApi.data?.sources.length ?? 0) > 0
          ? "connected"
          : "not_connected";
    if (id === "github")
      return hostedDocs.isLoading
        ? "loading"
        : hostedDocs.data?.source
          ? "connected"
          : "not_connected";
    return "not_connected";
  };

  const renderRow = (def: IntegrationDef): React.JSX.Element => {
    const active = pathname === def.href;
    const status = hydrated ? statusFor(def.id) : "not_connected";
    return (
      <li key={def.id}>
        <Link
          href={def.href}
          className={cn(
            "flex items-center gap-3 rounded-md border px-3 py-2 transition",
            active
              ? "border-foreground bg-muted"
              : "border-transparent hover:border-border hover:bg-muted/50",
          )}
        >
          <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-sm bg-background">
            {def.icon ? (
              <def.icon className="size-4 text-muted-foreground" aria-hidden="true" />
            ) : def.logo ? (
              <RemoteIcon
                src={def.logo}
                alt={def.name}
                size={20}
                className={def.invertInDark ? "dark:invert" : ""}
              />
            ) : (
              <span className="text-[10px] font-semibold uppercase text-muted-foreground">
                {def.id.slice(0, 2)}
              </span>
            )}
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex items-center justify-between gap-2">
              <span
                className={cn(
                  "text-sm font-medium",
                  !active && "text-foreground",
                )}
              >
                {def.name}
              </span>
              {status === "loading" ? (
                <Skeleton className="h-4 w-7 rounded-full" />
              ) : status === "connected" ? (
                <Badge variant="secondary" className="h-4 px-1.5 text-[10px]">
                  on
                </Badge>
              ) : null}
            </div>
          </div>
        </Link>
      </li>
    );
  };

  return (
    // min-h-full, not h-full: the page grows past the viewport inside the
    // shell's scrolling <main>, so the bottom padding lands after the content.
    <div className="flex min-h-full flex-col gap-4 p-6 pb-16 lg:p-8 lg:pb-20">
      <div>
        <h1 className="text-xl font-semibold">Integrations</h1>
      </div>

      <div className="flex flex-col gap-6 lg:flex-row lg:gap-8">
        <nav className="lg:w-64 lg:shrink-0">
          <p className="px-3 pb-1.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
            Connected apps
          </p>
          <ul className="space-y-1">
            {CONNECTED_APPS.map((def) => renderRow(def))}
          </ul>
        </nav>

        <div className="min-w-0 flex-1">{children}</div>
      </div>
    </div>
  );
}
