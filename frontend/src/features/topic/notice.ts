import { aiMessage } from '@/lib/ai/messages'

/** A failure to show on the topic page, for one kind of content. */
export type GenerationNotice = {
  message: string
  tone: 'danger' | 'warning'
  /** Whether Try again may work (it is not offered for, say, AI being unavailable). */
  retry: boolean
}

/** The notice for a failure with this code, in the shared words (lib/ai/messages). */
export function noticeForCode(code: string | null | undefined, retryable?: boolean): GenerationNotice {
  const message = aiMessage(code, 'generate_content')
  return {
    message: message.text,
    tone: message.tone === 'danger' ? 'danger' : 'warning',
    retry: retryable ?? message.retry,
  }
}
