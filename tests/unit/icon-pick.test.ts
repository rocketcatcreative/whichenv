import { describe, expect, it } from 'vitest';
import { conventionalIcon, iconSize, pickIcon } from '../../src/core/icon-pick';

describe('iconSize', () => {
  it('reads the largest square dimension', () => {
    expect(iconSize('16x16')).toBe(16);
    expect(iconSize('16x16 32x32 180x180')).toBe(180);
  });

  it('treats a non-square entry by its smaller side', () => {
    // A 180x120 icon only guarantees 120 usable pixels once squared off.
    expect(iconSize('180x120')).toBe(120);
  });

  it('ranks a vector above everything', () => {
    expect(iconSize('any')).toBeGreaterThan(iconSize('512x512'));
  });

  it('scores an absent or unreadable value as zero rather than guessing', () => {
    expect(iconSize(undefined)).toBe(0);
    expect(iconSize('')).toBe(0);
    expect(iconSize('large')).toBe(0);
  });

  it('accepts the unicode multiplication sign, which real sites use', () => {
    expect(iconSize('32×32')).toBe(32);
  });
});

describe('pickIcon', () => {
  it('returns null when there is nothing to pick', () => {
    expect(pickIcon([])).toBeNull();
  });

  it('prefers a larger declared size, since the mark is drawn at 64px', () => {
    expect(
      pickIcon([
        { href: '/small.png', sizes: '16x16' },
        { href: '/big.png', sizes: '180x180' },
      ]),
    ).toBe('/big.png');
  });

  it('prefers a declared size over an undeclared one', () => {
    expect(pickIcon([{ href: '/unknown.png' }, { href: '/known.png', sizes: '32x32' }])).toBe(
      '/known.png',
    );
  });

  it('prefers an apple-touch-icon at the same size, as it is usually the crispest', () => {
    expect(
      pickIcon([
        { href: '/icon.png', sizes: '180x180', rel: 'icon' },
        { href: '/apple.png', sizes: '180x180', rel: 'apple-touch-icon' },
      ]),
    ).toBe('/apple.png');
  });

  it('prefers a real image over a multi-resolution ico at the same size', () => {
    expect(pickIcon([{ href: '/f.ico' }, { href: '/f.png' }])).toBe('/f.png');
  });

  it('takes the last declaration when nothing else separates them', () => {
    // Sites append their preferred icon last, and it is what Chrome tends to settle on.
    expect(pickIcon([{ href: '/first.png' }, { href: '/last.png' }])).toBe('/last.png');
  });

  // Sites use a bare `data:,` to suppress the default favicon request. Compositing on it
  // would produce an empty icon, which looks like a broken extension.
  it('skips the empty data URL sites use to suppress a favicon', () => {
    expect(pickIcon([{ href: 'data:,' }])).toBeNull();
    expect(pickIcon([{ href: 'data:,' }, { href: '/real.png' }])).toBe('/real.png');
  });

  it('keeps a genuine data URL, which is readable into a canvas', () => {
    expect(pickIcon([{ href: 'data:image/png;base64,AAAA' }])).toBe('data:image/png;base64,AAAA');
  });

  it('ignores blank and whitespace-only hrefs', () => {
    expect(pickIcon([{ href: '   ' }, { href: '' }])).toBeNull();
  });
});

describe('conventionalIcon', () => {
  it('points at the root favicon for the page origin', () => {
    expect(conventionalIcon('https://acme.example/shop/item?x=1#y')).toBe(
      'https://acme.example/favicon.ico',
    );
  });

  it('keeps the port, since that is a different origin', () => {
    expect(conventionalIcon('http://localhost:3000/deep/page')).toBe(
      'http://localhost:3000/favicon.ico',
    );
  });

  it('declines anything that is not http or https', () => {
    expect(conventionalIcon('chrome://extensions')).toBeNull();
    expect(conventionalIcon('file:///tmp/x.html')).toBeNull();
    expect(conventionalIcon('not a url')).toBeNull();
  });
});
