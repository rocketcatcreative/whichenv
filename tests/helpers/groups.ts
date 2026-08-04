/**
 * Building groups and drafts for tests.
 *
 * Ten test files had grown their own copy of "make a draft, then map over its environments
 * filling in the ones I care about". That worked only while a blank draft happened to contain
 * the four environments those tests wanted. The moment a new group started with production
 * alone, every one of those helpers silently produced a group with one environment in it, and
 * ten files failed for one reason.
 *
 * So the shape is inverted here: the URLs you pass ARE the environments. Nothing depends on
 * what a blank draft happens to contain, which is the property that was missing.
 */

import { draftToGroup, emptyDraft, newEnvironmentDraft, type EnvGroup, type GroupDraft } from '../../src/core/schema';
import { byPipelineOrder, type EnvKey } from '../../src/core/palette';

/** A fixed timestamp, so nothing in a test depends on the clock. */
export const NOW = 1_700_000_000_000;

export type Urls = Partial<Record<EnvKey, string>>;

/**
 * A draft with exactly one row per URL given, in pipeline order.
 *
 * An empty string is meaningful and preserved: it is a row the user has added but not filled
 * in, which is a state the editor and the validator both have to handle.
 */
export function draftWith(id: string, title: string, urls: Urls, tweak?: (draft: GroupDraft) => void): GroupDraft {
  const draft = emptyDraft(id);
  draft.title = title;

  const keys = (Object.keys(urls) as EnvKey[]).sort(byPipelineOrder);
  draft.environments = keys.map((key) => ({
    ...newEnvironmentDraft(key),
    baseUrl: urls[key] ?? '',
    // An environment with nowhere to go cannot be enabled; the schema enforces this too, and
    // a test that sets up an impossible state is testing nothing.
    enabled: Boolean(urls[key]),
  }));

  tweak?.(draft);
  return draft;
}

/** The same, normalised into what actually reaches storage. */
export function groupWith(id: string, title: string, urls: Urls, tweak?: (draft: GroupDraft) => void): EnvGroup {
  return draftToGroup(draftWith(id, title, urls, tweak), NOW);
}

/** The group most tests want: one site, three environments, one of them loopback. */
export function acmeGroup(id = 'acme', title = 'Acme Storefront'): EnvGroup {
  return groupWith(id, title, {
    local: 'http://localhost:3000',
    staging: 'https://staging.acme.example',
    prod: 'https://acme.example',
  });
}
