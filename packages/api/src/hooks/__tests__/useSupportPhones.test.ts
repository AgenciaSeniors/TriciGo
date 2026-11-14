// @vitest-environment jsdom
// ============================================================
// TriciGo — useSupportPhones: the help screens show the numbers set in
// platform_config, and never an empty list while they load.
// Rendered with react-dom in jsdom; only the read of the numbers is faked.
// ============================================================

import { describe, it, expect, vi, afterEach } from 'vitest';

const getWhatsAppPhones = vi.fn<() => Promise<string[]>>();

vi.mock('../../services/support.service', () => ({
  supportService: { getWhatsAppPhones: () => getWhatsAppPhones() },
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const BUILT_IN = ['+5355159376', '+5354269290'];

type Unmount = () => void;
const mounted: Unmount[] = [];

afterEach(() => {
  mounted.splice(0).forEach((unmount) => unmount());
  getWhatsAppPhones.mockReset();
});

function deferred() {
  let resolve!: (phones: string[]) => void;
  const promise = new Promise<string[]>((r) => { resolve = r; });
  return { promise, resolve };
}

// A fresh copy of the hook module (its cache starts empty), loaded together with the
// React it renders with, so both share one React instance.
async function load() {
  vi.resetModules();
  const React = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { useSupportPhones } = await import('../useSupportPhones');

  async function mount(): Promise<string[][]> {
    const seen: string[][] = [];
    function Probe() {
      seen.push(useSupportPhones());
      return null;
    }
    const root = createRoot(document.createElement('div'));
    await React.act(async () => { root.render(React.createElement(Probe)); });
    mounted.push(() => React.act(() => root.unmount()));
    return seen;
  }

  return { act: React.act, mount };
}

describe('useSupportPhones', () => {
  it('shows the built-in numbers until the configured ones arrive', async () => {
    const read = deferred();
    getWhatsAppPhones.mockReturnValueOnce(read.promise);
    const { act, mount } = await load();

    const seen = await mount();
    expect(seen[0]).toEqual(BUILT_IN);

    await act(async () => { read.resolve(['+5351234567']); });
    expect(seen.at(-1)).toEqual(['+5351234567']);
  });

  it('starts the next screen with the last numbers read, not the built-in ones', async () => {
    getWhatsAppPhones.mockResolvedValueOnce(['+5351234567']);
    const { mount } = await load();
    await mount();

    getWhatsAppPhones.mockReturnValueOnce(deferred().promise);
    const second = await mount();
    expect(second[0]).toEqual(['+5351234567']);
  });

  it('reads the numbers again on every screen, so a change in the panel shows up', async () => {
    getWhatsAppPhones.mockResolvedValueOnce(['+5351234567']);
    const { mount } = await load();
    await mount();

    getWhatsAppPhones.mockResolvedValueOnce(['+5361234567', '+5351234567']);
    const second = await mount();
    expect(second.at(-1)).toEqual(['+5361234567', '+5351234567']);
    expect(getWhatsAppPhones).toHaveBeenCalledTimes(2);
  });
});
