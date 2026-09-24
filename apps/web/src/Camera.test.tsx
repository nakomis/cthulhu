import { render, screen, waitFor } from '@testing-library/react';
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

  it('says the camera is unavailable when the feed fails', async () => {
    render(<Camera />);
    await userEvent.click(screen.getByRole('button', { name: 'Watch' }));
    const img = await screen.findByRole('img', { name: 'Printer camera' });

    img.dispatchEvent(new Event('error'));
    expect(await screen.findByRole('alert')).toHaveTextContent('Camera unavailable');
  });
});

describe('Camera keyframe wait', () => {
  it('says it is waiting for a keyframe, rather than showing a blank box', async () => {
    // An H.264 camera cannot produce a picture until the next keyframe. The
    // stream is open and healthy but silent, so no error fires - and a blank
    // box reads as broken. Observed for real: a long-GOP stream produced
    // nothing for seconds before the first frame.
    render(<Camera />);
    await userEvent.click(screen.getByRole('button', { name: 'Watch' }));
    expect(await screen.findByRole('status')).toHaveTextContent(/first keyframe/);
  });

  it('drops the waiting message once the first frame arrives', async () => {
    render(<Camera />);
    await userEvent.click(screen.getByRole('button', { name: 'Watch' }));
    const img = await screen.findByRole('img', { name: 'Printer camera' });

    img.dispatchEvent(new Event('load'));
    await waitFor(() => expect(screen.queryByText(/first keyframe/)).not.toBeInTheDocument());
  });

  it('shows the waiting message again after Stop then Watch', async () => {
    render(<Camera />);
    await userEvent.click(screen.getByRole('button', { name: 'Watch' }));
    const img = await screen.findByRole('img', { name: 'Printer camera' });
    img.dispatchEvent(new Event('load'));

    await userEvent.click(screen.getByRole('button', { name: 'Stop' }));
    await userEvent.click(screen.getByRole('button', { name: 'Watch' }));
    // A fresh stream waits for a fresh keyframe; the old "loaded" state must
    // not carry over and hide that.
    expect(await screen.findByRole('status')).toHaveTextContent(/first keyframe/);
  });
});
