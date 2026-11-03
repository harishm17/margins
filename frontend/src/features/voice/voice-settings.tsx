'use client'

import * as React from 'react'
import { SlidersHorizontal } from '@phosphor-icons/react/dist/ssr'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { IconButton } from '@/components/ui/icon-button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Select } from '@/components/ui/select'
import { languageTag } from './speech'
import {
  DEFAULT_PREFS,
  getVoicePrefs,
  RATE_MAX,
  RATE_MIN,
  RATE_STEP,
  setVoicePrefs,
  subscribeVoicePrefs,
  voiceKey,
  voicesForLanguage,
  type VoicePrefs,
} from './voice-prefs'

/** The saved voice settings, live: a change anywhere (lobby, session, the mute button) shows everywhere. */
export function useVoicePrefs(): VoicePrefs {
  return React.useSyncExternalStore(subscribeVoicePrefs, getVoicePrefs, () => DEFAULT_PREFS)
}

/** The voices installed in this browser. Chrome fills the list late and announces it with `voiceschanged`. */
function useInstalledVoices(): SpeechSynthesisVoice[] {
  const [voices, setVoices] = React.useState<SpeechSynthesisVoice[]>([])
  React.useEffect(() => {
    const synth = typeof window === 'undefined' ? undefined : window.speechSynthesis
    if (!synth) return
    const read = () => setVoices(synth.getVoices())
    read()
    synth.addEventListener?.('voiceschanged', read)
    return () => synth.removeEventListener?.('voiceschanged', read)
  }, [])
  return voices
}

const AUTOMATIC = 'auto'

/** "Speak replies" on its own: the lobby shows it before the first word is spoken. */
export function SpeakRepliesToggle({ disabled, compact }: { disabled?: boolean; compact?: boolean }) {
  const prefs = useVoicePrefs()
  return (
    <Checkbox
      checked={prefs.speak}
      onCheckedChange={(checked) => setVoicePrefs({ speak: checked === true })}
      disabled={disabled}
      label="Speak replies"
      description={compact ? undefined : "Turn it off to read the coach's replies instead of hearing them."}
      data-testid="voice-speak-toggle"
    />
  )
}

type VoiceSettingsProps = {
  /** The language code the session was started with (en, es, ...). */
  language: string
  onPreview: () => void
}

/** The voice, the speaking rate and "Speak replies", in a popover next to the mute button. */
export function VoiceSettings({ language, onPreview }: VoiceSettingsProps) {
  const prefs = useVoicePrefs()
  const installed = useInstalledVoices()
  const tag = languageTag(language)
  const options = React.useMemo(() => voicesForLanguage(installed, tag), [installed, tag])
  const chosen = prefs.voices[tag]
  const value = chosen && options.some((voice) => voiceKey(voice) === chosen) ? chosen : AUTOMATIC
  const rateId = React.useId()

  return (
    <Popover>
      <PopoverTrigger asChild>
        <IconButton variant="ghost" label="Voice settings" icon={<SlidersHorizontal />} data-testid="voice-settings-trigger" />
      </PopoverTrigger>
      <PopoverContent align="end" className="flex flex-col gap-4" data-testid="voice-settings">
        <SpeakRepliesToggle />
        <div className="flex flex-col gap-1.5">
          <span id={`${rateId}-voice`} className="text-small font-medium text-fg">
            Voice
          </span>
          <Select
            aria-labelledby={`${rateId}-voice`}
            value={value}
            disabled={!prefs.speak}
            onValueChange={(next) => setVoicePrefs({ voice: { tag, key: next === AUTOMATIC ? null : next } })}
            options={[
              { value: AUTOMATIC, label: 'Best available' },
              ...options.map((voice) => ({ value: voiceKey(voice), label: voice.name })),
            ]}
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <div className="flex items-baseline justify-between gap-2">
            <label htmlFor={rateId} className="text-small font-medium text-fg">
              Speed
            </label>
            <span className="tabular text-small text-fg-2" aria-hidden="true">
              {prefs.rate.toFixed(1)}x
            </span>
          </div>
          <input
            id={rateId}
            type="range"
            min={RATE_MIN}
            max={RATE_MAX}
            step={RATE_STEP}
            value={prefs.rate}
            disabled={!prefs.speak}
            aria-valuetext={`${prefs.rate.toFixed(1)} times normal speed`}
            onChange={(event) => setVoicePrefs({ rate: Number(event.target.value) })}
            className="h-6 w-full accent-[var(--accent)] disabled:opacity-50"
            data-testid="voice-rate"
          />
        </div>
        <Button variant="secondary" size="sm" disabled={!prefs.speak} onClick={onPreview} className="self-start">
          Hear a sample
        </Button>
      </PopoverContent>
    </Popover>
  )
}
