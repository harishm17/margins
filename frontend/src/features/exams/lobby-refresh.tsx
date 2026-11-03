'use client'

import * as React from 'react'
import { useRouter } from 'next/navigation'
import { usePolling } from '@/lib/hooks/use-polling'

/** While an attempt is being graded the lobby asks the server again now and then (paused while the tab is hidden, and for about five minutes at most), so its row turns into a score (or a failure) without a reload. Renders nothing. */
export function LobbyRefresh({ grading }: { grading: boolean }) {
  const router = useRouter()
  usePolling(() => router.refresh(), { active: grading, intervalMs: 4000 })
  return null
}
