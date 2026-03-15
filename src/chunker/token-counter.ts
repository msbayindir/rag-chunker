/** Approximates token count as chars / 4 (no tokenizer dependency). */
export function countTokens(text: string): number {
  return Math.ceil(text.length / 4)
}
