export type Env = Record<string, string | undefined>

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1'])

/**
 * Variables Railway sets on every deployed service. `railway run` copies them into a local shell
 * too, and that shell talks to the deployed database, so it counts as deployed as well.
 */
const RAILWAY_MARKERS = [
  'RAILWAY_ENVIRONMENT',
  'RAILWAY_ENVIRONMENT_ID',
  'RAILWAY_ENVIRONMENT_NAME',
  'RAILWAY_PROJECT_ID',
  'RAILWAY_SERVICE_ID',
  'RAILWAY_DEPLOYMENT_ID',
  'RAILWAY_PUBLIC_DOMAIN',
  'RAILWAY_PRIVATE_DOMAIN',
]

/** A host name (with or without a port) that can only be reached from this machine. */
export function isLoopbackHost(host: string | null | undefined): boolean {
  if (!host) return false
  let name = host.trim().toLowerCase()
  if (name.startsWith('[')) name = name.slice(1, name.indexOf(']'))
  else if (name.split(':').length === 2) name = name.split(':')[0]
  return LOOPBACK_HOSTS.has(name)
}

export function onRailway(env: Env): boolean {
  return RAILWAY_MARKERS.some((key) => Boolean(env[key]))
}

/** The host name in NEXTAUTH_URL, or null when it is missing or not a URL. */
export function siteHost(env: Env): string | null {
  try {
    return new URL(env.NEXTAUTH_URL ?? '').hostname.replace(/^\[|\]$/g, '') || null
  } catch {
    return null
  }
}

/**
 * Why this server is not a local-only site, or null when it is: NEXTAUTH_URL must name this machine
 * and Railway must not be running it. A missing NEXTAUTH_URL is not provably local.
 */
export function notLocalReason(env: Env): string | null {
  if (onRailway(env)) return 'it is running on Railway'
  const host = siteHost(env)
  if (!host) return 'NEXTAUTH_URL is not set to a URL'
  if (!isLoopbackHost(host)) return `NEXTAUTH_URL points at ${host}, not this machine`
  return null
}

/** A production server that other people can reach: anything but a local production build. */
export function isDeployed(env: Env): boolean {
  return env.NODE_ENV === 'production' && notLocalReason(env) !== null
}
