/** Tiny class-name joiner — enough for this codebase, no dependency needed. */
export function cn(
  ...values: Array<string | false | null | undefined>
): string {
  return values.filter(Boolean).join(" ");
}
