import { beforeEach, describe, expect, it } from 'vitest';
import { installFakeChrome, type FakeChrome } from '../helpers/fake-chrome';
import { syncRegistrations } from '../../src/background/scripts';
import { ALL_URLS } from '../../src/core/permissions';

let fake: FakeChrome;

beforeEach(() => {
  fake = installFakeChrome();
});

const matches = () => fake.__scripts[0]?.matches ?? [];

describe('syncRegistrations', () => {
  it('registers nothing when no remote origin is granted', async () => {
    await syncRegistrations();
    expect(fake.__scripts).toEqual([]);
  });

  it('registers the content script for a granted origin', async () => {
    fake.__granted.add('https://acme.example/*');
    await syncRegistrations();

    expect(fake.__scripts).toHaveLength(1);
    expect(fake.__scripts[0]?.id).toBe('es-indicator');
    expect(fake.__scripts[0]?.js).toEqual(['content/indicator.js']);
    expect(matches()).toEqual(['https://acme.example/*']);
  });

  // The manifest already covers loopback, so registering it again would be a
  // duplicate injection on every local page.
  it('excludes origins the manifest already covers', async () => {
    fake.__granted.add('http://localhost/*');
    fake.__granted.add('http://127.0.0.1/*');
    await syncRegistrations();
    expect(fake.__scripts).toEqual([]);
  });

  it('collapses to the single blanket pattern when that is granted', async () => {
    fake.__granted.add(ALL_URLS);
    fake.__granted.add('https://acme.example/*');
    await syncRegistrations();
    expect(matches()).toEqual([ALL_URLS]);
  });

  it('updates in place rather than failing on a duplicate id', async () => {
    fake.__granted.add('https://acme.example/*');
    await syncRegistrations();

    fake.__granted.add('https://staging.acme.example/*');
    await syncRegistrations();

    expect(fake.__scripts).toHaveLength(1);
    expect(matches()).toEqual([
      'https://acme.example/*',
      'https://staging.acme.example/*',
    ]);
  });

  // It runs on every permission change and every group change, so a no-op has to be
  // genuinely cheap and must not churn the registration.
  it('is a no-op when nothing has changed', async () => {
    fake.__granted.add('https://acme.example/*');
    await syncRegistrations();
    const before = fake.__scripts[0];

    await syncRegistrations();
    expect(fake.__scripts[0]).toBe(before);
  });

  it('unregisters when the last remote origin is revoked', async () => {
    fake.__granted.add('https://acme.example/*');
    await syncRegistrations();
    expect(fake.__scripts).toHaveLength(1);

    fake.__granted.delete('https://acme.example/*');
    await syncRegistrations();
    expect(fake.__scripts).toEqual([]);
  });

  it('is idempotent when there is nothing to unregister', async () => {
    await syncRegistrations();
    await syncRegistrations();
    expect(fake.__scripts).toEqual([]);
  });

  it('registers to survive a browser restart', async () => {
    fake.__granted.add('https://acme.example/*');
    await syncRegistrations();
    // persistAcrossSessions matters: a page loaded before the worker wakes still
    // needs its indicator.
    expect(
      (fake.__scripts[0] as { persistAcrossSessions?: boolean }).persistAcrossSessions,
    ).toBe(true);
  });
});
