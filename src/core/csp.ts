/**
 * Whether a page's Content Security Policy permits a `data:` image.
 *
 * This decides whether the tab icon can be a composite of the site's own favicon (which
 * has to be generated, so it can only be a data URL) or must fall back to the packaged
 * mark. Pure and string based so the rules are testable without a browser.
 *
 * The trap this replaced: a content script runs in an isolated world and is NOT subject
 * to the page's CSP for its own requests, so "load a data URL and see if it works" always
 * says yes. The browser's favicon fetch, on the other hand, IS subject to it. Probing
 * from the content script measured the wrong thing entirely.
 */

/** Directives that govern images, in the order CSP falls back through them. */
const IMAGE_DIRECTIVES = ['img-src', 'default-src'];

/**
 * Splits one policy string into directives.
 *
 * Names are case insensitive and values are not; separators are semicolons, and empty
 * segments are legal and ignored.
 */
function directivesOf(policy: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const segment of policy.split(';')) {
    const parts = segment.trim().split(/\s+/).filter(Boolean);
    const name = parts.shift()?.toLowerCase();
    // First declaration of a directive wins; later duplicates are ignored, per spec.
    if (name && !out.has(name)) out.set(name, parts);
  }
  return out;
}

/**
 * Whether ONE policy allows a data: image.
 *
 * Note that `*` does NOT allow it. The wildcard matches network schemes only, so a policy
 * of `img-src *` still refuses a data URL. Getting that backwards would mean confidently
 * writing a composite that the browser then throws away.
 */
function policyAllows(policy: string): boolean {
  const directives = directivesOf(policy);
  const name = IMAGE_DIRECTIVES.find((candidate) => directives.has(candidate));
  // No image directive and no default-src: images are unrestricted by this policy.
  if (!name) return true;

  const values = directives.get(name) ?? [];
  // An empty directive list is equivalent to 'none'.
  if (values.length === 0) return false;
  if (values.some((value) => value.toLowerCase() === "'none'")) return false;

  return values.some((value) => value.toLowerCase().replace(/;$/, '') === 'data:');
}

/**
 * Whether EVERY policy in force allows a data: image.
 *
 * Multiple policies are cumulative rather than overriding: a resource has to satisfy all
 * of them, so one restrictive policy is enough to rule the composite out.
 */
export function allowsDataImages(policies: readonly string[]): boolean {
  return policies.filter((policy) => policy.trim().length > 0).every(policyAllows);
}
