/**
 * The one gentle line after 10 s of silence once the coach has asked something (spec 19.8): there is
 * no hurry, and "I don't know" is a fine answer. It is shown (and spoken when speech is on), but it
 * is not a turn: nothing is sent to the server and nothing is recorded.
 */

export const GENTLE_LINES: Record<string, string> = {
  en: 'Take your time. Saying "I don\'t know" is a fine answer too.',
  es: 'Sin prisa. Decir «no lo sé» también es una buena respuesta.',
  fr: 'Prenez votre temps. Dire « je ne sais pas » est aussi une bonne réponse.',
  de: 'Lass dir Zeit. „Ich weiß es nicht“ ist auch eine gute Antwort.',
  it: 'Nessuna fretta. Anche dire «non lo so» è una buona risposta.',
  pt: 'Sem pressa. Dizer "não sei" também é uma boa resposta.',
  hi: 'कोई जल्दी नहीं है। "मुझे नहीं पता" कहना भी ठीक जवाब है।',
  zh: '不着急。说“我不知道”也是一个可以的回答。',
  ja: '急がなくて大丈夫です。「わかりません」も立派な答えです。',
  ko: '서두르지 않아도 돼요. "모르겠어요"라고 말해도 좋은 답이에요.',
}

/** The line in the session language; English where there is no translation. */
export function gentleLine(language: string): string {
  return GENTLE_LINES[language] ?? GENTLE_LINES.en
}
