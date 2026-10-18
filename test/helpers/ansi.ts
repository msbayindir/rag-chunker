/** Removes ANSI colour codes (CI forces colours on). */
export function stripAnsi(text: string): string {
  return text.replace(/\u001b\[[0-9;]*m/g, '')
}
