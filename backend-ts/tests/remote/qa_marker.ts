/** Test-model marker parser: harness context precedes the person's words in a single user part.
 * Match an explicit marker line, never a global call counter or a prefix of the whole prompt. */
export function qaMarker(texts: string[]): string {
  return texts.flatMap((text) => text.split('\n')).filter((line) => /^QA_[A-Z_]+(?:\s|$)/.test(line)).at(-1) ?? ''
}
