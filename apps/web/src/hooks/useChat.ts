'use client';

/**
 * Web parity of `apps/client/src/hooks/useChat.ts`.
 *
 * Wraps `chatService` from @tricigo/api (which already targets the
 * correct `ride_messages` table — the previous web chat page was
 * pointing at a non-existent `chat_messages` table) and adds the same
 * three robustness layers the mobile chat has:
 *
 *   1. **Polling fallback** (every 8s). Cuban networks drop Supabase
 *      realtime channels frequently (CHANNEL_ERROR loop). Without this,
 *      the receiver sees nothing until reload.
 *   2. **Offline outgoing queue** (localStorage). When the user types
 *      while offline (or while the server is unreachable), the message
 *      is queued + the bubble shows as "pendiente". On `online` event,
 *      the queue is drained.
 *   3. **Typing indicators** (broadcast, debounced 2s send / 3s clear).
 *
 * Adapter notes:
 *   - AsyncStorage in mobile → localStorage here.
 *   - NetInfo in mobile → `navigator.onLine` + `window.online` event.
 *   - Toast in mobile → caller decides (we surface a `pendingCount`).
 */
import { useEffect, useCallback, useRef, useState } from 'react';
import { chatService } from '@tricigo/api';
import type { ChatMessage } from '@tricigo/types';

const QUEUE_KEY = 'tricigo_chat_outgoing_queue';
const TYPING_TIMEOUT_MS = 3000;
const TYPING_DEBOUNCE_MS = 2000;
const POLL_INTERVAL_MS = 8000;

type QueuedMessage = {
  localId: string;
  rideId: string;
  senderId: string;
  body: string;
  attemptCount: number;
  queuedAt: number;
};

/** Optimistic UI marker — added to ChatMessage shape on the wire only. */
export type ChatMessageUI = ChatMessage & {
  _pending?: boolean;
  _failed?: boolean;
};

function readQueue(): QueuedMessage[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = window.localStorage.getItem(QUEUE_KEY);
    return raw ? (JSON.parse(raw) as QueuedMessage[]) : [];
  } catch {
    return [];
  }
}

function writeQueue(items: QueuedMessage[]): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(QUEUE_KEY, JSON.stringify(items));
  } catch {
    /* best effort — quota exceeded etc. */
  }
}

function enqueue(msg: QueuedMessage): void {
  const q = readQueue();
  q.push(msg);
  writeQueue(q);
}

function removeFromQueue(localId: string): void {
  const q = readQueue();
  writeQueue(q.filter((m) => m.localId !== localId));
}

export interface UseChatResult {
  messages: ChatMessageUI[];
  loading: boolean;
  remoteTyping: boolean;
  /** Does the other party currently have this chat open? Realtime presence —
   *  narrower than "is online", which is all it can honestly report. */
  remotePresent: boolean;
  sendMessage: (body: string) => Promise<void>;
  notifyTyping: () => void;
}

