"use client"

import {
  FOLDER_SCOPE_CHOICES,
  folderScopeKey,
  type FolderScope,
  type FolderScopeKey,
} from "@/lib/folder-visibility"
import { cn } from "@/lib/utils"
import { Globe, Users } from "lucide-react"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"

export type { FolderScope }

export function FolderScopeIcon({
  scopeKey,
  className,
}: {
  scopeKey: FolderScopeKey
  className?: string
}): React.ReactElement {
  const Icon = scopeKey === "public" ? Globe : Users
  return <Icon className={className} />
}

export function FolderScopePicker({
  value,
  onChange,
  className,
}: {
  value: FolderScope
  onChange: (next: FolderScope) => void
  className?: string
}): React.ReactElement {
  const choices = FOLDER_SCOPE_CHOICES
  const selectedKey = folderScopeKey(value)
  const selected = choices.find((choice) => choice.key === selectedKey)

  return (
    <div className={cn("space-y-2", className)}>
      <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
        Who can see this folder
      </p>

      <Select
        value={selectedKey}
        onValueChange={(key) => {
          const next = choices.find((choice) => choice.key === key)
          if (next) onChange(next.scope)
        }}
      >
        <SelectTrigger className="h-8 w-full text-[12px]">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {choices.map((choice) => (
            <SelectItem key={choice.key} value={choice.key}>
              <span className="flex items-center gap-2">
                <FolderScopeIcon
                  scopeKey={choice.key}
                  className="size-3.5 text-muted-foreground"
                />
                {choice.label}
              </span>
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      <p className="text-[11px] leading-snug text-muted-foreground">
        {selected?.hint}
      </p>
    </div>
  )
}
