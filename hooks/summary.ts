import { locale, localized, t } from './i18n'
import { lineOf } from './tasks'
import type { TopicCandidate, TopicChoice } from './tasks'

// the small model that sums up a request and what it came to
export const SUMMARY_MODEL = 'haiku'
// how long one summary may take before it is given up
export const SUMMARY_TIMEOUT_MS = 15_000
// a prompt, and an answer, are cut to this many characters before they are sent
export const SUMMARY_INPUT_MAX = 2000
// a summary title and a result are kept to this many characters
export const SUMMARY_TITLE_MAX = 20
export const RESULT_MAX = 40
// the reply's token cap: one short line
export const SUMMARY_TOKENS = 100

export let SUMMARY_SYSTEM: string
localized(() => {
  SUMMARY_SYSTEM = t('sum.system')
})

// a text cut to SUMMARY_INPUT_MAX characters
export const clipInput = (text: string): string => [...text].slice(0, SUMMARY_INPUT_MAX).join('')

// What a request came to, from its prompt, its plan's subtasks when it has one, and the answer
// of the turn it was done in.
export const resultAsk = (prompt: string, answer: string, subtasks: readonly string[] = []): string =>
  t('sum.result', {
    max: RESULT_MAX,
    prompt: clipInput(prompt),
    subtasks: subtasks.length === 0 ? '' : t('sum.subtasks', { list: clipInput(subtasks.map(s => `- ${s}`).join('\n')) }),
    answer: clipInput(answer),
  })

// quotes and brackets around a reply, and a full stop after it
const WRAPS = /^["'「『“‘]+|["'」』”’]+$/g
const STOP = /[。.]+$/

// symbols that take two cells in an East Asian terminal, and the plain ones that stand in for them
const WIDE: [RegExp, string][] = [
  [/→/g, '->'],
  [/×/g, 'x'],
  [/[—–]/g, '-'],
  [/[‘’]/g, "'"],
  [/[“”]/g, '"'],
]

// phrases of the asks and their system prompts, which a summary never carries but a reply
// repeating the instructions back does
const ECHOES = [/請求的結果或結論/, /個字寫出/, /只回(?:那)?[一兩]行/, /第[一二]行[:：]/, /一行摘要/, /不加(?:引號|句號)/]
// the same, of the English asks; looked for only under the English locale
const ECHOES_EN = [/result or conclusion of this request/i, /in at most \d+ characters/i, /reply with only (?:that )?(?:one|two) lines?/i, /^line [12]:/i, /one-line summary/i, /no (?:quotes|trailing period)/i]

// Whether a reply repeats the instructions back instead of following them.
const echoesAsk = (text: string): boolean => ECHOES.some(p => p.test(text)) || (locale() === 'en' && ECHOES_EN.some(p => p.test(text)))

// A reply as one line: its first non-blank line, unwrapped, cut to `max` characters; '' when
// it repeats the instructions back.
export function cleanSummary(text: string, max: number): string {
  const plain = WIDE.reduce((t, [from, to]) => t.replace(from, to), text)
  const line = lineOf(plain, Number.MAX_SAFE_INTEGER).replace(STOP, '').replace(WRAPS, '').replace(STOP, '').trim()
  return echoesAsk(line) ? '' : lineOf(line, max)
}

// a new topic's title is kept to this many characters
export const TOPIC_TITLE_MAX = 16

export let CLASSIFY_SYSTEM: string
localized(() => {
  CLASSIFY_SYSTEM = t('cls.system')
})

// the request sent before this one: its title, and its topic once placed
export type LastAsk = { title: string; topic?: string }

// What a request asks for and which topic it belongs to, from the topics offered and the
// request before it; a short request is told to follow the one before.
export const classifyAsk = (prompt: string, candidates: readonly TopicCandidate[], last?: LastAsk): string => {
  const topics = candidates.length === 0 ? t('cls.noTopics') : candidates.map(c => t('cls.topic', c)).join('\n')
  const lastLine =
    last === undefined
      ? ''
      : t('cls.last', {
          title: last.title,
          topic: last.topic !== undefined && candidates.some(c => c.id === last.topic) ? t('cls.lastTopic', { id: last.topic }) : '',
        })
  return [
    t('cls.title', { max: SUMMARY_TITLE_MAX }),
    t('cls.which'),
    '',
    t('cls.twoLines'),
    t('cls.line1'),
    t('cls.line2', { max: TOPIC_TITLE_MAX }),
    t('cls.short'),
    '',
    t('cls.topics', { topics }),
    '',
    t('cls.request', { last: lastLine, prompt: clipInput(prompt) }),
  ].join('\n')
}

// a topic number as the small model may write it, alone or ahead of the topic's title
const TOPIC_NO = /^(?:話題\s*)?(\d+)(?:$|[\s（(:：])/
// the word that opens a new topic, and what may sit between it and the title
const NEW_TOPIC = /^新(?:話題)?[\s:：]*/
// the same as the small model writes them in English; read only under the English locale
const TOPIC_NO_EN = /^(?:topic\s*#?\s*)?(\d+)(?:$|[\s（(:：])/i
const NEW_TOPIC_EN = /^new(?:\s+topic)?\b[\s:：]*/i
// full-width digits as their ASCII ones
const asciiDigits = (text: string): string => text.replace(/[０-９]/g, d => String.fromCharCode(d.charCodeAt(0) - 0xfee0))

// The small model's two lines: the request's title, and the offered topic it names or the new
// one it titles; a new topic with no usable title takes the request's ('' when that is blank too).
export function parseClassify(reply: string, candidates: readonly TopicCandidate[]): { title: string; choice: TopicChoice } {
  const lines = reply.split('\n').filter(l => l.trim() !== '')
  const title = cleanSummary(lines[0] ?? '', SUMMARY_TITLE_MAX)
  const second = cleanSummary(lines[1] ?? '', Number.MAX_SAFE_INTEGER)
  const en = locale() === 'en'
  const digits = asciiDigits(second)
  const no = TOPIC_NO.exec(digits)?.[1] ?? (en ? TOPIC_NO_EN.exec(digits)?.[1] : undefined)
  const hit = no === undefined ? undefined : candidates.find(c => c.id === no)
  if (hit) return { title, choice: { kind: 'join', id: hit.id, title: hit.title } }
  const opener = NEW_TOPIC.test(second) ? NEW_TOPIC : en && NEW_TOPIC_EN.test(second) ? NEW_TOPIC_EN : undefined
  const named = opener ? cleanSummary(second.replace(opener, ''), TOPIC_TITLE_MAX) : ''
  return { title, choice: { kind: 'new', title: named !== '' ? named : title } }
}
