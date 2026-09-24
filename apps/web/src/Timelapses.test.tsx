import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { type TimelapseEntry, Timelapses } from './Timelapses.js';

const entry = (over: Partial<TimelapseEntry>): TimelapseEntry => ({
  id: 'e0b0890e-b803',
  state: 'ready',
  frames: 893,
  startedAt: '2026-09-24T10:40:00Z',
  filename: 'keystamp.goo',
  ...over,
});

describe('Timelapses', () => {
  it('lists each print with its frames, and plays one when opened', async () => {
    render(<Timelapses listTimelapses={async () => [entry({})]} />);
    expect(await screen.findByText('keystamp.goo')).toBeInTheDocument();
    expect(screen.getByText(/893 layers/)).toBeInTheDocument();
    expect(document.querySelector('video')).toBeNull();

    await userEvent.click(screen.getByText('keystamp.goo'));
    expect(document.querySelector('video')).toHaveAttribute(
      'src',
      '/api/timelapses/e0b0890e-b803.mp4',
    );
    expect(screen.getByRole('link', { name: 'Download' })).toHaveAttribute(
      'download',
      'keystamp-timelapse.mp4',
    );
  });

  it('says so while a time-lapse is still recording, with nothing to play yet', async () => {
    render(
      <Timelapses listTimelapses={async () => [entry({ state: 'recording', frames: 412 })]} />,
    );
    expect(await screen.findByText(/412 layers · recording/)).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Download' })).toBeNull();
  });

  it('shows nothing at all until there is a time-lapse', () => {
    const { container } = render(<Timelapses listTimelapses={async () => []} />);
    expect(container).toBeEmptyDOMElement();
  });
});
