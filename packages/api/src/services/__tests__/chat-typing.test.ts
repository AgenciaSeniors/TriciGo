import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';

// A small stand-in for the realtime client, with the behavior this suite relies
// on (realtime-js 2.99.1): channel() reuses a channel with the same topic, a
// channel leaves getChannels() once it is unsubscribed, and setAuth() resolves
// later.
interface FakeChannel {
  topic: string;
  params: { config?: Record<string, unknown> };
  on: Mock<(...args: unknown[]) => FakeChannel>;
  subscribe: Mock<(...args: unknown[]) => FakeChannel>;
  unsubscribe: Mock<() => Promise<string>>;
  send: Mock<(...args: unknown[]) => Promise<string>>;
  track: Mock<(...args: unknown[]) => Promise<string>>;
  presenceState: () => Record<string, unknown>;
}

let channels: FakeChannel[];
let resolveAuth: () => void;
let rejectAuth: (e: unknown) => void;
const setAuth = vi.fn(
  () =>
    new Promise<void>((resolve, reject) => {
      resolveAuth = resolve;
      rejectAuth = reject;
    }),
);

function makeChannel(name: string, params: { config?: Record<string, unknown> } = {}): FakeChannel {
  const topic = `realtime:${name}`;
  const existing = channels.find((c) => c.topic === topic);
  if (existing) return existing;
  const chan: FakeChannel = {
    topic,
    params,
    on: vi.fn(() => chan),
    subscribe: vi.fn(() => chan),
    unsubscribe: vi.fn(() => {
      channels = channels.filter((c) => c !== chan);
      return Promise.resolve('ok');
    }),
    send: vi.fn(() => Promise.resolve('ok')),
    track: vi.fn(() => Promise.resolve('ok')),
    presenceState: () => ({}),
  };
  channels.push(chan);
  return chan;
}

const mockSupabase = {
  channel: vi.fn(makeChannel),
  getChannels: () => channels,
  realtime: { setAuth },
};

vi.mock('../../client', () => ({ getSupabaseClient: () => mockSupabase }));

import { chatService } from '../chat.service';

const RIDE = '11111111-1111-4111-8111-111111111111';
const ME = '22222222-2222-4222-8222-222222222222';

beforeEach(() => {
  channels = [];
  vi.clearAllMocks();
});

const flush = () => new Promise((r) => setTimeout(r, 0));

describe('chatService typing channel — private, only for the ride parties', () => {
  it('joins typing:<ride> as a private channel, after the session is attached', async () => {
    const chan = chatService.subscribeToTyping(RIDE, ME, vi.fn()) as unknown as FakeChannel;

    expect(mockSupabase.channel).toHaveBeenCalledWith(`typing:${RIDE}`, {
      config: { private: true, presence: { key: ME } },
    });
    // Not before setAuth: a private join without the user's JWT is refused.
    expect(chan.subscribe).not.toHaveBeenCalled();

    resolveAuth();
    await flush();
    expect(chan.subscribe).toHaveBeenCalledTimes(1);
  });

  it('does not join if the screen already left before the session was attached', async () => {
    const chan = chatService.subscribeToTyping(RIDE, ME, vi.fn()) as unknown as FakeChannel;
    await chan.unsubscribe();

    resolveAuth();
    await flush();
    expect(chan.subscribe).not.toHaveBeenCalled();
  });

  it('gives up quietly when the session cannot be attached', async () => {
    const chan = chatService.subscribeToTyping(RIDE, ME, vi.fn()) as unknown as FakeChannel;

    rejectAuth(new Error('no session'));
    await flush();
    expect(chan.subscribe).not.toHaveBeenCalled();
  });

  it('announces presence once joined, when the caller wants presence', async () => {
    const chan = chatService.subscribeToTyping(RIDE, ME, vi.fn(), vi.fn()) as unknown as FakeChannel;
    resolveAuth();
    await flush();

    const onStatus = chan.subscribe.mock.calls[0]?.[0] as (s: string) => void;
    onStatus('SUBSCRIBED');
    expect(chan.track).toHaveBeenCalledWith({ user_id: ME });
  });

  it('broadcasting without an open channel uses a private one too', async () => {
    chatService.broadcastTyping(RIDE, ME);

    expect(mockSupabase.channel).toHaveBeenCalledWith(`typing:${RIDE}`, { config: { private: true } });
    const chan = channels[0]!;
    expect(chan.send).toHaveBeenCalledWith({
      type: 'broadcast',
      event: 'typing',
      payload: { user_id: ME },
    });
  });

  it('broadcasting reuses the channel the chat screen already opened', async () => {
    const opened = chatService.subscribeToTyping(RIDE, ME, vi.fn()) as unknown as FakeChannel;
    mockSupabase.channel.mockClear();

    chatService.broadcastTyping(RIDE, ME);

    expect(mockSupabase.channel).not.toHaveBeenCalled();
    expect(opened.send).toHaveBeenCalledTimes(1);
  });
});
