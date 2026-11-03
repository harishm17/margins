import { NextResponse } from 'next/server'
import { requireAuth } from '@/lib/auth/get-session'
import { getVoiceUsage } from '@/lib/voice/usage-query'
import { cloudSpeechConfigured } from '@/lib/voice/cloud-speech'
import { apiInternal, apiUnauthorized, isUnauthorizedError } from '@/lib/api/errors'

export const dynamic = 'force-dynamic'

export async function GET() {
  try {
    const auth = await requireAuth()
    const usage = await getVoiceUsage(auth.user.id)
    // `cloudSpeech`: the lobby can say where the audio goes before the session starts (spec 19.12).
    return NextResponse.json({ ...usage, cloudSpeech: cloudSpeechConfigured() })
  } catch (error) {
    console.error('Voice usage error:', error)
    if (isUnauthorizedError(error)) return apiUnauthorized()
    return apiInternal('Failed to load voice usage')
  }
}
