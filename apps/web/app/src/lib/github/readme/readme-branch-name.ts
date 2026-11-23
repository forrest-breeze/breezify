/** Branch names starting with this are Breezify's to hand out. */
export const BREEZIFY_BRANCH_NAMESPACE = 'breezify/'

/**
 * Whether `name` can be a working branch: Git's rules for a branch name, kept
 * to the characters a docs branch needs. Shared by the publish dialog and the
 * server, so it must stay free of server-only imports.
 */
export function isValidReadmeBranchName(name: string): boolean {
  if (name.length === 0 || name.length > 200) return false
  // Reserved, so a chosen name can never be mistaken for a generated one.
  if (name.toLowerCase().startsWith(BREEZIFY_BRANCH_NAMESPACE)) return false
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(name)) return false
  if (/\.\.|\/\/|\/\.|\.lock(?:\/|$)|[/.]$/.test(name)) return false
  return true
}

/**
 * The working branch of a ReadMe-format link: the branch workspace changes
 * were saved to instead of the synced one, while its pull request is open.
 */
export function readmeWorkingBranch(
  source:
    | {
        format?: string
        publish_pull_request_number: number | null
        publish_pull_request_head: string | null
      }
    | null
    | undefined,
): string | null {
  if (!source || source.format !== 'readme') return null
  if (!source.publish_pull_request_number) return null
  return source.publish_pull_request_head ?? null
}
