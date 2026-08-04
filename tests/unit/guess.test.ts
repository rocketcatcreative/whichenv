import { describe, expect, it } from 'vitest';
import { apexOf, guessEnvKey, guessGroupFromUrl, guessTitle, siteWordOf } from '../../src/core/guess';

const guess = (url: string, title?: string, localPort = 3000) =>
  guessGroupFromUrl(url, title, { localPort });

/** The base URL guessed for one environment key. */
const urlFor = (url: string, key: string, title?: string) =>
  guess(url, title)?.environments.find((env) => env.key === key)?.baseUrl;

describe('guessEnvKey', () => {
  it('recognises loopback and local development hosts', () => {
    for (const host of ['localhost', '127.0.0.1', 'acme.test', 'app.localhost']) {
      expect(guessEnvKey(host)).toBe('local');
    }
  });

  it('recognises environment subdomains', () => {
    expect(guessEnvKey('dev.acme.com')).toBe('dev');
    expect(guessEnvKey('development.acme.com')).toBe('dev');
    expect(guessEnvKey('staging.acme.com')).toBe('staging');
    expect(guessEnvKey('stg.acme.com')).toBe('staging');
    expect(guessEnvKey('qa.acme.com')).toBe('qa');
    expect(guessEnvKey('uat.acme.com')).toBe('qa');
    expect(guessEnvKey('preview.acme.com')).toBe('preview');
  });

  it('recognises a trailing environment suffix on the first label', () => {
    expect(guessEnvKey('acme-staging.com')).toBe('staging');
    expect(guessEnvKey('shop-dev.acme.com')).toBe('dev');
  });

  it('is case-insensitive', () => {
    expect(guessEnvKey('STAGING.Acme.com')).toBe('staging');
  });

  // Guessing prod puts the red pill on an unknown host, which is the safe direction
  // to be wrong in.
  it('defaults to prod for anything unrecognised', () => {
    expect(guessEnvKey('acme.com')).toBe('prod');
    expect(guessEnvKey('www.acme.com')).toBe('prod');
    expect(guessEnvKey('shop.acme.com')).toBe('prod');
  });
});

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

describe('guessTitle', () => {
  // Page titles are usually "Some Page | Site Name", so the last segment is the site
  // name far more often than not.
  it('takes the last segment of a page title', () => {
    expect(guessTitle('acme.com', 'Product 42 | Acme Store')).toBe('Acme Store');
    expect(guessTitle('acme.com', 'Cart – Acme Store')).toBe('Acme Store');
  });

  it('uses a single-segment title as it is', () => {
    expect(guessTitle('acme.com', 'Acme Store')).toBe('Acme Store');
  });

  it('falls back to the domain when there is no title', () => {
    expect(guessTitle('acme.com', undefined)).toBe('Acme');
    expect(guessTitle('acme.com', '   ')).toBe('Acme');
  });

  it('falls back when the segment is too long to be a site name', () => {
    expect(guessTitle('acme.com', `x${'y'.repeat(60)}`)).toBe('Acme');
  });

  it('falls back when the title is just the hostname', () => {
    expect(guessTitle('acme.com', 'acme.com')).toBe('Acme');
    expect(guessTitle('acme.com', 'www.acme.com')).toBe('Acme');
  });
});

describe('guessGroupFromUrl', () => {
  it('returns null for a URL that cannot be a base URL', () => {
    expect(guess('chrome://extensions')).toBeNull();
    expect(guess('not a url at all !!')).toBeNull();
  });

  it('fills in the tab’s own environment exactly, and enables only that one', () => {
    const result = guess('https://staging.acme.com/products/42?x=1', 'Acme');
    const staging = result?.environments.find((env) => env.key === 'staging');

    expect(staging?.baseUrl).toBe('https://staging.acme.com');
    expect(staging?.enabled).toBe(true);
    expect(staging?.fromTab).toBe(true);
    expect(result?.environments.filter((env) => env.enabled)).toHaveLength(1);
  });

  // A guessed hostname that does not exist would otherwise show up as a switch
  // target that goes nowhere, so ticking one has to be a deliberate act.
  it('leaves guessed siblings disabled', () => {
    const result = guess('https://acme.com/');
    for (const env of result?.environments ?? []) {
      if (!env.fromTab) expect(env.enabled).toBe(false);
    }
  });

  it('guesses siblings from the apex', () => {
    expect(urlFor('https://acme.com/', 'staging')).toBe('https://staging.acme.com');
    expect(urlFor('https://acme.com/', 'dev')).toBe('https://dev.acme.com');
    expect(urlFor('https://staging.acme.com/', 'prod')).toBe('https://acme.com');
  });

  it('guesses siblings correctly when starting from a non-prod environment', () => {
    expect(urlFor('https://dev.acme.com/', 'staging')).toBe('https://staging.acme.com');
    expect(urlFor('https://dev.acme.com/', 'prod')).toBe('https://acme.com');
  });

  it('always offers a local row with the free port it was given', () => {
    expect(urlFor('https://acme.com/', 'local')).toBe('http://localhost:3000');
    expect(
      guessGroupFromUrl('https://acme.com/', undefined, { localPort: 4321 })?.environments.find(
        (env) => env.key === 'local',
      )?.baseUrl,
    ).toBe('http://localhost:4321');
  });

  // A loopback address says nothing about remote hostnames, so guessing them from it
  // would just be noise to delete.
  it('leaves remote rows blank when starting from localhost', () => {
    const result = guess('http://localhost:3000/x');
    expect(result?.environments.find((env) => env.key === 'local')?.enabled).toBe(true);
    for (const key of ['dev', 'staging', 'prod']) {
      expect(result?.environments.find((env) => env.key === key)?.baseUrl).toBe('');
    }
  });

  it('carries a non-default port into the guessed siblings', () => {
    expect(urlFor('https://acme.com:8443/', 'staging')).toBe('https://staging.acme.com:8443');
  });

  it('omits the port when it is the https default', () => {
    expect(urlFor('https://acme.com:443/', 'staging')).toBe('https://staging.acme.com');
  });

  it('keeps the scheme of the tab it came from', () => {
    expect(urlFor('http://acme.com/', 'staging')).toBe('http://staging.acme.com:80');
  });

  it('titles the group from the page title', () => {
    expect(guess('https://acme.com/', 'Home | Acme Store')?.title).toBe('Acme Store');
  });

  it('offers the four default environments in pipeline order', () => {
    expect(guess('https://acme.com/')?.environments.map((env) => env.key)).toEqual([
      'local', 'dev', 'staging', 'prod',
    ]);
  });
});
