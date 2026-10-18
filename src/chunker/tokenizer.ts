import { countTokens as o200kCount, decode as o200kDecode, encode as o200kEncode } from 'gpt-tokenizer'

export interface Tokenizer {
  readonly name: 'o200k' | 'estimate'
  count(text: string): number
  /** Returns the longest prefix of `text` that fits in `maxTokens`. */
  truncate(text: string, maxTokens: number): string
}

/**
 * Documents may contain strings such as "<|im_start|>" or "<|endoftext|>" (papers about LLMs, chat
 * logs). They are ordinary text here, so special-token checks are switched off.
 */
const PLAIN_TEXT = { disallowedSpecial: new Set<string>() }

const o200k: Tokenizer = {
  name: 'o200k',
  count(text) {
    if (text.length === 0) return 0
    return o200kCount(text, PLAIN_TEXT)
  },
  truncate(text, maxTokens) {
    if (maxTokens <= 0) return ''
    const ids = o200kEncode(text, PLAIN_TEXT)
    if (ids.length <= maxTokens) return text
    return o200kDecode(ids.slice(0, maxTokens))
  },
}

/** ~3.5 characters per token: closer than chars/4 for Turkish and other non-English text. */
const CHARS_PER_TOKEN = 3.5

const estimate: Tokenizer = {
  name: 'estimate',
  count(text) {
    return Math.ceil(text.length / CHARS_PER_TOKEN)
  },
  truncate(text, maxTokens) {
    if (maxTokens <= 0) return ''
    return text.slice(0, Math.floor(maxTokens * CHARS_PER_TOKEN))
  },
}

export function getTokenizer(name: 'o200k' | 'estimate' = 'o200k'): Tokenizer {
  return name === 'estimate' ? estimate : o200k
}
