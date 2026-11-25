// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../../src/client/App.tsx';

const offlineFetch = vi.fn(async () => new Response('{}', { status: 404 }));

function scrollTo(y: number) {
  Object.defineProperty(window, 'scrollY', { value: y, configurable: true });
  act(() => {
    window.dispatchEvent(new Event('scroll'));
  });
}

beforeEach(() => {
  Object.defineProperty(window, 'innerHeight', { value: 800, configurable: true });
  Object.defineProperty(window, 'scrollY', { value: 0, configurable: true });
  window.scrollTo = vi.fn();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('Back to top tab', () => {
  it('is hidden until the page is scrolled past one viewport height', () => {
    render(<App fetchImpl={offlineFetch} />);
    expect(screen.queryByRole('button', { name: /back to top/i })).not.toBeInTheDocument();

    scrollTo(800);
    expect(screen.queryByRole('button', { name: /back to top/i })).not.toBeInTheDocument();

    scrollTo(801);
    expect(screen.getByRole('button', { name: /back to top/i })).toBeInTheDocument();

    scrollTo(100);
    expect(screen.queryByRole('button', { name: /back to top/i })).not.toBeInTheDocument();
  });

  it('scrolls the page to the top when clicked', async () => {
    render(<App fetchImpl={offlineFetch} />);
    scrollTo(2000);

    await userEvent.click(screen.getByRole('button', { name: /back to top/i }));

    expect(window.scrollTo).toHaveBeenCalledWith(expect.objectContaining({ top: 0 }));
  });
});
