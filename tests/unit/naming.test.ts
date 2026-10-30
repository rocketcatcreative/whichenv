import { describe, expect, it } from 'vitest';
import { apexOf, siteWordOf, titleFromTab } from '../../src/core/naming';

describe('apexOf', () => {
  it('strips an environment label', () => {
    expect(apexOf('staging.acme.com')).toBe('acme.com');
    expect(apexOf('dev.acme.co.uk')).toBe('acme.co.uk');
  });

  it('strips a www label', () => {
    expect(apexOf('www.acme.com')).toBe('acme.com');
  });

  it('strips several stacked labels', () => {
    expect(apexOf('staging.www.acme.com')).toBe('acme.com');
  });

  it('leaves a bare apex alone', () => {
    expect(apexOf('acme.com')).toBe('acme.com');
  });

  // Never strip below two labels, or `acme.com` would become `com`.
  it('never strips a two-label host down to its suffix', () => {
    expect(apexOf('dev.com')).toBe('dev.com');
  });

  it('keeps a non-environment subdomain, since it may be the actual site', () => {
    expect(apexOf('shop.acme.com')).toBe('shop.acme.com');
  });

  it('leaves loopback and IPv6 hosts as they are', () => {
    expect(apexOf('localhost')).toBe('localhost');
    expect(apexOf('127.0.0.1')).toBe('127.0.0.1');
    expect(apexOf('[::1]')).toBe('[::1]');
  });
});

describe('siteWordOf', () => {
  it('finds the memorable label', () => {
    expect(siteWordOf('acme.com')).toBe('Acme');
    expect(siteWordOf('staging.acme.com')).toBe('Acme');
  });

  // A full public suffix list is a megabyte of data for a default title, so a short
  // list of common second-level suffixes is the right trade.
  it('looks past a country-code second level', () => {
    expect(siteWordOf('acme.co.uk')).toBe('Acme');
    expect(siteWordOf('staging.acme.com.au')).toBe('Acme');
  });

  it('has something sensible to say about loopback', () => {
    expect(siteWordOf('localhost')).toBe('Local site');
  });
});

describe('titleFromTab', () => {
  // Page titles are usually "Some Page | Site Name", so the last segment is the site
  // name far more often than not.
  it('takes the last segment of a page title', () => {
    expect(titleFromTab('acme.com', 'Product 42 | Acme Store')).toBe('Acme Store');
    expect(titleFromTab('acme.com', 'Cart – Acme Store')).toBe('Acme Store');
  });

  it('uses a single-segment title as it is', () => {
    expect(titleFromTab('acme.com', 'Acme Store')).toBe('Acme Store');
  });

  it('falls back to the domain when there is no title', () => {
    expect(titleFromTab('acme.com', undefined)).toBe('Acme');
    expect(titleFromTab('acme.com', '   ')).toBe('Acme');
  });

  it('falls back when the segment is too long to be a site name', () => {
    expect(titleFromTab('acme.com', `x${'y'.repeat(60)}`)).toBe('Acme');
  });

  it('falls back when the title is just the hostname', () => {
    expect(titleFromTab('acme.com', 'acme.com')).toBe('Acme');
    expect(titleFromTab('acme.com', 'www.acme.com')).toBe('Acme');
  });
});

// The module used to export guessEnvKey and guessGroupFromUrl, which invented sibling
// hostnames from the apex. Naming is all that is left, and this is the line that says so.
describe('what this module no longer does', () => {
  it('exports nothing that produces a URL', async () => {
    const naming: Record<string, unknown> = await import('../../src/core/naming');
    expect(Object.keys(naming).sort()).toEqual(['apexOf', 'siteWordOf', 'titleFromTab']);
  });
});
