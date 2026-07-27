// ============================================================
// TriciGo — Chat Types
// ============================================================

export interface ChatMessage {
  id: string;
  ride_id: string;
  sender_id: string;
  body: string;
  created_at: string;
  /** When the RECIPIENT opened the chat and saw this message (00516).
   *  Null while unread. Drives both the sender's double check and the
   *  recipient's unread badge, so the two can no longer disagree.
   *  Null on rows created before the migration. */
  read_at?: string | null;
}
