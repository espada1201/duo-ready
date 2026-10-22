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
    for (const hit of file.content.matchAll(/Face ID/g)) {
      const i = hit.index!;
      const note = /\bcomment\s*:\s*@?"[^"\n]*$|NSLocalizedString\s*\(\s*@"[^"\n]*"\s*,\s*@"[^"\n]*$/.test(file.content.slice(Math.max(0, i - 200), i));
      if (strings[i] && strings[i + 6] && !note && !/Touch ID|fingerprint|passcode/i.test(lineAround(file.content, i))) {
        report('biometry-faceid', i, 'User-facing text mentions Face ID, which iPhone Duo doesn’t have.');
      }
    }
    for (const hit of m.matchAll(/\bAVCaptureDeviceTypeBuiltInTrueDepthCamera\b/g)) {
      const open = m.lastIndexOf('@[', hit.index!);
      const close = m.indexOf(']', hit.index!);
      const list = open !== -1 && close !== -1 && !m.slice(open, hit.index).includes(']') ? m.slice(open, close) : '';
      if ((list.match(/\bAVCaptureDeviceTypeBuiltIn\w+/g) ?? []).length < 2) report('camera-hardware', hit.index!, 'The TrueDepth camera comes with Face ID; iPhone Duo has neither.');
    }
  },

  swift({ file, src, masked: m, report }) {
    if (!/\.touchID\b/.test(m)) {
      for (const hit of m.matchAll(/\.faceID\b/g)) report('biometry-faceid', hit.index!);
    }
    // Copy lives in strings, which the mask blanks: look at the raw text inside strings.
    for (const hit of file.content.matchAll(/Face ID/g)) {
      const i = hit.index!;
      // Copy on the same line that also offers Touch ID or a passcode reads fine on Duo; the line,
      // not the literal, so interpolation inside the string doesn't hide the alternative.
      // A translator note (`NSLocalizedString(..., comment: "...")`) is never shown.
      const note = /\bcomment\s*:\s*"[^"\n]*$/.test(file.content.slice(Math.max(0, i - 200), i));
      if (src.strings[i] && src.strings[i + 6] && !note && !/Touch ID|fingerprint|passcode/i.test(lineAround(file.content, i))) {
        report('biometry-faceid', i, 'User-facing text mentions Face ID, which iPhone Duo doesn’t have.');
      }
    }

    for (const hit of m.matchAll(new RegExp(FORCED_CAMERA, 'g'))) {
      report('camera-hardware', hit.index!, 'Force-unwrapping a capture device crashes when that camera isn’t there.');
    }
    for (const hit of m.matchAll(/\.builtInTrueDepthCamera\b/g)) {
      // One lens among several in a discovery list is the pattern this rule recommends.
      const open = m.lastIndexOf('[', hit.index!);
      const close = m.indexOf(']', hit.index!);
      const list = open !== -1 && close !== -1 && !m.slice(open, hit.index).includes(']') && !m.slice(hit.index, close).includes('[') ? m.slice(open, close) : '';
      if ((list.match(/\.builtIn\w+/g) ?? []).length > 1) continue;
      if (!FORCED_CAMERA.test(lineAround(m, hit.index!))) report('camera-hardware', hit.index!, 'The TrueDepth camera comes with Face ID; iPhone Duo has neither.');
    }
  },
});
