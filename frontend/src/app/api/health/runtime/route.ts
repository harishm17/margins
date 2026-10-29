import { NextResponse } from 'next/server'
import fs from 'fs'
import path from 'path'

export const runtime = 'nodejs'

type CheckStatus = 'pass' | 'warn' | 'fail'

type RuntimeCheck = {
  name: string
  status: CheckStatus
  message: string
}

function statusFromChecks(checks: RuntimeCheck[]): 'healthy' | 'degraded' | 'unhealthy' {
  if (checks.some((check) => check.status === 'fail')) return 'unhealthy'
  if (checks.some((check) => check.status === 'warn')) return 'degraded'
  return 'healthy'
}

function canWriteDir(baseDir: string): boolean {
  try {
    fs.mkdirSync(baseDir, { recursive: true })
    const marker = path.join(baseDir, '.healthcheck')
    fs.writeFileSync(marker, 'ok')
    fs.unlinkSync(marker)
    return true
  } catch {
    return false
  }
}

export async function GET() {
  const checks: RuntimeCheck[] = []

  const nodeEnv = process.env.NODE_ENV || 'development'
  const appEnv = process.env.ENVIRONMENT || 'development'
  const isDeploymentProduction = appEnv === 'production'
  const aiServiceUrl = process.env.AI_SERVICE_URL || ''
  const s3Bucket = process.env.S3_BUCKET || ''
  const s3CredentialsSet = Boolean(process.env.S3_ACCESS_KEY_ID && process.env.S3_SECRET_ACCESS_KEY)
  const nextAuthSecret = process.env.NEXTAUTH_SECRET || ''
  const localUploadsDir = process.env.LOCAL_UPLOADS_DIR || '/data/uploads'

  if (!aiServiceUrl) {
    checks.push({
      name: 'ai_service_url',
      status: 'fail',
      message: 'AI_SERVICE_URL is not configured.',
    })
  } else {
    checks.push({
      name: 'ai_service_url',
      status: 'pass',
      message: 'AI service URL configured.',
    })

    try {
      const response = await fetch(`${aiServiceUrl}/health`, {
        signal: AbortSignal.timeout(4000),
      })
      if (!response.ok) {
        checks.push({
          name: 'ai_service_health',
          status: 'warn',
          message: `AI health endpoint returned ${response.status}.`,
        })
      } else {
        checks.push({
          name: 'ai_service_health',
          status: 'pass',
          message: 'AI service health endpoint reachable.',
        })
      }
    } catch (error) {
      checks.push({
        name: 'ai_service_health',
        status: 'fail',
        message: `AI service health check failed: ${String(error)}`,
      })
    }
  }

  if (s3Bucket) {
    checks.push(
      s3CredentialsSet
        ? { name: 's3_config', status: 'pass', message: 'S3 storage is enabled and credentials are present.' }
        : {
            name: 's3_config',
            status: 'fail',
            message: 'S3_BUCKET is set but S3_ACCESS_KEY_ID or S3_SECRET_ACCESS_KEY is missing.',
          }
    )
  } else {
    const primaryWritable = canWriteDir(localUploadsDir)
    const fallbackWritable = canWriteDir('/tmp/margins-uploads')
    if (primaryWritable || fallbackWritable) {
      checks.push({
        name: 'local_storage_writable',
        status: 'pass',
        message: `Local storage writable (${primaryWritable ? localUploadsDir : '/tmp/margins-uploads'}).`,
      })
    } else {
      checks.push({
        name: 'local_storage_writable',
        status: 'fail',
        message: `Local storage is not writable in ${localUploadsDir} or /tmp/margins-uploads.`,
      })
    }
  }

  if (isDeploymentProduction) {
    if (!nextAuthSecret || nextAuthSecret === 'dev-secret-change-in-production') {
      checks.push({
        name: 'nextauth_secret',
        status: 'fail',
        message: 'NEXTAUTH_SECRET must be set to a secure value in production.',
      })
    } else {
      checks.push({
        name: 'nextauth_secret',
        status: 'pass',
        message: 'NEXTAUTH_SECRET is configured.',
      })
    }
  } else if (!nextAuthSecret || nextAuthSecret === 'dev-secret-change-in-production') {
    checks.push({
      name: 'nextauth_secret',
      status: 'warn',
      message: 'NEXTAUTH_SECRET is using a local/dev value. Set a strong secret before deployment.',
    })
  }

  const status = statusFromChecks(checks)
  return NextResponse.json({
    status,
    environment: nodeEnv,
    appEnvironment: appEnv,
    checks,
    generatedAt: new Date().toISOString(),
  })
}
