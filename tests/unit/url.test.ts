import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PORTS,
  hasExplicitPort,
  isLocalHost,
  isLoopbackHost,
  loopbackAliasesFor,
  matchKeyForUrl,
  parseBaseUrl,
  tryParseBaseUrl,
} from '../../src/core/url';

/** Parses and asserts success, returning the value. */
function parse(input: string) {
  const result = parseBaseUrl(input);
  if (!result.ok) throw new Error(`expected ${input} to parse, got ${result.error.code}`);
  return result;
}

function codes(input: string): string[] {
  const result = parseBaseUrl(input);
  return result.ok ? result.notices.map((n) => n.code) : [result.error.code];
}

describe('parseBaseUrl', () => {
  it('fills in the default port so match keys are always explicit', () => {
    expect(parse('https://acme.com').value.port).toBe(443);
    expect(parse('http://acme.com').value.port).toBe(80);
    expect(parse('https://acme.com').value.matchKey).toBe('https://acme.com:443');
  });

  // The bug this prevents: treating the same dev server as two different
  // environments depending on how the URL happened to be typed.
  it('treats an implicit and an explicit default port as the same environment', () => {
    expect(parse('http://localhost').value.matchKey).toBe(parse('http://localhost:80').value.matchKey);
    expect(parse('https://acme.com').value.matchKey).toBe(parse('https://acme.com:443').value.matchKey);
  });

  it('keeps different ports on the same host as different environments', () => {
    const a = parse('http://localhost:3000').value.matchKey;
    const b = parse('http://localhost:3001').value.matchKey;
    expect(a).not.toBe(b);
  });

  it('treats a different scheme on the same host and port as a different environment', () => {
    expect(parse('http://acme.com:8080').value.matchKey).not.toBe(
      parse('https://acme.com:8080').value.matchKey,
    );
  });

  it('omits the default port from the stored form but keeps a custom one', () => {
    expect(parse('https://acme.com:443').value.normalized).toBe('https://acme.com');
    expect(parse('http://acme.com:80/shop').value.normalized).toBe('http://acme.com/shop');
    expect(parse('http://localhost:3000').value.normalized).toBe('http://localhost:3000');
  });

  it('lowercases the host but leaves the path case alone', () => {
    const { value } = parse('https://ACME.example.COM/Shop/Items');
    expect(value.host).toBe('acme.example.com');
    expect(value.basePath).toBe('/Shop/Items');
  });

  it('strips trailing slashes and collapses duplicate ones', () => {
    expect(parse('https://acme.com/').value.basePath).toBe('');
    expect(parse('https://acme.com///').value.basePath).toBe('');
    expect(parse('https://acme.com/shop/').value.basePath).toBe('/shop');
    expect(parse('https://acme.com//shop//items/').value.basePath).toBe('/shop/items');
  });

  it('produces a stable match key regardless of trailing slash', () => {
    expect(parse('https://acme.com/shop').value.matchKey).toBe(
      parse('https://acme.com/shop/').value.matchKey,
    );
  });

  it('assumes https for public hosts and http for local ones', () => {
    expect(parse('acme.com').value.scheme).toBe('https');
    expect(parse('localhost:3000').value.scheme).toBe('http');
    expect(parse('127.0.0.1:8080').value.scheme).toBe('http');
    expect(parse('acme.test').value.scheme).toBe('http');
    expect(parse('my-app.localhost:3000').value.scheme).toBe('http');
    expect(codes('acme.com')).toContain('scheme-assumed');
  });

  it('does not report a notice when the scheme was given', () => {
    expect(codes('https://acme.com')).not.toContain('scheme-assumed');
  });

  it('strips credentials, query and fragment, and says so', () => {
    const result = parse('https://user:pass@acme.com/shop?ref=email#top');
    expect(result.value.normalized).toBe('https://acme.com/shop');
    expect(result.notices.map((n) => n.code)).toEqual(
      expect.arrayContaining(['credentials-stripped', 'query-stripped', 'hash-stripped']),
    );
  });

  it('handles IPv6 loopback', () => {
    const { value } = parse('http://[::1]:3000');
    expect(value.host).toBe('[::1]');
    expect(value.port).toBe(3000);
    expect(value.matchKey).toBe('http://[::1]:3000');
  });

  it('exposes a short display form for the UI', () => {
    expect(parse('https://acme.com').value.display).toBe('acme.com');
    expect(parse('http://localhost:3000/app').value.display).toBe('localhost:3000/app');
  });

  it('is idempotent: normalizing a normalized value changes nothing', () => {
    for (const input of [
      'https://acme.com',
      'http://localhost:3000/app',
      'https://acme.com/shop',
      'http://[::1]:8080',
    ]) {
      const once = parse(input).value.normalized;
      expect(parse(once).value.normalized).toBe(once);
      expect(parse(once).value.matchKey).toBe(parse(input).value.matchKey);
    }
  });

  describe('rejections', () => {
    it('rejects empty input', () => {
      expect(codes('')).toEqual(['empty']);
      expect(codes('   ')).toEqual(['empty']);
    });

    it('rejects non-http schemes', () => {
      for (const input of ['ftp://acme.com', 'file:///Users/me', 'chrome://extensions', 'mailto:a@b.c']) {
        expect(codes(input)).toEqual(['unsupported-scheme']);
      }
    });

    it('rejects input with no hostname', () => {
      expect(codes('https://')).toEqual(['unparseable']);
    });

    it('rejects out-of-range ports', () => {
      expect(codes('http://localhost:0')).toEqual(['bad-port']);
      expect(codes('http://localhost:99999')).toEqual(['unparseable']);
    });

    it('never throws, whatever it is given', () => {
      for (const input of ['://', 'http://', '%%%', 'http://[', 'a'.repeat(5000)]) {
        expect(() => parseBaseUrl(input)).not.toThrow();
      }
    });
  });
});

