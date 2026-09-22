import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { Camera } from './Camera.js';

describe('Camera', () => {
  it('does NOT mount the stream until asked', async () => {
    // The printer allows one stream at a time. An always-mounted <img> would
    // hold that single slot open forever and lock the Elegoo app out.
    render(<Camera />);
    expect(screen.queryByRole('img')).not.toBeInTheDocument();
    expect(screen.getByText(/released when nobody is looking/)).toBeInTheDocument();
  });

  it('mounts the stream when Watch is pressed, and unmounts on Stop', async () => {
    render(<Camera />);
    await userEvent.click(screen.getByRole('button', { name: 'Watch' }));

    const img = await screen.findByRole('img', { name: 'Printer camera' });
    expect(img).toHaveAttribute('src', '/api/camera/stream');

    await userEvent.click(screen.getByRole('button', { name: 'Stop' }));
    expect(screen.queryByRole('img')).not.toBeInTheDocument();
  });

  it('explains the single-stream limit when the feed fails', async () => {
    render(<Camera />);
    await userEvent.click(screen.getByRole('button', { name: 'Watch' }));
    const img = await screen.findByRole('img', { name: 'Printer camera' });

    img.dispatchEvent(new Event('error'));
    expect(await screen.findByRole('alert')).toHaveTextContent('one stream at a time');
  });
});
