import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { Layer, LIGHTBOX_SCALE } from './Layer.js';

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

  it('opens the layer it is showing, larger, with a link to every pixel', async () => {
    let release: (r: Response) => void = () => {};
    const fetchLayer = vi
      .fn<(layer: number, scale?: number) => Promise<Response>>()
      .mockImplementationOnce(async () => png())
      .mockImplementationOnce(() => new Promise<Response>((r) => (release = r)));
    render(<Layer layer={372} totalLayer={893} fetchLayer={fetchLayer} />);
    const thumb = await screen.findByRole('img', { name: 'Layer 373 of the print' });

    await userEvent.click(
      screen.getByRole('button', { name: 'Show layer 373 of the print full size' }),
    );
    expect(fetchLayer).toHaveBeenLastCalledWith(372, LIGHTBOX_SCALE);
    const dialog = screen.getByRole('dialog', { name: 'Layer 373 of the print' });
    expect(dialog).toHaveAccessibleDescription('Layer 373 of 893');

    // The small one stands in while the big one renders: never a blank box.
    const standIn = screen.getByRole('img', {
      name: 'Layer 373 of the print, small while the full size loads',
    });
    expect(standIn).toHaveAttribute('src', thumb.getAttribute('src'));
    expect(screen.getByText('Loading the full-size layer…')).toBeInTheDocument();

    release(png());
    const big = await screen.findByRole('img', { name: 'Layer 373 of the print, full size' });
    expect(big).toHaveAttribute('data-scale', String(LIGHTBOX_SCALE));
    expect(big.getAttribute('src')).not.toBe(thumb.getAttribute('src'));
    expect(screen.queryByText('Loading the full-size layer…')).not.toBeInTheDocument();

    const link = screen.getByRole('link', { name: 'Open full resolution' });
    expect(link).toHaveAttribute('href', '/api/print/layer?layer=372&scale=1');
    expect(link).toHaveAttribute('target', '_blank');
  });

  it('holds the opened layer still while the print moves on', async () => {
    const fetchLayer = vi.fn(async (_layer: number, _scale?: number) => png());
    const { rerender } = render(<Layer layer={4} totalLayer={10} fetchLayer={fetchLayer} />);
    await screen.findByRole('img', { name: 'Layer 5 of the print' });
    await userEvent.click(
      screen.getByRole('button', { name: 'Show layer 5 of the print full size' }),
    );
    await waitFor(() => expect(fetchLayer).toHaveBeenLastCalledWith(4, LIGHTBOX_SCALE));

    rerender(<Layer layer={5} totalLayer={10} fetchLayer={fetchLayer} />);
    await waitFor(() => expect(fetchLayer).toHaveBeenLastCalledWith(5));
    expect(screen.getByRole('dialog', { name: 'Layer 5 of the print' })).toBeInTheDocument();
    expect(fetchLayer).not.toHaveBeenCalledWith(5, LIGHTBOX_SCALE);
  });

  it('keeps the small layer up, and says why, when the big one cannot be had', async () => {
    const fetchLayer = vi
      .fn<(layer: number, scale?: number) => Promise<Response>>()
      .mockImplementationOnce(async () => png())
      .mockImplementationOnce(async () => new Response('', { status: 502 }));
    render(<Layer layer={0} totalLayer={10} fetchLayer={fetchLayer} />);
    await screen.findByRole('img', { name: 'Layer 1 of the print' });
    await userEvent.click(
      screen.getByRole('button', { name: 'Show layer 1 of the print full size' }),
    );
    expect(await screen.findByText('The full-size layer is not available.')).toBeInTheDocument();
    expect(
      screen.getByRole('img', { name: 'Layer 1 of the print, small while the full size loads' }),
    ).toBeInTheDocument();
  });

  it('waits, saying so, while the print file is still coming from the printer', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const fetchLayer = vi
        .fn<(layer: number, scale?: number) => Promise<Response>>()
        .mockImplementationOnce(async () => png())
        .mockImplementationOnce(async () =>
          Response.json({ state: 'downloading', received: 1, total: 2 }, { status: 202 }),
        )
        .mockImplementationOnce(async () => png());
      render(<Layer layer={0} totalLayer={10} fetchLayer={fetchLayer} />);
      await screen.findByRole('img', { name: 'Layer 1 of the print' });
      await userEvent.click(
        screen.getByRole('button', { name: 'Show layer 1 of the print full size' }),
      );
      expect(
        await screen.findByText('Fetching the print file from the printer…'),
      ).toBeInTheDocument();
      await vi.advanceTimersByTimeAsync(1500);
      const big = await screen.findByRole('img', { name: 'Layer 1 of the print, full size' });
      expect(big).toHaveAttribute('data-scale', String(LIGHTBOX_SCALE));
      expect(fetchLayer).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it('frees the big image when closed', async () => {
    const fetchLayer = vi.fn(async (_layer: number, _scale?: number) => png());
    render(<Layer layer={0} totalLayer={10} fetchLayer={fetchLayer} />);
    await screen.findByRole('img', { name: 'Layer 1 of the print' });
    await userEvent.click(
      screen.getByRole('button', { name: 'Show layer 1 of the print full size' }),
    );
    const big = await screen.findByRole('img', { name: 'Layer 1 of the print, full size' });
    await waitFor(() => expect(big).toHaveAttribute('data-scale', String(LIGHTBOX_SCALE)));
    const src = big.getAttribute('src');
    await userEvent.keyboard('{Escape}');
    expect(URL.revokeObjectURL).toHaveBeenCalledWith(src);
  });
});
