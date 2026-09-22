import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { Files } from './Files.js';

const listFiles = async () => [{ name: 'cthulhu.goo' }, { name: 'boots.ctb' }];

describe('Files', () => {
  it('lists the files on the printer', async () => {
    render(<Files listFiles={listFiles} />);
    expect(await screen.findByText('cthulhu.goo')).toBeInTheDocument();
    expect(screen.getByText('boots.ctb')).toBeInTheDocument();
  });

  it('starts a print for the chosen file', async () => {
    const startPrint = vi.fn().mockResolvedValue({ ok: true });
    render(<Files listFiles={listFiles} startPrint={startPrint} />);
    await screen.findByText('cthulhu.goo');

    await userEvent.click(screen.getAllByRole('button', { name: 'Print' })[0] as HTMLElement);
    await waitFor(() => expect(startPrint).toHaveBeenCalledWith('cthulhu.goo'));
    expect(await screen.findByRole('status')).toHaveTextContent('Started cthulhu.goo');
  });

  it('disables Print while a print is already running', async () => {
    // Starting a second print would be refused by the printer with ack 1.
    render(<Files listFiles={listFiles} busy />);
    await screen.findByText('cthulhu.goo');
    for (const b of screen.getAllByRole('button', { name: 'Print' })) {
      expect(b).toBeDisabled();
    }
  });

  it('surfaces the printer reason when a print is refused', async () => {
    const startPrint = vi
      .fn()
      .mockRejectedValue(new Error('Start print refused: file not found (2)'));
    render(<Files listFiles={listFiles} startPrint={startPrint} />);
    await screen.findByText('cthulhu.goo');

    await userEvent.click(screen.getAllByRole('button', { name: 'Print' })[0] as HTMLElement);
    expect(await screen.findByRole('status')).toHaveTextContent('file not found');
  });

  it('uploads a chosen file and refreshes the list', async () => {
    const uploadFile = vi.fn().mockResolvedValue({ filename: 'new.goo' });
    const listed = vi.fn().mockResolvedValue([{ name: 'cthulhu.goo' }]);
    render(<Files listFiles={listed} uploadFile={uploadFile} />);
    await screen.findByText('cthulhu.goo');

    const file = new File([new Uint8Array([1, 2, 3])], 'new.goo');
    await userEvent.upload(screen.getByTestId('file-input'), file);

    await waitFor(() => expect(uploadFile).toHaveBeenCalled());
    expect(await screen.findByRole('status')).toHaveTextContent('Uploaded new.goo');
    // The list is re-read so the freshly uploaded file appears.
    expect(listed).toHaveBeenCalledTimes(2);
  });

  it('reports an upload failure rather than silently doing nothing', async () => {
    const uploadFile = vi.fn().mockRejectedValue(new Error('Upload rejected (502): md5 mismatch'));
    render(<Files listFiles={listFiles} uploadFile={uploadFile} />);
    await screen.findByText('cthulhu.goo');

    await userEvent.upload(
      screen.getByTestId('file-input'),
      new File([new Uint8Array([1])], 'bad.goo'),
    );
    expect(await screen.findByRole('status')).toHaveTextContent('md5 mismatch');
  });

  it('shows an empty state when the printer has no files', async () => {
    render(<Files listFiles={async () => []} />);
    expect(await screen.findByText('No files on the printer.')).toBeInTheDocument();
  });
});
