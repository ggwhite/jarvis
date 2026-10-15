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

export const SUMMARY_SYSTEM =
  '你替一個工作看板寫一行摘要。只回那一行繁體中文：不加引號、不加句號、不加「標題：」之類的前綴，也不解釋，也不用 → × — – 這類符號或彎引號。'

// a text cut to SUMMARY_INPUT_MAX characters
export const clipInput = (text: string): string => [...text].slice(0, SUMMARY_INPUT_MAX).join('')

// What a request asks for, the words its title is made from.
export const titleAsk = (prompt: string): string =>
  `用不超過 ${SUMMARY_TITLE_MAX} 個字寫出這個請求要做什麼，動詞開頭，例如「計算 7*6」「解釋 CAS」「修 jarvis 的高亮」。\n\n請求：\n${clipInput(prompt)}`

// What a request came to, from its prompt, its plan's subtasks when it has one, and the answer
// of the turn it was done in.
export const resultAsk = (prompt: string, answer: string, subtasks: readonly string[] = []): string =>
  `用不超過 ${RESULT_MAX} 個字寫出這個請求的結果或結論，例如「42」「比較後交換的無鎖原子更新」「已合併進 master」。\n\n請求：\n${clipInput(prompt)}${
    subtasks.length === 0 ? '' : `\n\n細項：\n${clipInput(subtasks.map(t => `- ${t}`).join('\n'))}`
  }\n\n回答：\n${clipInput(answer)}`

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

// A reply as one line: its first non-blank line, unwrapped, cut to `max` characters.
export function cleanSummary(text: string, max: number): string {
  const plain = WIDE.reduce((t, [from, to]) => t.replace(from, to), text)
  const line = lineOf(plain, Number.MAX_SAFE_INTEGER).replace(STOP, '').replace(WRAPS, '').replace(STOP, '').trim()
  return lineOf(line, max)
}

// a new topic's title is kept to this many characters
export const TOPIC_TITLE_MAX = 16

export const CLASSIFY_SYSTEM =
  '你替一個工作看板整理請求。照指示的行數回繁體中文：不加引號、不加句號、不加「標題：」之類的前綴，也不解釋，也不用 → × — – 這類符號或彎引號。'

// the request sent before this one: its title, and its topic once placed
export type LastAsk = { title: string; topic?: string }

// What a request asks for and which topic it belongs to, from the topics offered and the
// request before it; a short request is told to follow the one before.
export const classifyAsk = (prompt: string, candidates: readonly TopicCandidate[], last?: LastAsk): string => {
  const topics = candidates.length === 0 ? '（還沒有）' : candidates.map(c => `${c.id} ${c.title}（最近的請求：${c.latest}）`).join('\n')
  const lastLine =
    last === undefined
      ? ''
      : `上一個請求：${last.title}${last.topic !== undefined && candidates.some(c => c.id === last.topic) ? `（話題 ${last.topic}）` : ''}\n\n`
  return [
    `用不超過 ${SUMMARY_TITLE_MAX} 個字寫出這個請求要做什麼，動詞開頭，例如「計算 7*6」「解釋 CAS」「修 jarvis 的高亮」。`,
    '再判斷它屬於下面哪個話題。',
    '',
    '只回兩行：',
    '第一行：請求標題。',
    `第二行：屬於既有話題就回話題編號（只回數字）；都不屬於就回「新 」加上不超過 ${TOPIC_TITLE_MAX} 個字的話題名稱，例如「新 Jamie 七日簽到累計充值」。`,
    '很短的請求（例如「確認送出」「好」「1」「push」）通常接續前一個請求的話題。',
    '',
    `既有話題（最近活動的在前）：\n${topics}`,
    '',
    `${lastLine}請求：\n${clipInput(prompt)}`,
  ].join('\n')
}

// a topic number as the small model may write it
const TOPIC_NO = /^(?:話題\s*)?(\d+)$/
// the word that opens a new topic, and what may sit between it and the title
const NEW_TOPIC = /^新[\s:：]*/

// The small model's two lines: the request's title, and the offered topic it names or the new
// one it titles; a new topic with no usable title takes the request's ('' when that is blank too).
export function parseClassify(reply: string, candidates: readonly TopicCandidate[]): { title: string; choice: TopicChoice } {
  const lines = reply.split('\n').filter(l => l.trim() !== '')
  const title = cleanSummary(lines[0] ?? '', SUMMARY_TITLE_MAX)
  const second = cleanSummary(lines[1] ?? '', Number.MAX_SAFE_INTEGER)
  const no = TOPIC_NO.exec(second)?.[1]
  const hit = no === undefined ? undefined : candidates.find(c => c.id === no)
  if (hit) return { title, choice: { kind: 'join', id: hit.id, title: hit.title } }
  const named = NEW_TOPIC.test(second) ? cleanSummary(second.replace(NEW_TOPIC, ''), TOPIC_TITLE_MAX) : ''
  return { title, choice: { kind: 'new', title: named !== '' ? named : title } }
}