describe('hasExplicitPort', () => {
  it('detects a spelled-out port', () => {
    expect(hasExplicitPort('http://localhost:3000')).toBe(true);
    expect(hasExplicitPort('localhost:3000')).toBe(true);
    expect(hasExplicitPort('http://localhost:80/app')).toBe(true);
    expect(hasExplicitPort('acme.com:8443/x')).toBe(true);
  });

  it('reports false when the port was left implicit', () => {
    expect(hasExplicitPort('http://localhost')).toBe(false);
    expect(hasExplicitPort('https://acme.com/shop')).toBe(false);
    expect(hasExplicitPort('localhost')).toBe(false);
  });

  it('is not fooled by a scheme colon or a path segment with digits', () => {
    expect(hasExplicitPort('https://acme.com/v2')).toBe(false);
    expect(hasExplicitPort('https://acme.com/2024/report')).toBe(false);
  });
});

describe('host classification', () => {
  it('identifies loopback hosts', () => {
    for (const host of ['localhost', 'LOCALHOST', '127.0.0.1', '[::1]']) {
      expect(isLoopbackHost(host)).toBe(true);
    }
    expect(isLoopbackHost('acme.com')).toBe(false);
    expect(isLoopbackHost('notlocalhost')).toBe(false);
  });

  it('identifies local development hosts more broadly', () => {
    for (const host of ['localhost', 'acme.test', 'acme.local', 'app.localhost']) {
      expect(isLocalHost(host)).toBe(true);
    }
    expect(isLocalHost('acme.com')).toBe(false);
    expect(isLocalHost('staging.acme.com')).toBe(false);
  });
});

describe('loopbackAliasesFor', () => {
  // Chrome treats these as different origins even though they are the same
  // server, so the editor offers the counterparts rather than leaving you to
  // discover the problem.
  it('offers the other spellings of the same loopback server', () => {
    const base = tryParseBaseUrl('http://localhost:3000');
    expect(base).not.toBeNull();
    expect(loopbackAliasesFor(base!)).toEqual([
      'http://127.0.0.1:3000',
      'http://[::1]:3000',
    ]);
  });

  it('carries the base path and port into the aliases', () => {
    const base = tryParseBaseUrl('http://127.0.0.1:8080/app');
    expect(loopbackAliasesFor(base!)).toEqual([
      'http://localhost:8080/app',
      'http://[::1]:8080/app',
    ]);
  });

  it('offers nothing for a non-loopback host', () => {
    expect(loopbackAliasesFor(tryParseBaseUrl('https://acme.com')!)).toEqual([]);
    expect(loopbackAliasesFor(tryParseBaseUrl('http://acme.test')!)).toEqual([]);
  });
});

describe('matchKeyForUrl', () => {
  it('agrees with the base URL parser, so a tab and a stored base cannot disagree', () => {
    expect(matchKeyForUrl('https://acme.com/products/42?ref=x#top')).toBe(
      tryParseBaseUrl('https://acme.com/products/42')!.matchKey,
    );
  });

  it('returns null for URLs the extension ignores', () => {
    expect(matchKeyForUrl('chrome://extensions')).toBeNull();
    expect(matchKeyForUrl('about:blank')).toBeNull();
  });
});

describe('DEFAULT_PORTS', () => {
  it('knows the scheme defaults', () => {
    expect(DEFAULT_PORTS.http).toBe(80);
    expect(DEFAULT_PORTS.https).toBe(443);
  });
});
