import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { App } from './App.js';

describe('App', () => {
  it('shows the printer name and idle status by default', () => {
    render(<App />);
    expect(screen.getByRole('heading', { name: 'Cthulhu' })).toBeInTheDocument();
    expect(screen.getByText('Elegoo Mars 5 Ultra')).toBeInTheDocument();
    expect(screen.getByText('Idle')).toBeInTheDocument();
  });

  it('renders the supplied status code', () => {
    render(<App statusCode={3} />);
    expect(screen.getByText('Exposing')).toBeInTheDocument();
  });
});
