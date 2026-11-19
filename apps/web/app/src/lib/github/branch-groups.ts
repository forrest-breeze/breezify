// ---------------------------------------------------------------------------
// Versions and branches of a docs repository.
//
// ReadMe keeps one Git branch per docs version (`v1.6`) and names the working
// branches cut from it `<version>_<name>` (`v1.6_pricing_phases`). This groups
// a repository's branches the same way, so a picker can show each version with
// the branches that belong to it.
// ---------------------------------------------------------------------------

export interface RepositoryBranch {
  name: string
  /** When the branch's latest commit was made. */
  updatedAt: string | null
  /** Who made it: the Git author name, or the GitHub login when there is none. */
  author: string | null
}

export interface BranchEntry extends RepositoryBranch {
  /** The branch this workspace is synced with. */
  synced: boolean
  /** The repository's default branch. */
  isDefault: boolean
}

export interface VersionGroup extends BranchEntry {
  branches: BranchEntry[]
}

export interface BranchGroups {
  versions: VersionGroup[]
  /** Branches that belong to no version. */
  other: BranchEntry[]
  total: number
}

const VERSION_NAME = /^v?\d+(?:\.\d+){0,3}$/i

export function isVersionBranch(name: string): boolean {
  return VERSION_NAME.test(name)
}

function versionParts(name: string): number[] {
  return name.replace(/^v/i, '').split('.').map(Number)
}

/** Newest version first: 1.10 sorts above 1.9. */
function compareVersionsDescending(a: string, b: string): number {
  const left = versionParts(a)
  const right = versionParts(b)
  for (let index = 0; index < Math.max(left.length, right.length); index++) {
    const difference = (right[index] ?? 0) - (left[index] ?? 0)
    if (difference !== 0) return difference
  }
  return a.localeCompare(b)
}

function newestFirst(a: RepositoryBranch, b: RepositoryBranch): number {
  const left = a.updatedAt ? Date.parse(a.updatedAt) : 0
  const right = b.updatedAt ? Date.parse(b.updatedAt) : 0
  return right - left || a.name.localeCompare(b.name)
}

export function groupBranchesByVersion(
  branches: readonly RepositoryBranch[],
  context: { defaultBranch: string | null; syncedBranch: string | null },
): BranchGroups {
  const entry = (branch: RepositoryBranch): BranchEntry => ({
    ...branch,
    synced: branch.name === context.syncedBranch,
    isDefault: branch.name === context.defaultBranch,
  })
  const versions = branches
    .filter((branch) => isVersionBranch(branch.name))
    .sort((a, b) => compareVersionsDescending(a.name, b.name))
    .map((branch): VersionGroup => ({ ...entry(branch), branches: [] }))

  const other: BranchEntry[] = []
  for (const branch of branches) {
    if (isVersionBranch(branch.name)) continue
    // The longest version that prefixes the name, so `v1.10_x` is not filed
    // under `v1.1`.
    const owner = versions
      .filter(
        (version) =>
          branch.name.startsWith(`${version.name}_`) || branch.name.startsWith(`${version.name}/`),
      )
      .sort((a, b) => b.name.length - a.name.length)[0]
    if (owner) owner.branches.push(entry(branch))
    else other.push(entry(branch))
  }
  for (const version of versions) version.branches.sort(newestFirst)
  other.sort(newestFirst)
  return { versions, other, total: branches.length }
}

/** `3mo ago`, the compact age shown beside a branch. */
export function compactAge(iso: string | null, now: number = Date.now()): string {
  if (!iso) return ''
  const then = Date.parse(iso)
  if (Number.isNaN(then)) return ''
  const minutes = Math.max(0, Math.round((now - then) / 60_000))
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.round(hours / 24)
  if (days < 30) return `${days}d ago`
  const months = Math.round(days / 30)
  if (months < 12) return `${months}mo ago`
  return `${Math.round(days / 365)}y ago`
}

/** Case-insensitive filter that keeps a version when it or any of its branches matches. */
export function filterBranchGroups(groups: BranchGroups, query: string): BranchGroups {
  const needle = query.trim().toLowerCase()
  if (!needle) return groups
  const matches = (branch: RepositoryBranch): boolean =>
    branch.name.toLowerCase().includes(needle) ||
    (branch.author ?? '').toLowerCase().includes(needle)
  return {
    total: groups.total,
    versions: groups.versions
      .map((version) => ({
        ...version,
        branches: matches(version) ? version.branches : version.branches.filter(matches),
      }))
      .filter((version) => matches(version) || version.branches.length > 0),
    other: groups.other.filter(matches),
  }
}
