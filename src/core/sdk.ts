// What the Xcode project says about the SDK an app is built with and the iOS it deploys to.

import type { SdkTier } from './types';

const LAST_UPGRADE = /LastUpgradeCheck\s*=\s*(\d{4});/;
const DEPLOYMENT_TARGET = /IPHONEOS_DEPLOYMENT_TARGET\s*=\s*"?(\d+(?:\.\d+)?)"?\s*;/g;

/** `LastUpgradeCheck` from a project.pbxproj, e.g. "2600", with its offset. */
export function upgradeCheck(pbxproj: string): { value: string; offset: number } | null {
  const hit = LAST_UPGRADE.exec(pbxproj);
  return hit ? { value: hit[1], offset: hit.index } : null;
}

/** The lowest iOS deployment target across the project's build configurations. */
export function deploymentTarget(pbxproj: string): number | null {
  let lowest: number | null = null;
  for (const hit of pbxproj.matchAll(DEPLOYMENT_TARGET)) {
    const v = Number(hit[1]);
    if (lowest === null || v < lowest) lowest = v;
  }
  return lowest;
}

export function xcodeVersion(check: string): string {
  return `${Number(check.slice(0, 2))}.${Number(check[2])}`;
}

export function tierFromUpgradeCheck(check: string): SdkTier {
  const n = Number(check);
  if (n >= 2710) return '27.1';
  if (n >= 2700) return '27';
  return '26';
}

export function tierLabel(tier: SdkTier): string {
  return tier === '26' ? 'a centered iPhone-sized window' : tier === '27' ? 'an almost-full inner display' : 'the full edge-to-edge layout';
}
