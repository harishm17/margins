import { logServerError } from '@/lib/ops/log'
import { NextResponse } from 'next/server'
import { requireAuth } from '@/lib/auth/get-session'
import { getVoiceUsage } from '@/lib/voice/usage-query'
import { cloudSpeechProviders } from '@/lib/voice/cloud-speech'
import { apiInternal, apiUnauthorized, isUnauthorizedError } from '@/lib/api/errors'

export const dynamic = 'force-dynamic'

export async function GET() {
  try {
    const auth = await requireAuth()
    const usage = await getVoiceUsage(auth.user.id)
    // The lobby says where the audio goes before the session starts (spec 19.12): the providers, in the order tried.
    const cloudProviders = cloudSpeechProviders()
    return NextResponse.json({ ...usage, cloudSpeech: cloudProviders.length > 0, cloudProviders })
  } catch (error) {
    logServerError('Voice usage error', error)
    if (isUnauthorizedError(error)) return apiUnauthorized()
    return apiInternal('Failed to load voice usage')
  }
}
