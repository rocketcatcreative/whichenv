import { describe, expect, it } from 'vitest';
import { allowsDataImages } from '../../src/core/csp';

const allows = (...policies: string[]): boolean => allowsDataImages(policies);

describe('allowsDataImages', () => {
  it('allows when there is no policy at all', () => {
    expect(allows()).toBe(true);
    expect(allows('')).toBe(true);
    expect(allows('   ')).toBe(true);
  });

  it('allows when the policy says nothing about images', () => {
    expect(allows("script-src 'self'; frame-ancestors 'none'")).toBe(true);
  });

  it('blocks the policy that started all this', () => {
    expect(allows("default-src 'self'; img-src 'self'")).toBe(false);
  });

  it('allows an explicit data:', () => {
    expect(allows("img-src 'self' data:")).toBe(true);
    expect(allows('img-src data:')).toBe(true);
  });

  // The mistake worth guarding: `*` matches network schemes only, so it does NOT permit
  // a data URL. Reading it as permissive would mean writing a composite the browser then
  // throws away, with no way to notice.
  it('does not treat a wildcard as permitting data:', () => {
    expect(allows('img-src *')).toBe(false);
    expect(allows('img-src * https:')).toBe(false);
  });

  it('falls back to default-src when img-src is absent', () => {
    expect(allows("default-src 'self'")).toBe(false);
    expect(allows("default-src 'self' data:")).toBe(true);
  });

  it('prefers img-src over default-src when both are present', () => {
    expect(allows("default-src 'self'; img-src 'self' data:")).toBe(true);
    expect(allows("default-src data:; img-src 'self'")).toBe(false);
  });

  it("treats 'none' and an empty list as blocking", () => {
    expect(allows("img-src 'none'")).toBe(false);
    expect(allows('img-src')).toBe(false);
    expect(allows("img-src ;script-src 'self'")).toBe(false);
  });

  it('is case insensitive on directive names but not on values', () => {
    expect(allows("IMG-SRC 'self' DATA:")).toBe(true);
    expect(allows("Img-Src 'Self'")).toBe(false);
  });

  it('ignores a duplicate directive, since the first declaration wins', () => {
    expect(allows("img-src 'self'; img-src data:")).toBe(false);
    expect(allows("img-src data:; img-src 'self'")).toBe(true);
  });

  // Policies are cumulative, not overriding: one restrictive policy is enough.
  it('requires every policy in force to allow it', () => {
    expect(allows("img-src 'self' data:", "img-src 'self'")).toBe(false);
    expect(allows("img-src 'self' data:", 'img-src data:')).toBe(true);
  });

  it('tolerates odd whitespace and trailing separators', () => {
    expect(allows("  img-src   'self'   data:  ;  ")).toBe(true);
    expect(allows('\nimg-src\tdata:\n')).toBe(true);
  });
});
