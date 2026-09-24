import { render, screen, waitFor } from '@testing-library/react';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { Layer } from './Layer.js';

const png = () =>
  new Response(new Blob([new Uint8Array([137, 80, 78, 71])], { type: 'image/png' }));

// jsdom has no object URLs; the component needs only distinct strings.
beforeAll(() => {
  let n = 0;
  URL.createObjectURL = vi.fn(() => {
    n += 1;
    return `blob:layer-${n}`;
  });
  URL.revokeObjectURL = vi.fn();
});

describe('Layer', () => {
  it('shows the layer being printed, numbered from 1', async () => {
    const fetchLayer = vi.fn(async () => png());
    render(<Layer layer={372} totalLayer={893} fetchLayer={fetchLayer} />);
    expect(await screen.findByRole('img', { name: 'Layer 373 of the print' })).toBeInTheDocument();
    expect(screen.getByText('printing 373 of 893')).toBeInTheDocument();
    expect(fetchLayer).toHaveBeenCalledWith(372);
  });

  it('says it is fetching the print file, and how far it has got', async () => {
    const fetchLayer = vi.fn(async () =>
      Response.json({ state: 'downloading', received: 4, total: 10 }, { status: 202 }),
    );
    render(<Layer layer={0} totalLayer={10} fetchLayer={fetchLayer} />);
    expect(await screen.findByRole('status')).toHaveTextContent(
      'Fetching the print file from the printer… 40%',
    );
  });

  it('keeps the old layer on screen until the next one has arrived', async () => {
    let release: (r: Response) => void = () => {};
    const fetchLayer = vi
      .fn<(layer: number) => Promise<Response>>()
      .mockImplementationOnce(async () => png())
      .mockImplementationOnce(() => new Promise<Response>((r) => (release = r)));
    const { rerender } = render(<Layer layer={4} totalLayer={10} fetchLayer={fetchLayer} />);
    await screen.findByRole('img', { name: 'Layer 5 of the print' });

    rerender(<Layer layer={5} totalLayer={10} fetchLayer={fetchLayer} />);
    // Still layer 5's picture while layer 6 is on its way - no blank flash.
    expect(screen.getByRole('img', { name: 'Layer 5 of the print' })).toBeInTheDocument();
    release(png());
    await screen.findByRole('img', { name: 'Layer 6 of the print' });
  });

  it('says so when the print has no layer image', async () => {
    const fetchLayer = vi.fn(async () => new Response('', { status: 502 }));
    render(<Layer layer={0} totalLayer={10} fetchLayer={fetchLayer} />);
    await waitFor(() =>
      expect(screen.getByRole('status')).toHaveTextContent('No layer image for this print.'),
    );
  });
});