export function useChat(rideId: string | undefined, userId: string | null): UseChatResult {
  const [messages, setMessages] = useState<ChatMessageUI[]>([]);
  const [loading, setLoading] = useState(true);
  const [remoteTyping, setRemoteTyping] = useState(false);
  const [remotePresent, setRemotePresent] = useState(false);

  const messagesRef = useRef<ChatMessageUI[]>([]);
  const typingTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastTypingRef = useRef(0);

  // Keep ref in sync so callbacks read the latest snapshot without
  // re-binding on every state change.
  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);

  // ── Initial fetch + realtime subscribe + polling fallback ──
  useEffect(() => {
    if (!rideId || !userId) return;
    let cancelled = false;
    let msgChannel: ReturnType<typeof chatService.subscribeToMessages> | null = null;
    let typingChannel: ReturnType<typeof chatService.subscribeToTyping> | null = null;

    chatService
      .getMessages(rideId)
      .then((rows) => {
        if (cancelled) return;
        setMessages(rows);
        setLoading(false);
      })
      .catch(() => {
        if (!cancelled) setLoading(false);
      });

    msgChannel = chatService.subscribeToMessages(rideId, (msg) => {
      // Dedup by id — avoids the polling fallback double-inserting.
      setMessages((prev) => {
        if (prev.some((m) => m.id === msg.id)) return prev;
        return [...prev, msg];
      });
    });

    // Typing AND presence ride this one channel — a second channel per open
    // chat buys nothing that an already-subscribed one cannot report.
    typingChannel = chatService.subscribeToTyping(
      rideId,
      userId,
      () => {
        setRemoteTyping(true);
        if (typingTimeoutRef.current) clearTimeout(typingTimeoutRef.current);
        typingTimeoutRef.current = setTimeout(() => setRemoteTyping(false), TYPING_TIMEOUT_MS);
      },
      setRemotePresent,
    );

    // Polling fallback every 8s in case realtime drops silently.
    const pollInterval = window.setInterval(async () => {
      if (cancelled) return;
      try {
        const fresh = await chatService.getMessages(rideId);
        const existingIds = new Set(messagesRef.current.map((m) => m.id));
        const newMessages = fresh.filter((m) => !existingIds.has(m.id));
        if (newMessages.length > 0) {
          setMessages((prev) => [...prev, ...newMessages]);
        }
      } catch {
        /* network error — next interval will retry */
      }
    }, POLL_INTERVAL_MS);

    return () => {
      cancelled = true;
      msgChannel?.unsubscribe();
      typingChannel?.unsubscribe();
      window.clearInterval(pollInterval);
      if (typingTimeoutRef.current) clearTimeout(typingTimeoutRef.current);
    };
  }, [rideId, userId]);

  // ── Drain offline queue: on mount AND on the `online` event ──
  // The browser's 'online' only fires on an offline→online TRANSITION within
  // the same session: a page that loads already-online with a non-empty queue
  // (user sent without signal, closed the tab, reopened later) never received
  // it, so queued messages sat in localStorage forever. Draining on mount
  // closes that gap.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const drain = async () => {
      const q = readQueue();
      if (q.length === 0) return;
      for (const item of q) {
        try {
          const msg = await chatService.sendMessage(item.rideId, item.senderId, item.body);
          removeFromQueue(item.localId);
          // Replace the local pending bubble with the real server msg — but
          // ONLY when the queued item belongs to THIS ride. The queue is
          // global; injecting another ride's message into the open thread
          // showed a foreign bubble until reload.
          if (item.rideId !== rideId) continue;
          setMessages((prev) => {
            const without = prev.filter((m) => m.id !== item.localId);
            if (without.some((m) => m.id === msg.id)) return without;
            return [...without, msg];
          });
        } catch {
          // Still failing — bump attempt count and leave queued.
          const all = readQueue();
          writeQueue(all.map((m) => (m.localId === item.localId
            ? { ...m, attemptCount: m.attemptCount + 1 }
            : m)));
        }
      }
    };
    if (navigator.onLine) void drain();
    window.addEventListener('online', drain);
    return () => window.removeEventListener('online', drain);
  }, [rideId]);

  // ── Send (optimistic + queue on failure) ──
  const sendMessage = useCallback(async (body: string) => {
    if (!rideId || !userId || !body.trim()) return;
    const trimmed = body.trim();
    const localId = `local-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;

    // Optimistic insert.
    setMessages((prev) => [
      ...prev,
      {
        id: localId,
        ride_id: rideId,
        sender_id: userId,
        body: trimmed,
        created_at: new Date().toISOString(),
        _pending: true,
      },
    ]);

    try {
      const msg = await chatService.sendMessage(rideId, userId, trimmed);
      setMessages((prev) => {
        const without = prev.filter((m) => m.id !== localId);
        if (without.some((m) => m.id === msg.id)) return without;
        return [...without, msg];
      });
    } catch {
      enqueue({
        localId,
        rideId,
        senderId: userId,
        body: trimmed,
        attemptCount: 1,
        queuedAt: Date.now(),
      });
      // Keep the bubble visible with _pending so the user knows it's queued.
      setMessages((prev) => prev.map((m) => (m.id === localId ? { ...m, _pending: true } : m)));
    }
  }, [rideId, userId]);

  // ── Typing broadcast (debounced 2s) ──
  const notifyTyping = useCallback(() => {
    if (!rideId || !userId) return;
    const now = Date.now();
    if (now - lastTypingRef.current < TYPING_DEBOUNCE_MS) return;
    lastTypingRef.current = now;
    chatService.broadcastTyping(rideId, userId);
  }, [rideId, userId]);

  return { messages, loading, remoteTyping, remotePresent, sendMessage, notifyTyping };
}
