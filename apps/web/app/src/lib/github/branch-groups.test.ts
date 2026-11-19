import { describe, expect, it } from 'vitest'
import {
  compactAge,
  filterBranchGroups,
  groupBranchesByVersion,
  type RepositoryBranch,
} from './branch-groups'

const branch = (name: string, updatedAt = '2026-11-01T00:00:00Z', author = 'Ada'): RepositoryBranch => ({
  name,
  updatedAt,
  author,
})

describe('groupBranchesByVersion', () => {
  const branches = [
    branch('v1.9'),
    branch('v1.10'),
    branch('v1.6'),
    branch('v1.6_pricing_phases', '2026-08-01T00:00:00Z'),
    branch('v1.6_subscription', '2026-09-01T00:00:00Z'),
    branch('v1.10_draft'),
    branch('v1.1'),
    branch('main'),
    branch('breezify/readme-sync-abc'),
    // Looks like a version prefix, but that version has no branch of its own.
    branch('v2.0_ideas'),
  ]
  const groups = groupBranchesByVersion(branches, { defaultBranch: 'v1.6', syncedBranch: 'v1.6' })

  it('lists versions newest first, comparing numbers rather than text', () => {
    expect(groups.versions.map((version) => version.name)).toEqual(['v1.10', 'v1.9', 'v1.6', 'v1.1'])
  })

  it('files a working branch under the version it is named after', () => {
    const v16 = groups.versions.find((version) => version.name === 'v1.6')!
    // Most recently updated first.
    expect(v16.branches.map((entry) => entry.name)).toEqual(['v1.6_subscription', 'v1.6_pricing_phases'])
    // `v1.10_draft` belongs to v1.10, not to v1.1.
    expect(groups.versions.find((version) => version.name === 'v1.10')!.branches.map((entry) => entry.name)).toEqual(['v1.10_draft'])
    expect(groups.versions.find((version) => version.name === 'v1.1')!.branches).toEqual([])
  })

  it('keeps everything else, and marks the synced and default branch', () => {
    expect(groups.other.map((entry) => entry.name).sort()).toEqual(['breezify/readme-sync-abc', 'main', 'v2.0_ideas'])
    expect(groups.versions.find((version) => version.name === 'v1.6')).toMatchObject({ synced: true, isDefault: true })
    expect(groups.versions.find((version) => version.name === 'v1.9')).toMatchObject({ synced: false, isDefault: false })
    expect(groups.total).toBe(10)
  })

  it('filters by branch name or author, keeping the version a match sits under', () => {
    const filtered = filterBranchGroups(groups, 'PRICING')
    expect(filtered.versions.map((version) => version.name)).toEqual(['v1.6'])
    expect(filtered.versions[0]!.branches.map((entry) => entry.name)).toEqual(['v1.6_pricing_phases'])
    expect(filtered.other).toEqual([])
    // Matching a version keeps all of its branches.
    expect(filterBranchGroups(groups, 'v1.6').versions[0]!.branches).toHaveLength(2)
  })
})

describe('compactAge', () => {
  const now = Date.parse('2026-11-20T12:00:00Z')
  it('describes how long ago a branch was updated', () => {
    expect(compactAge('2026-11-20T11:59:50Z', now)).toBe('just now')
    expect(compactAge('2026-11-20T11:15:00Z', now)).toBe('45m ago')
    expect(compactAge('2026-11-20T06:00:00Z', now)).toBe('6h ago')
    expect(compactAge('2026-11-10T12:00:00Z', now)).toBe('10d ago')
    expect(compactAge('2026-08-20T12:00:00Z', now)).toBe('3mo ago')
    expect(compactAge('2024-11-20T12:00:00Z', now)).toBe('2y ago')
    expect(compactAge(null, now)).toBe('')
  })
})
