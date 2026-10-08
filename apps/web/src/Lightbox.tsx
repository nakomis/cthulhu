import {
  type KeyboardEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
} from 'react';
import { createPortal } from 'react-dom';

export interface LightboxProps {
  /** What the picture is, for the button: "Show {name} full size". */
  name: string;
  /** Under the big picture. */
  caption: ReactNode;
  /** The big picture. Mounted only while open, so it loads nothing until then. */
  full: ReactNode;
  /** Links and the like beside the caption, e.g. "Open full resolution". */
  actions?: ReactNode;
  /** The thumbnail, which becomes the button. */
  children: ReactNode;
}

/**
 * A thumbnail that opens a bigger picture over the dimmed page.
 *
 * A portal rather than a native <dialog>: jsdom has no showModal(), so a
 * <dialog> could not be tested, and this needs only what a modal needs -
 * Esc, a click outside, or the close button shuts it; focus goes in on
 * opening, stays in while open, and goes back to the thumbnail on closing.
 */
export function Lightbox({ name, caption, full, actions, children }: LightboxProps) {
  // What the dialog shows, taken when it opens: the thumbnail may move on
  // underneath (the layer changes every few seconds), but the picture being
  // looked at should hold still until it is closed.
  const [open, setOpen] = useState<Omit<LightboxProps, 'children'> | undefined>();
  const trigger = useRef<HTMLButtonElement>(null);
  const close = useCallback(() => {
    setOpen(undefined);
    trigger.current?.focus();
  }, []);

  return (
    <>
      <button
        ref={trigger}
        type="button"
        aria-label={`Show ${name} full size`}
        onClick={() => setOpen({ name, caption, full, actions })}
        className="flex shrink-0 cursor-zoom-in rounded focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-400"
      >
        {children}
      </button>
      {open ? (
        <LightboxDialog
          name={open.name}
          caption={open.caption}
          actions={open.actions}
          onClose={close}
        >
          {open.full}
        </LightboxDialog>
      ) : null}
    </>
  );
}

function LightboxDialog({
  name,
  caption,
  actions,
  onClose,
  children,
}: {
  name: string;
  caption: ReactNode;
  actions?: ReactNode;
  onClose: () => void;
  children: ReactNode;
}) {
  const panel = useRef<HTMLDivElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const captionId = useId();

  useEffect(() => {
    closeButton.current?.focus();
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      }
    };
    document.addEventListener('keydown', onKey);
    // The page underneath should not scroll away behind the picture.
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = overflow;
    };
  }, [onClose]);

  // Keep Tab inside the dialog: it is modal, and the page behind is inert.
  const trapTab = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'Tab' || !panel.current) return;
    const focusable = [
      ...panel.current.querySelectorAll<HTMLElement>('a[href], button:not([disabled])'),
    ];
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (!first || !last) return;
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  };

  return createPortal(
    // biome-ignore lint/a11y/noStaticElementInteractions: the backdrop's click is a convenience; Esc and the close button do the same
    // biome-ignore lint/a11y/useKeyWithClickEvents: Esc is handled on the document
    <div
      data-testid="lightbox-backdrop"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/85 p-2 backdrop-blur-sm"
    >
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-label={name.charAt(0).toUpperCase() + name.slice(1)}
        aria-describedby={captionId}
        onKeyDown={trapTab}
        className="flex max-w-[95vw] flex-col items-center gap-2"
      >
        {children}
        <div className="flex w-full flex-wrap items-center justify-between gap-x-4 gap-y-2 rounded-lg bg-slate-900/90 px-3 py-2 text-sm">
          <p id={captionId} className="text-slate-300">
            {caption}
          </p>
          <div className="flex items-center gap-3">
            {actions}
            <button
              ref={closeButton}
              type="button"
              onClick={onClose}
              className="rounded-lg border border-slate-600 px-3 py-1 text-slate-200 hover:bg-slate-800"
            >
              Close
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}

export interface LightboxImageProps {
  src: string;
  alt: string;
  /**
   * Scale up with hard pixel edges rather than a blur: right for the small
   * slicer previews and printer thumbnails, which are only a few hundred
   * pixels across and would otherwise look like a mistake.
   */
  pixelated?: boolean;
}

/**
 * A picture as large as the viewport allows, whatever its own size: small
 * ones are scaled up, big ones down, keeping their shape.
 */
export function LightboxImage({ src, alt, pixelated = false }: LightboxImageProps) {
  // Width over height, once loaded, so a small image can be scaled UP to fit:
  // max-width alone only ever shrinks.
  const [aspect, setAspect] = useState<number | undefined>();
  return (
    <img
      src={src}
      alt={alt}
      onLoad={(e) => {
        const { naturalWidth, naturalHeight } = e.currentTarget;
        if (naturalWidth > 0 && naturalHeight > 0) setAspect(naturalWidth / naturalHeight);
      }}
      style={{
        imageRendering: pixelated ? 'pixelated' : undefined,
        width: aspect ? `min(95vw, calc((90vh - 4rem) * ${aspect}))` : undefined,
        maxWidth: '95vw',
        maxHeight: 'calc(90vh - 4rem)',
      }}
      className="rounded bg-black object-contain"
    />
  );
}
