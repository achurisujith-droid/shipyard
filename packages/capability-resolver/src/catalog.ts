import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

import type { Capability, ServiceOffer, Vendor } from '@shipyard/shared';

/**
 * Read the catalog from disk.
 *
 * Capabilities, vendors and services are data for the same reason the rules
 * are: what Shipyard recommends should be changeable without shipping a new
 * desktop app, and reviewable as a diff when it changes.
 */

async function loadJsonDir<T>(directory: string): Promise<T[]> {
  const entries = await readdir(directory).catch(() => [] as string[]);
  const files = entries.filter((name) => name.endsWith('.json')).sort();
  const all: T[] = [];
  for (const file of files) {
    const raw = await readFile(path.join(directory, file), 'utf8');
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) throw new Error(`${file}: expected an array`);
    all.push(...(parsed as T[]));
  }
  return all;
}

export interface Catalog {
  capabilities: Capability[];
  vendors: Vendor[];
  services: ServiceOffer[];
}

/** Load everything under `shipyard-catalog/`. */
export async function loadCatalog(root: string): Promise<Catalog> {
  const [capabilities, vendors, services] = await Promise.all([
    loadJsonDir<Capability>(path.join(root, 'capabilities')),
    loadJsonDir<Vendor>(path.join(root, 'vendors')),
    loadJsonDir<ServiceOffer>(path.join(root, 'services')),
  ]);

  for (const list of [capabilities, vendors, services] as { id: string }[][]) {
    const seen = new Set<string>();
    for (const item of list) {
      if (seen.has(item.id)) throw new Error(`duplicate catalog id "${item.id}"`);
      seen.add(item.id);
    }
  }

  return { capabilities, vendors, services };
}

/**
 * Free-tier information we are willing to repeat, or nothing.
 *
 * Free tiers change without notice, and a limit quoted from memory is a
 * confident wrong answer a founder will plan around. So the catalog may hold
 * unverified entries, and this is the only way to read them: no verification
 * date, nothing shown.
 */
export function displayableFreeTier(vendor: Vendor): Vendor['freeTier'] | null {
  const tier = vendor.freeTier;
  if (!tier?.available) return null;
  if (!tier.sourceUrl) return null;
  // A date, not a word. `unverified` is the honest placeholder for an entry
  // nobody has checked yet, and it must not reach a user.
  if (Number.isNaN(Date.parse(tier.lastVerifiedAt))) return null;
  return tier;
}

/** Services the given triggers justify offering, in catalog order. */
export function offersFor(triggers: string[], services: ServiceOffer[]): ServiceOffer[] {
  const wanted = new Set(triggers);
  return services.filter((service) => service.enabled && wanted.has(service.id));
}
