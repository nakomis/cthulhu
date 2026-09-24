import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from './App.js';
import type { PrinterView } from './api.js';

const view = (
  overrides: Partial<PrinterView['print']> = {},
  rest: Partial<PrinterView> = {},
): PrinterView => ({
  connected: true,
  address: '172.29.0.50',
  mainboardId: 'mb',
  machineStatus: [1],
  print: {
    status: 3,
    statusLabel: 'Exposing',
    filename: 'cthulhu.goo',
    currentLayer: 60,
    totalLayer: 120,
    progressPercent: 50,
    remainingMs: 7_500_000,
    errorNumber: 0,
    taskId: 't1',
    ...overrides,
  },
  releaseFilmState: 1,
  attributes: { machineName: 'ELEGOO Mars 5 Ultra' },
  updatedAt: new Date().toISOString(),
  ...rest,
});

afterEach(() => vi.restoreAllMocks());

describe('dashboard', () => {
  it('renders live status, layer and ETA', async () => {
    render(<App fetchStatus={async () => view()} pollMs={100_000} />);

    expect(await screen.findByText('Exposing')).toBeInTheDocument();
    expect(screen.getByText('cthulhu.goo')).toBeInTheDocument();
    expect(screen.getByText('60 / 120')).toBeInTheDocument();
    expect(screen.getByText('2h 05m')).toBeInTheDocument();
  });

  it('shows a progress bar with accessible values', async () => {
    render(<App fetchStatus={async () => view()} pollMs={100_000} />);
    const bar = await screen.findByRole('progressbar');
    expect(bar).toHaveAttribute('aria-valuenow', '50');
  });

  it('surfaces release film health, which matters on an SLA machine', async () => {
    render(<App fetchStatus={async () => view({}, { releaseFilmState: 3 })} pollMs={100_000} />);
    expect(await screen.findByText('Check film (3)')).toBeInTheDocument();
  });

  it('shows disconnected rather than pretending all is well', async () => {
    render(<App fetchStatus={async () => view({}, { connected: false })} pollMs={100_000} />);
    expect(await screen.findByText(/disconnected/)).toBeInTheDocument();
  });

  it('shows an error when the API is unreachable', async () => {
    render(
      <App
        fetchStatus={async () => {
          throw new Error('boom');
        }}
        pollMs={100_000}
      />,
    );
    expect(await screen.findByRole('alert')).toHaveTextContent('boom');
  });

  it('does NOT stop the print when the confirmation is dismissed', async () => {
    // Stopping abandons hours of work; a mis-click must not do it.
    const confirmSpy = vi.spyOn(globalThis, 'confirm').mockReturnValue(false);
    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    render(<App fetchStatus={async () => view()} pollMs={100_000} />);
    await screen.findByText('Exposing');
    await userEvent.click(screen.getByRole('button', { name: 'Stop' }));

    expect(confirmSpy).toHaveBeenCalled();
    // Assert specifically that STOP was not requested. A bare
    // not.toHaveBeenCalled() is wrong now that the file list also fetches.
    expect(fetchSpy).not.toHaveBeenCalledWith('/api/control/stop', expect.anything());
  });

  it('stops when the confirmation is accepted', async () => {
    vi.spyOn(globalThis, 'confirm').mockReturnValue(true);
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('{}', { status: 200 }));

    render(<App fetchStatus={async () => view()} pollMs={100_000} />);
    await screen.findByText('Exposing');
    await userEvent.click(screen.getByRole('button', { name: 'Stop' }));

    await waitFor(() =>
      expect(fetchSpy).toHaveBeenCalledWith('/api/control/stop', expect.anything()),
    );
  });

  it('disables every control when nothing is printing', async () => {
    // Seen on the real printer: idle after a print, Resume was the one live
    // button - inviting a press that could only fail.
    render(
      <App fetchStatus={async () => view({ status: 0, statusLabel: 'Idle' })} pollMs={100_000} />,
    );
    await screen.findByText('Idle');
    expect(screen.getByRole('button', { name: 'Pause' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Resume' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Stop' })).toBeDisabled();
  });

  it('offers Resume and Stop, not Pause, when paused', async () => {
    render(
      <App fetchStatus={async () => view({ status: 6, statusLabel: 'Paused' })} pollMs={100_000} />,
    );
    await screen.findByText('Paused');
    expect(screen.getByRole('button', { name: 'Pause' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Resume' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Stop' })).toBeEnabled();
  });

  it('shows the logo in the header', async () => {
    const { container } = render(<App fetchStatus={async () => view()} pollMs={100_000} />);
    await screen.findByText('Cthulhu');
    expect(container.querySelector('header img')).toHaveAttribute('src', '/icon-192.png');
  });

  it("shows the printer's own thumbnail of the print", async () => {
    render(<App fetchStatus={async () => view({ taskId: 'task-9' })} pollMs={100_000} />);
    const img = await screen.findByRole('img', { name: 'Preview of the print' });
    expect(img).toHaveAttribute('src', '/api/print/thumbnail?task=task-9');
  });

  it('shows nothing, not a broken image, when there is no thumbnail', async () => {
    render(<App fetchStatus={async () => view({ taskId: 'task-9' })} pollMs={100_000} />);
    const img = await screen.findByRole('img', { name: 'Preview of the print' });
    img.dispatchEvent(new Event('error'));
    await waitFor(() =>
      expect(screen.queryByRole('img', { name: 'Preview of the print' })).not.toBeInTheDocument(),
    );
  });

  it('puts the camera straight after Status, above Progress and FEP Life', async () => {
    // Camera above the fold on a laptop; FEP Life, rarely needed, lower down.
    render(<App fetchStatus={async () => view()} pollMs={100_000} />);
    await screen.findByText('Status');
    const headings = screen
      .getAllByRole('heading', { level: 2 })
      .map((h) => h.textContent?.trim().toLowerCase());
    const at = (name: string) => headings.indexOf(name);
    expect(at('status')).toBeLessThan(at('camera'));
    expect(at('camera')).toBeLessThan(at('progress'));
    expect(at('progress')).toBeLessThan(at('fep life'));
  });

  it('shows the layer being printed inside the Status box, beside the preview', async () => {
    URL.createObjectURL = () => 'blob:layer';
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async () => new Response(new Blob([new Uint8Array([137, 80])])));
    render(
      <App
        fetchStatus={async () => view({ taskId: 't9', status: 3, currentLayer: 9, totalLayer: 20 })}
        pollMs={100_000}
      />,
    );
    const layer = await screen.findByRole('img', { name: 'Layer 10 of the print' });
    const status = screen.getByText('Status').closest('section');
    expect(status).toContainElement(layer);
    expect(status).toContainElement(screen.getByRole('img', { name: 'Preview of the print' }));
    fetchSpy.mockRestore();
  });

  it('shows release film wear against its rated life', async () => {
    render(
      <App
        fetchStatus={async () => view({}, { releaseFilmUses: 1000, releaseFilmMax: 60000 })}
        pollMs={100_000}
      />,
    );
    expect(await screen.findByText('1,000 / 60,000 layers (2%)')).toBeInTheDocument();
    expect(screen.getByText('Healthy')).toBeInTheDocument();
  });
});
