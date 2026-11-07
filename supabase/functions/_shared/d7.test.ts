import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { sendSmsViaD7 } from './d7.ts';

// Runs the real sender. Replaced: Deno (its env) and fetch, which records what D7 would receive.
const env: Record<string, string> = { D7_API_TOKEN: 'd7-test', D7_SENDER_ID: 'TriciGo' };
const fetchMock = vi.fn();

beforeEach(() => {
  vi.stubGlobal('Deno', { env: { get: (name: string) => env[name] } });
  vi.stubGlobal('fetch', fetchMock);
  fetchMock.mockReset();
  fetchMock.mockImplementation(async () => new Response(JSON.stringify({ request_id: 'req-1' }), { status: 200 }));
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

/** The message D7 received. */
const sentMessage = () => JSON.parse(String(fetchMock.mock.calls[0][1].body)).messages[0];

describe('sendSmsViaD7 data coding', () => {
  it('is unicode with no options', async () => {
    await sendSmsViaD7('+5355512345', 'Tu código');
    expect(sentMessage().data_coding).toBe('unicode');
  });

  it('is unicode when the options do not ask for anything else', async () => {
    await sendSmsViaD7('+5355512345', 'Tu código', { eventType: 'otp' });
    expect(sentMessage().data_coding).toBe('unicode');
  });

  it('is text when the caller asks for it', async () => {
    await sendSmsViaD7('+5355512345', 'TriciGo: una flota te espera', { dataCoding: 'text' });
    expect(sentMessage().data_coding).toBe('text');
  });

  it('is unicode when the caller asks for that', async () => {
    await sendSmsViaD7('+5355512345', 'Tu código', { dataCoding: 'unicode' });
    expect(sentMessage().data_coding).toBe('unicode');
  });

  it('changes nothing else in the message', async () => {
    await sendSmsViaD7('+5355512345', 'TriciGo: una flota te espera', { dataCoding: 'text' });
    expect(sentMessage()).toEqual({
      channel: 'sms',
      recipients: ['+5355512345'],
      content: 'TriciGo: una flota te espera',
      msg_type: 'text',
      data_coding: 'text',
    });
  });
});
