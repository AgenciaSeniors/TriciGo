/**
 * Who a screen reader names as the author of a chat message: the first name of
 * the other person, or `fallback` while their name is unknown. The chat used to
 * announce the driver's messages as "Chat con conductor dijo: …" (QA R2-14).
 */
export function chatSenderName(fullName: string | null | undefined, fallback: string): string {
  return fullName?.trim().split(/\s+/)[0] || fallback;
}
