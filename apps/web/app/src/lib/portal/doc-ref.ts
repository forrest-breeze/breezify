// A portal doc ref is either a raw document UUID (back-compat) or a
// human-readable public_slug. getPublicDocument resolves both and misses on an
// unknown one; this guard only rejects obviously malformed values before the DB.
export const DOC_REF_RE = /^[a-zA-Z0-9][a-zA-Z0-9/_-]{0,199}$/
