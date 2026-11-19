// ---------------------------------------------------------------------------
// Which commit a GitHub webhook asks one of the docs checks to run on. Shared
// by every check the App posts on a ReadMe-format repository.
// ---------------------------------------------------------------------------

export interface DocsCheckInfo {
  installationId: number
  repoId: number
  repoFullName: string
  headSha: string
}

function objectOf(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function positiveInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : null
}

/**
 * The commit a webhook asks the check named `checkName` to run on: a new check
 * suite (every push, so every pull request update), or someone pressing
 * "Re-run" on that check. A re-run is accepted only for a run this App owns,
 * so a same-named check from another App cannot trigger work.
 */
export function extractDocsCheckInfo(
  eventType: string,
  payload: Record<string, unknown>,
  checkName: string,
  expectedAppId: string | undefined = process.env.GITHUB_APP_ID,
): DocsCheckInfo | null {
  const repository = objectOf(payload.repository)
  const installationId = positiveInteger(objectOf(payload.installation)?.id)
  const repoId = positiveInteger(repository?.id)
  const repoFullName = typeof repository?.full_name === 'string' ? repository.full_name : ''
  if (!installationId || !repoId || !/^[^/\s]+\/[^/\s]+$/.test(repoFullName)) return null
  const common = { installationId, repoId, repoFullName }

  if (eventType === 'check_suite') {
    if (payload.action !== 'requested' && payload.action !== 'rerequested') return null
    const headSha = objectOf(payload.check_suite)?.head_sha
    return typeof headSha === 'string' && headSha ? { ...common, headSha } : null
  }
  if (eventType !== 'check_run' || payload.action !== 'rerequested') return null
  const appId = expectedAppId ? Number(expectedAppId) : Number.NaN
  const checkRun = objectOf(payload.check_run)
  if (
    !Number.isSafeInteger(appId) ||
    checkRun?.name !== checkName ||
    positiveInteger(objectOf(checkRun.app)?.id) !== appId
  ) {
    return null
  }
  const headSha = checkRun.head_sha
  return typeof headSha === 'string' && headSha ? { ...common, headSha } : null
}
