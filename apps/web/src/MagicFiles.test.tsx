import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { MagicFileEntry } from './api.js';
import { MagicFiles } from './MagicFiles.js';

const entry = (overrides: Partial<MagicFileEntry> = {}): MagicFileEntry => ({
  id: 'zoff',
  name: 'Z-offset',
  filename: 'zoff-3.2mm.gcode',
  description: '+3.2 mm on Elegoo defaults',
  available: true,
  ...overrides,
});

describe('MagicFiles', () => {
  it('lists the entries the server offers', async () => {
    const listMagicFiles = async () => [
      entry(),
      entry({
        id: 'reset',
        name: 'Reset Z-offset',
        filename: 'zoff-reset.gcode',
        description: 'Elegoo defaults',
      }),
    ];
    render(<MagicFiles listMagicFiles={listMagicFiles} />);
    expect(await screen.findByText('Z-offset')).toBeInTheDocument();
    expect(screen.getByText('Reset Z-offset')).toBeInTheDocument();
    expect(screen.getByText(/zoff-3\.2mm\.gcode/)).toBeInTheDocument();
  });

  it('renders nothing before the list has loaded', () => {
    render(<MagicFiles listMagicFiles={() => new Promise(() => {})} />);
    expect(screen.queryByText('Magic Files')).not.toBeInTheDocument();
  });

  it('sends the chosen entry and reports the touchscreen steps, including that the file list will not show it', async () => {
    const sendMagicFile = vi.fn().mockResolvedValue({ filename: 'zoff-3.2mm.gcode', size: 900 });
    render(<MagicFiles listMagicFiles={async () => [entry()]} sendMagicFile={sendMagicFile} />);
    await screen.findByText('Z-offset');

    await userEvent.click(screen.getByRole('button', { name: 'Send to printer' }));
    await waitFor(() => expect(sendMagicFile).toHaveBeenCalledWith('zoff'));

    const status = await screen.findByRole('status');
    expect(status).toHaveTextContent('Sent zoff-3.2mm.gcode');
    expect(status).toHaveTextContent('Print → zoff-3.2mm');
    expect(status).toHaveTextContent('power-cycle');
    expect(status).toHaveTextContent('region and Wi-Fi');
    expect(status).toHaveTextContent('network file list');
  });

  it('disables the button, with the reason, when an entry is unavailable', async () => {
    render(
      <MagicFiles
        listMagicFiles={async () => [
          entry({ available: false, reason: 'PLATE_Z_OFFSET_MM is not configured' }),
        ]}
      />,
    );
    await screen.findByText('Z-offset');
    const button = screen.getByRole('button', { name: 'Send to printer' });
    expect(button).toBeDisabled();
    expect(screen.getByText(/PLATE_Z_OFFSET_MM is not configured/)).toBeInTheDocument();
  });

  it('disables every row while one is sending', async () => {
    let resolveSend: (value: { filename: string; size: number }) => void = () => {};
    const sendMagicFile = vi.fn(
      () =>
        new Promise<{ filename: string; size: number }>((resolve) => {
          resolveSend = resolve;
        }),
    );
    render(
      <MagicFiles
        listMagicFiles={async () => [
          entry(),
          entry({ id: 'reset', name: 'Reset Z-offset', filename: 'zoff-reset.gcode' }),
        ]}
        sendMagicFile={sendMagicFile}
      />,
    );
    await screen.findByText('Z-offset');

    const buttons = screen.getAllByRole('button', { name: /Send to printer|Sending…/ });
    await userEvent.click(buttons[0] as HTMLElement);

    await waitFor(() => {
      for (const b of screen.getAllByRole('button', { name: /Send to printer|Sending…/ })) {
        expect(b).toBeDisabled();
      }
    });

    resolveSend({ filename: 'zoff-3.2mm.gcode', size: 900 });
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Sent'));
  });

  it('reports a send failure rather than silently doing nothing', async () => {
    const sendMagicFile = vi.fn().mockRejectedValue(new Error('No printer address'));
    render(<MagicFiles listMagicFiles={async () => [entry()]} sendMagicFile={sendMagicFile} />);
    await screen.findByText('Z-offset');

    await userEvent.click(screen.getByRole('button', { name: 'Send to printer' }));
    expect(await screen.findByRole('status')).toHaveTextContent('No printer address');
  });

  it('has no Upload or Delete controls - these files are server-generated, not user-supplied', async () => {
    render(<MagicFiles listMagicFiles={async () => [entry()]} />);
    await screen.findByText('Z-offset');
    expect(screen.queryByRole('button', { name: 'Upload' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Delete/ })).not.toBeInTheDocument();
  });
});
