import { lineAround } from '../text';
import type { RuleGroup } from './engine';

const FORCED_CAMERA = /\bAVCaptureDevice\s*\.\s*default\s*\((?:[^()]|\([^()]*\))*\)\s*!(?!=)/;

export const hardware: RuleGroup = {
  id: 'hardware',
  title: 'Assumes iPhone hardware',
  seen: 'Reviewers noted that Duo unlocks with Touch ID in the side button instead of Face ID, uses an under-display selfie camera on the inner screen, and has a hole-punch camera on the outer one.',
  cause: 'Apps written for one hardware lineup hard-code Face ID copy and flows, or force-unwrap cameras that this phone doesn’t have.',
  rules: [
    {
      id: 'biometry-faceid',
      title: 'Assumes Face ID',
      severity: 'info',
      why: 'iPhone Duo has no Face ID. Unlock flows and copy written for Face ID hide the option or tell people to use hardware they don’t have.',
      instead: 'Switch on LABiometryType and handle .touchID, and word prompts generically (“Unlock with biometrics”, or the type’s name at runtime).',
      source: 'Apple LocalAuthentication documentation (LABiometryType)',
    },
    {
      id: 'camera-hardware',
      title: 'Assumes a specific camera',
      severity: 'warning',
      why: 'Duo’s cameras differ from the Pro iPhones, and with no Face ID there is no TrueDepth camera. Force-unwrapping a lens that isn’t there crashes.',
      instead: 'Find cameras with AVCaptureDevice.DiscoverySession, fall back gracefully, and never force-unwrap a device.',
      source: 'Apple AVFoundation documentation (Choosing a capture device)',
    },
  ],

  swift({ file, src, masked: m, report }) {
    if (!/\.touchID\b/.test(m)) {
      for (const hit of m.matchAll(/\.faceID\b/g)) report('biometry-faceid', hit.index!);
    }
    // Copy lives in strings, which the mask blanks: look at the raw text inside strings.
    for (const hit of file.content.matchAll(/Face ID/g)) {
      const i = hit.index!;
      // Copy that already offers Touch ID or a passcode reads fine on Duo.
      if (src.strings[i] && src.strings[i + 6] && !/Touch ID|fingerprint|passcode/i.test(stringAround(src.strings, file.content, i))) {
        report('biometry-faceid', i, 'User-facing text mentions Face ID, which iPhone Duo doesn’t have.');
      }
    }

    for (const hit of m.matchAll(new RegExp(FORCED_CAMERA, 'g'))) {
      report('camera-hardware', hit.index!, 'Force-unwrapping a capture device crashes when that camera isn’t there.');
    }
    for (const hit of m.matchAll(/\.builtInTrueDepthCamera\b/g)) {
      if (!FORCED_CAMERA.test(lineAround(m, hit.index!))) report('camera-hardware', hit.index!, 'The TrueDepth camera comes with Face ID; iPhone Duo has neither.');
    }
  },
};

/** The whole string literal that contains `at`. */
function stringAround(strings: Uint8Array, text: string, at: number): string {
  let from = at;
  let to = at;
  while (from > 0 && strings[from - 1]) from--;
  while (to < text.length && strings[to]) to++;
  return text.slice(from, to);
}
