import { describe, expect, it } from 'vitest';
import { isUnder, joinPath, originOf, stripBasePath, translateUrl } from '../../src/core/translate';
import { tryParseBaseUrl, type ParsedBase } from '../../src/core/url';

function base(input: string): ParsedBase {
  const parsed = tryParseBaseUrl(input);
  if (!parsed) throw new Error(`test setup: ${input} does not parse`);
  return parsed;
}

/** Translate helper taking base URLs as strings. */
const go = (current: string, from: string, to: string) =>
  translateUrl(current, base(from), base(to));

describe('stripBasePath', () => {
  it('returns the whole pathname when there is no base path', () => {
    expect(stripBasePath('/products/42', '')).toBe('/products/42');
    expect(stripBasePath('/', '')).toBe('/');
  });

  it('returns an empty remainder when the pathname is exactly the base path', () => {
    expect(stripBasePath('/shop', '/shop')).toBe('');
  });

  it('strips the base path from a deeper pathname', () => {
    expect(stripBasePath('/shop/products/42', '/shop')).toBe('/products/42');
  });

  // The bug a naive startsWith would cause: /shopping is not under /shop.
  it('is segment-aware, so a partial segment match does not count', () => {
    expect(stripBasePath('/shopping', '/shop')).toBeNull();
    expect(stripBasePath('/shopping/cart', '/shop')).toBeNull();
    expect(stripBasePath('/shop-2/x', '/shop')).toBeNull();
  });

  it('returns null when the pathname is not under the base path at all', () => {
    expect(stripBasePath('/admin', '/shop')).toBeNull();
    expect(stripBasePath('/', '/shop')).toBeNull();
  });

  it('handles nested base paths', () => {
    expect(stripBasePath('/a/b/c/d', '/a/b')).toBe('/c/d');
    expect(stripBasePath('/a/bb/c', '/a/b')).toBeNull();
  });
});

describe('joinPath', () => {
  it('returns the remainder when there is no target base path', () => {
    expect(joinPath('', '/products/42')).toBe('/products/42');
    expect(joinPath('', '')).toBe('');
  });

  it('returns just the base path for an empty or root remainder', () => {
    expect(joinPath('/shop', '')).toBe('/shop');
    expect(joinPath('/shop', '/')).toBe('/shop');
  });

  it('joins without doubling the slash', () => {
    expect(joinPath('/shop', '/products/42')).toBe('/shop/products/42');
  });
});

describe('originOf', () => {
  it('always includes an explicit port', () => {
    expect(originOf(new URL('https://acme.com/x'))).toBe('https://acme.com:443');
    expect(originOf(new URL('http://acme.com/x'))).toBe('http://acme.com:80');
    expect(originOf(new URL('http://localhost:3000/x'))).toBe('http://localhost:3000');
  });

  it('lowercases the host', () => {
    expect(originOf(new URL('https://ACME.com'))).toBe('https://acme.com:443');
  });
});

