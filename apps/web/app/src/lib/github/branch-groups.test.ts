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

  it('files the branch changes are saved to under the synced version, whatever its name', () => {
    const working = groupBranchesByVersion([...branches, branch('test', '2026-01-01T00:00:00Z')], {
      defaultBranch: 'v1.6',
      syncedBranch: 'v1.6',
      workingBranch: 'test',
    })
    const v16 = working.versions.find((version) => version.name === 'v1.6')!
    // First, ahead of branches updated more recently: it is the one in use.
    expect(v16.branches.map((entry) => [entry.name, entry.working])).toEqual([
      ['test', true],
      ['v1.6_subscription', false],
      ['v1.6_pricing_phases', false],
    ])
  })

  it('leaves out branches that belong to no version, and marks the synced and default branch', () => {
    const listed = groups.versions.flatMap((version) => [version.name, ...version.branches.map((entry) => entry.name)])
    expect(listed).not.toContain('main')
    expect(listed).not.toContain('breezify/readme-sync-abc')
    expect(listed).not.toContain('v2.0_ideas')
    expect(groups.versions.find((version) => version.name === 'v1.6')).toMatchObject({ synced: true, isDefault: true })
    expect(groups.versions.find((version) => version.name === 'v1.9')).toMatchObject({ synced: false, isDefault: false })
    expect(groups.total).toBe(10)
  })

  it('counts the synced branch as a version when it is not named like one', () => {
    const synced = groupBranchesByVersion([...branches, branch('main_intro')], {
      defaultBranch: 'main',
      syncedBranch: 'main',
    })
    // After the named versions, with the branches cut from it.
    expect(synced.versions.map((version) => version.name)).toEqual(['v1.10', 'v1.9', 'v1.6', 'v1.1', 'main'])
    expect(synced.versions.at(-1)).toMatchObject({ synced: true, isDefault: true })
    expect(synced.versions.at(-1)!.branches.map((entry) => entry.name)).toEqual(['main_intro'])
  })

  it('filters by branch name or author, keeping the version a match sits under', () => {
    const filtered = filterBranchGroups(groups, 'PRICING')
    expect(filtered.versions.map((version) => version.name)).toEqual(['v1.6'])
    expect(filtered.versions[0]!.branches.map((entry) => entry.name)).toEqual(['v1.6_pricing_phases'])
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
