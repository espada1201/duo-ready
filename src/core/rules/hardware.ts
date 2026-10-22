import { lineAround } from '../text';
import { defineGroup } from './engine';

const FORCED_CAMERA = /\bAVCaptureDevice\s*\.\s*default\s*\((?:[^()]|\([^()]*\))*\)\s*!(?!=)/;

export const hardware = defineGroup({
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

  objc({ file, masked: m, strings, report }) {
    if (!/\bLABiometryTypeTouchID\b/.test(m)) {
      for (const hit of m.matchAll(/\bLABiometryTypeFaceID\b/g)) report('biometry-faceid', hit.index!);
    }
    for (const i of faceIdCopy(file.content, strings, /\bcomment\s*:\s*@?"[^"\n]*$|NSLocalizedString\s*\(\s*@"[^"\n]*"\s*,\s*@"[^"\n]*$/)) report('biometry-faceid', i, FACE_ID_COPY);
    for (const hit of m.matchAll(/\bAVCaptureDeviceTypeBuiltInTrueDepthCamera\b/g)) {
      if (!amongLenses(m, hit.index!, '@[', /\bAVCaptureDeviceTypeBuiltIn\w+/g)) report('camera-hardware', hit.index!, TRUE_DEPTH);
    }
  },

  swift({ file, src, masked: m, report }) {
    if (!/\.touchID\b/.test(m)) {
      for (const hit of m.matchAll(/\.faceID\b/g)) report('biometry-faceid', hit.index!);
    }
    for (const i of faceIdCopy(file.content, src.strings, /\bcomment\s*:\s*"[^"\n]*$/)) report('biometry-faceid', i, FACE_ID_COPY);

    for (const hit of m.matchAll(new RegExp(FORCED_CAMERA, 'g'))) {
      report('camera-hardware', hit.index!, 'Force-unwrapping a capture device crashes when that camera isn’t there.');
    }
    for (const hit of m.matchAll(/\.builtInTrueDepthCamera\b/g)) {
      if (!amongLenses(m, hit.index!, '[', /\.builtIn\w+/g) && !FORCED_CAMERA.test(lineAround(m, hit.index!))) report('camera-hardware', hit.index!, TRUE_DEPTH);
    }
  },
});

const FACE_ID_COPY = 'User-facing text mentions Face ID, which iPhone Duo doesn’t have.';
const TRUE_DEPTH = 'The TrueDepth camera comes with Face ID; iPhone Duo has neither.';

/**
 * Offsets of "Face ID" in user-facing strings. Copy lives in strings, which the mask blanks, so this reads
 * the raw text. A line that also offers Touch ID or a passcode reads fine on Duo (the line, not the literal,
 * so interpolation can't hide the alternative), and a translator `note` is never shown.
 */
function faceIdCopy(content: string, strings: Uint8Array, note: RegExp): number[] {
  return [...content.matchAll(/Face ID/g)]
    .map((hit) => hit.index!)
    .filter((i) => strings[i] && strings[i + 6] && !note.test(content.slice(Math.max(0, i - 200), i)) && !/Touch ID|fingerprint|passcode/i.test(lineAround(content, i)));
}

/** Whether the lens at `at` is one of several in a discovery list opened by `open`, the pattern camera-hardware recommends. */
function amongLenses(m: string, at: number, open: string, lens: RegExp): boolean {
  const from = m.lastIndexOf(open, at);
  const close = m.indexOf(']', at);
  if (from === -1 || close === -1 || m.slice(from, at).includes(']') || m.slice(at, close).includes('[')) return false;
  return (m.slice(from, close).match(lens) ?? []).length > 1;
}
