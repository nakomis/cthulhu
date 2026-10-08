import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { Lightbox, LightboxImage } from './Lightbox.js';

const renderBox = () =>
  render(
    <>
      <Lightbox
        name="preview of rook.goo"
        caption="rook.goo"
        full={<LightboxImage src="/big.png" alt="Rook, full size" pixelated />}
        actions={<a href="/elsewhere">Elsewhere</a>}
      >
        <img src="/small.png" alt="Rook" />
      </Lightbox>
      <button type="button">Something else</button>
    </>,
  );

const open = async () => {
  await userEvent.click(screen.getByRole('button', { name: 'Show preview of rook.goo full size' }));
  return screen.getByRole('dialog', { name: 'Preview of rook.goo' });
};

describe('Lightbox', () => {
  it('shows nothing big until the thumbnail is pressed', () => {
    renderBox();
    expect(screen.getByRole('img', { name: 'Rook' })).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    // Mounted only when open, so the big image is not even requested.
    expect(screen.queryByRole('img', { name: 'Rook, full size' })).not.toBeInTheDocument();
  });

  it('opens a modal dialog with the big picture and its caption', async () => {
    renderBox();
    const dialog = await open();
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(dialog).toHaveAccessibleDescription('rook.goo');
    const big = screen.getByRole('img', { name: 'Rook, full size' });
    expect(big).toHaveAttribute('src', '/big.png');
    expect(big).toHaveStyle({ imageRendering: 'pixelated' });
  });

  it('moves focus into the dialog, and back to the thumbnail on closing', async () => {
    renderBox();
    await open();
    expect(screen.getByRole('button', { name: 'Close' })).toHaveFocus();
    await userEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Show preview of rook.goo full size' }),
    ).toHaveFocus();
  });

  it('closes on Esc', async () => {
    renderBox();
    await open();
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Show preview of rook.goo full size' }),
    ).toHaveFocus();
  });

  it('closes on a click outside the picture, but not on the picture', async () => {
    renderBox();
    await open();
    await userEvent.click(screen.getByRole('img', { name: 'Rook, full size' }));
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    await userEvent.click(screen.getByTestId('lightbox-backdrop'));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Show preview of rook.goo full size' }),
    ).toHaveFocus();
  });

  it('keeps Tab inside the dialog', async () => {
    renderBox();
    await open();
    const close = screen.getByRole('button', { name: 'Close' });
    const link = screen.getByRole('link', { name: 'Elsewhere' });
    await userEvent.tab();
    expect(link).toHaveFocus();
    await userEvent.tab({ shift: true });
    expect(close).toHaveFocus();
    // From the last focusable, Tab wraps to the first rather than escaping.
    await userEvent.tab();
    expect(link).toHaveFocus();
  });

  it('stops the page scrolling while open, and restores it after', async () => {
    renderBox();
    await open();
    expect(document.body.style.overflow).toBe('hidden');
    await userEvent.keyboard('{Escape}');
    expect(document.body.style.overflow).toBe('');
  });

  it('scales a small picture up to fit once its size is known', async () => {
    renderBox();
    await open();
    const big = screen.getByRole('img', { name: 'Rook, full size' });
    Object.defineProperty(big, 'naturalWidth', { value: 290 });
    Object.defineProperty(big, 'naturalHeight', { value: 290 });
    expect(big.style.width).toBe('');
    fireEvent.load(big);
    // Normalised by the CSS engine, which shows it parsed: as wide as fits.
    expect(big.style.width).toBe('min(95vw, 1 * (90vh - 4rem))');
  });
});
