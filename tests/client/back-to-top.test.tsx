// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../../src/client/App.tsx';

const offlineFetch = vi.fn(async () => new Response('{}', { status: 404 }));

function setScrollY(y: number) {
  Object.defineProperty(window, 'scrollY', { value: y, configurable: true });
}

function simulateScroll(y: number) {
  setScrollY(y);
  act(() => {
    window.dispatchEvent(new Event('scroll'));
  });
}

function simulateResize(innerHeight: number) {
  Object.defineProperty(window, 'innerHeight', { value: innerHeight, configurable: true });
  act(() => {
    window.dispatchEvent(new Event('resize'));
  });
}

function stubReducedMotion(reduce: boolean) {
  window.matchMedia = vi.fn().mockImplementation((query: string) => ({
    matches: reduce && query.includes('prefers-reduced-motion'),
  })) as unknown as typeof window.matchMedia;
}

beforeEach(() => {
  Object.defineProperty(window, 'innerHeight', { value: 800, configurable: true });
  setScrollY(0);
  window.scrollTo = vi.fn();
  stubReducedMotion(false);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('Back to top tab', () => {
  it('is hidden until the page is scrolled past one viewport height', () => {
    render(<App fetchImpl={offlineFetch} />);
    expect(screen.queryByRole('button', { name: /back to top/i })).not.toBeInTheDocument();

    simulateScroll(800);
    expect(screen.queryByRole('button', { name: /back to top/i })).not.toBeInTheDocument();

    simulateScroll(801);
    expect(screen.getByRole('button', { name: /back to top/i })).toBeInTheDocument();

    simulateScroll(100);
    expect(screen.queryByRole('button', { name: /back to top/i })).not.toBeInTheDocument();
  });

  it('hides when the window grows taller than the scroll position without a scroll event', () => {
    render(<App fetchImpl={offlineFetch} />);
    simulateScroll(1000);
    expect(screen.getByRole('button', { name: /back to top/i })).toBeInTheDocument();

    simulateResize(1200);
    expect(screen.queryByRole('button', { name: /back to top/i })).not.toBeInTheDocument();
  });

  it('smooth-scrolls the page to the top when clicked', async () => {
    render(<App fetchImpl={offlineFetch} />);
    simulateScroll(2000);

    await userEvent.click(screen.getByRole('button', { name: /back to top/i }));

    expect(window.scrollTo).toHaveBeenCalledWith({ top: 0, behavior: 'smooth' });
  });

  it('jumps to the top without animation when reduced motion is preferred', async () => {
    stubReducedMotion(true);
    render(<App fetchImpl={offlineFetch} />);
    simulateScroll(2000);

    await userEvent.click(screen.getByRole('button', { name: /back to top/i }));

    expect(window.scrollTo).toHaveBeenCalledWith({ top: 0, behavior: 'auto' });
  });
});
