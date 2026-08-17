import type { FeatureType } from '@shared/taxonomy';
import type { SourceRow } from '@shared/types';

/**
 * What a new install should harvest before it is useful.
 *
 * A fresh catalog has 44 seeded sources and zero features, so every search returns
 * nothing and the app looks broken. The wizard exists to get from that state to a working
 * one without asking someone to understand the registry first.
 *
 * The starter set is chosen, not "everything": harvesting all of Tier A takes a long time
 * and pulls 6,000 census tracts and 1,600 postal areas that a broadcast artist may never
 * ask for, while the boundaries they will ask for on night one -- ridings, provinces,
 * municipalities, reserves -- are a few minutes' work.
 */

/**
 * Feature types worth having before first use, most important first.
 *
 * Ordered by what a newsroom actually asks for. Federal ridings lead because election
 * night is the case the whole app is shaped around.
 */
export const STARTER_TYPES: FeatureType[] = [
  'federal_electoral_district',
  'province_territory',
  'provincial_electoral_district',
  'indian_reserve',
  'census_subdivision',
  'municipality',
  'census_division',
];

export type StarterPlan = 'essential' | 'tier-a' | 'skip';

export interface StarterSelection {
  sourceIds: number[];
  /** Sources left out, with the reason, so the choice is visible rather than implicit. */
  excluded: { name: string; reason: string }[];
  /** Total bytes of Tier B archives included. Zero for every plan but 'tier-a'. */
  downloadBytes: number;
}

/**
 * Picks the sources a plan should harvest.
 *
 * Tier B is excluded from every plan. Those are whole-file downloads -- 197 MB for
 * dissemination areas alone -- and the brief makes them explicitly user-triggered. A
 * first-run wizard quietly pulling half a gigabyte would be exactly the opposite.
 *
 * Sources already harvested are excluded too, so re-running the wizard after a partial
 * first attempt picks up where it stopped instead of re-fetching what is already indexed.
 */
export function selectStarterSources(sources: SourceRow[], plan: StarterPlan): StarterSelection {
  const excluded: { name: string; reason: string }[] = [];
  if (plan === 'skip') {
    return { sourceIds: [], excluded: [], downloadBytes: 0 };
  }

  const chosen: SourceRow[] = [];

  for (const source of sources) {
    if (source.tier === 'B') {
      excluded.push({ name: source.name, reason: 'a bulk download; start these yourself when you need them' });
      continue;
    }
    if (source.kind === 'arcgis-hub' || source.kind === 'ckan') {
      excluded.push({ name: source.name, reason: 'a discovery catalog, not a boundary layer' });
      continue;
    }
    if (source.status === 'ok') {
      excluded.push({ name: source.name, reason: 'already harvested' });
      continue;
    }
    if (source.status === 'disabled') {
      excluded.push({ name: source.name, reason: 'disabled' });
      continue;
    }
    if (plan === 'essential' && !STARTER_TYPES.includes(source.feature_type)) {
      excluded.push({ name: source.name, reason: 'not in the essential set' });
      continue;
    }
    chosen.push(source);
  }

  // Harvest in the order the types matter, so a cancelled run leaves the most useful
  // boundaries indexed rather than whichever happened to be first in the registry.
  const rank = (s: SourceRow): number => {
    const i = STARTER_TYPES.indexOf(s.feature_type);
    return i === -1 ? STARTER_TYPES.length : i;
  };
  chosen.sort((a, b) => rank(a) - rank(b) || a.id - b.id);

  return { sourceIds: chosen.map((s) => s.id), excluded, downloadBytes: 0 };
}

/**
 * Whether the wizard should appear.
 *
 * Keyed on the catalog being empty rather than on a "have I run before" flag alone: an
 * install whose first harvest failed, or whose database was deleted to reclaim space, is
 * back in the state the wizard is for. The stored flag only suppresses it for someone who
 * deliberately chose to skip.
 */
export function shouldShowWizard(opts: {
  featureCount: number;
  completedAt: string | null;
}): boolean {
  if (opts.featureCount > 0) return false;
  return opts.completedAt === null;
}