describe('translateUrl', () => {
  it('carries the path, query and fragment across', () => {
    expect(
      go(
        'https://staging.acme.com/shop/products/42?ref=email&v=2#reviews',
        'https://staging.acme.com',
        'https://acme.com',
      ),
    ).toBe('https://acme.com/shop/products/42?ref=email&v=2#reviews');
  });

  // The headline case: one hop across both a scheme and a port boundary.
  it('crosses from https on 443 to http on a custom port', () => {
    expect(go('https://acme.com/products/42?x=1', 'https://acme.com', 'http://localhost:3000')).toBe(
      'http://localhost:3000/products/42?x=1',
    );
  });

  it('crosses back from local to production', () => {
    expect(go('http://localhost:3000/products/42', 'http://localhost:3000', 'https://acme.com')).toBe(
      'https://acme.com/products/42',
    );
  });

  it('moves between two localhost ports', () => {
    expect(go('http://localhost:3000/a/b?c=d', 'http://localhost:3000', 'http://localhost:3001')).toBe(
      'http://localhost:3001/a/b?c=d',
    );
  });

  it('takes scheme, host and port from the target, never the source', () => {
    const result = go('http://localhost:3000/x', 'http://localhost:3000', 'https://acme.com:8443');
    expect(result).toBe('https://acme.com:8443/x');
  });

  describe('base paths', () => {
    it('strips the source base path and applies the target one', () => {
      expect(
        go(
          'https://staging.acme.com/app/products/42',
          'https://staging.acme.com/app',
          'https://acme.com/shop',
        ),
      ).toBe('https://acme.com/shop/products/42');
    });

    it('handles a source base path with no target base path', () => {
      expect(
        go('https://staging.acme.com/app/products/42', 'https://staging.acme.com/app', 'https://acme.com'),
      ).toBe('https://acme.com/products/42');
    });

    it('handles no source base path with a target base path', () => {
      expect(go('https://acme.com/products/42', 'https://acme.com', 'https://acme.com/shop')).toBe(
        'https://acme.com/shop/products/42',
      );
    });

    it('lands on the bare target when the current URL is the base path itself', () => {
      expect(go('https://staging.acme.com/app', 'https://staging.acme.com/app', 'https://acme.com/shop')).toBe(
        'https://acme.com/shop',
      );
    });

    it('refuses a URL that is not under the source base path', () => {
      expect(go('https://staging.acme.com/admin', 'https://staging.acme.com/app', 'https://acme.com')).toBeNull();
    });

    it('is not fooled by a partial segment match', () => {
      expect(
        go('https://staging.acme.com/application', 'https://staging.acme.com/app', 'https://acme.com'),
      ).toBeNull();
    });
  });

  describe('edge cases', () => {
    it('canonicalizes an empty path to a single slash', () => {
      expect(go('https://staging.acme.com', 'https://staging.acme.com', 'https://acme.com')).toBe(
        'https://acme.com/',
      );
      expect(go('https://staging.acme.com/', 'https://staging.acme.com', 'https://acme.com')).toBe(
        'https://acme.com/',
      );
    });

    it('keeps a query on a root path', () => {
      expect(go('https://staging.acme.com/?a=1', 'https://staging.acme.com', 'https://acme.com')).toBe(
        'https://acme.com/?a=1',
      );
    });

    it('keeps a fragment with no query', () => {
      expect(go('https://staging.acme.com/x#top', 'https://staging.acme.com', 'https://acme.com')).toBe(
        'https://acme.com/x#top',
      );
    });

    it('drops credentials rather than carrying them to another environment', () => {
      expect(
        go('https://user:pass@staging.acme.com/x', 'https://staging.acme.com', 'https://acme.com'),
      ).toBe('https://acme.com/x');
    });

    it('preserves percent-encoded path segments', () => {
      expect(
        go('https://staging.acme.com/a%20b/c%2Fd', 'https://staging.acme.com', 'https://acme.com'),
      ).toBe('https://acme.com/a%20b/c%2Fd');
    });

    it('preserves path case', () => {
      expect(go('https://staging.acme.com/Shop/Item', 'https://staging.acme.com', 'https://acme.com')).toBe(
        'https://acme.com/Shop/Item',
      );
    });

    it('preserves an empty query marker and repeated params', () => {
      expect(
        go('https://staging.acme.com/x?a=1&a=2&b=', 'https://staging.acme.com', 'https://acme.com'),
      ).toBe('https://acme.com/x?a=1&a=2&b=');
    });

    it('refuses when the current URL belongs to a different origin', () => {
      expect(go('https://other.example/x', 'https://staging.acme.com', 'https://acme.com')).toBeNull();
    });

    // Same host, different port is a different environment, so this must refuse.
    it('refuses when only the port differs', () => {
      expect(go('http://localhost:3001/x', 'http://localhost:3000', 'https://acme.com')).toBeNull();
    });

    it('refuses when only the scheme differs', () => {
      expect(go('http://acme.com/x', 'https://acme.com', 'https://other.example')).toBeNull();
    });

    it('accepts an implicit default port as matching an explicit one', () => {
      expect(go('https://acme.com:443/x', 'https://acme.com', 'https://other.example')).toBe(
        'https://other.example/x',
      );
      expect(go('https://acme.com/x', 'https://acme.com:443', 'https://other.example')).toBe(
        'https://other.example/x',
      );
    });

    it('refuses non-http schemes and unparseable input', () => {
      expect(go('chrome://extensions', 'https://acme.com', 'https://other.example')).toBeNull();
      expect(go('file:///Users/me/x', 'https://acme.com', 'https://other.example')).toBeNull();
      expect(go('not a url', 'https://acme.com', 'https://other.example')).toBeNull();
      expect(go('', 'https://acme.com', 'https://other.example')).toBeNull();
    });

    it('never throws', () => {
      for (const input of ['', '://', '%%%', 'http://[', 'x'.repeat(5000)]) {
        expect(() => go(input, 'https://acme.com', 'https://other.example')).not.toThrow();
      }
    });
  });

  it('round trips: there and back returns the original', () => {
    const original = 'https://acme.com/shop/products/42?ref=email#reviews';
    const there = go(original, 'https://acme.com', 'http://localhost:3000/app');
    expect(there).toBe('http://localhost:3000/app/shop/products/42?ref=email#reviews');
    expect(go(there!, 'http://localhost:3000/app', 'https://acme.com')).toBe(original);
  });
});

describe('isUnder', () => {
  it('agrees with translateUrl about what counts as under a base', () => {
    expect(isUnder('https://acme.com/shop/x', base('https://acme.com/shop'))).toBe(true);
    expect(isUnder('https://acme.com/shopping', base('https://acme.com/shop'))).toBe(false);
    expect(isUnder('http://localhost:3001/x', base('http://localhost:3000'))).toBe(false);
    expect(isUnder('chrome://extensions', base('https://acme.com'))).toBe(false);
    expect(isUnder('garbage', base('https://acme.com'))).toBe(false);
  });
});
