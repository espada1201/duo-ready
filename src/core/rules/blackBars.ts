import { INNER } from '../duo';
import { tierFromUpgradeCheck, tierLabel, upgradeCheck, xcodeVersion } from '../sdk';
import { lineAround } from '../text';
import { defineGroup, PREPARE, POSE } from './engine';

// iPhone point sizes from the iPhone SE through the 17 Pro Max.
const NOT_SCREEN = /\b(?:preferredContentSize|UIGraphicsImageRenderer|thumbnail\w*|targetSize|imageSize|GADAdSize\w*|adSize|bannerSize)\b/i;
const PHONE_WIDTHS = new Set([320, 375, 390, 393, 402, 414, 428, 430, 440]);
const PHONE_HEIGHTS = new Set([568, 667, 736, 812, 844, 852, 874, 896, 926, 932, 956]);

export const blackBars = defineGroup({
  id: 'black-bars',
  title: 'Black bars',
  seen: 'MKBHD and others found apps sitting in a window with black bars around it on the inner display.',
  cause: 'iOS keeps old apps in an iPhone-sized window until they are rebuilt with the iOS 27.1 SDK, and apps that hard-code iPhone sizes stay narrow even after a rebuild.',
  rules: [
    {
      id: 'old-sdk',
      title: 'Project last upgraded before Xcode 27.1',
      severity: 'warning',
      why: 'Apps built with the iOS 26 SDK open in a centered iPhone-sized window; the iOS 27 SDK fills most of the inner display; only the iOS 27.1 SDK goes edge to edge.',
      instead: 'Build with Xcode 27.1 and test every pose in the iPhone Duo simulator.',
      source: PREPARE,
      project: true,
    },
    {
      id: 'requires-full-screen',
      title: 'UIRequiresFullScreen is set',
      severity: 'info',
      why: 'Apple still honors it, but your app is resized anyway every time the phone opens or closes.',
      instead: 'Drop it once the app handles live resizing.',
      source: PREPARE,
      project: true,
    },
    {
      id: 'fixed-device-size',
      title: 'Hard-coded iPhone screen size',
      severity: 'warning',
      why: 'Fixed iPhone widths and heights cause the stretched or tiny layouts reviewers saw. Duo windows resize live as the phone opens and closes.',
      instead: 'Size views relative to their container with stacks, flexible frames or Auto Layout.',
      source: PREPARE,
    },
    {
      id: 'centered-column',
      title: 'Centered fixed-width column',
      severity: 'info',
      why: 'A narrow centered column leaves both sides of the inner display empty, and the hinge runs through its middle when folded.',
      instead: 'Audit centered layouts: consider a two-column ArrangementView, or displace content around the hinge.',
      source: POSE,
    },
  ],

  swift({ masked: m, report }) {
    // `CGRect(width: 320, height: 568)` is one hard-coded size, so one finding per line.
    const lines = new Set<number>();
    for (const hit of m.matchAll(/\b(width|height|maxWidth|maxHeight|minWidth|minHeight)\s*(?::|==|<=|>=|<|>)\s*(\d{3})(?:\.0)?\b/g)) {
      const n = Number(hit[2]);
      const isWidth = /width/i.test(hit[1]);
      // Popovers, rendered images and thumbnails have their own sizes, not the screen's.
      if (NOT_SCREEN.test(lineAround(m, hit.index!))) continue;
      const line = m.lastIndexOf('\n', hit.index!);
      if (((isWidth && PHONE_WIDTHS.has(n)) || (!isWidth && PHONE_HEIGHTS.has(n))) && !lines.has(line)) {
        lines.add(line);
        report('fixed-device-size', hit.index!, `${n} pt is an iPhone ${isWidth ? 'screen width' : 'screen height'}; Duo windows are other sizes and change live.`);
      }
    }
    for (const hit of m.matchAll(/\.frame\s*\(\s*maxWidth\s*:\s*(\d{3})(?:\.0)?\s*[,)]/g)) {
      const n = Number(hit[1]);
      // A capped image (`.resizable()...frame(maxWidth: 400)`) is a picture, not a column.
      if (/\.resizable\s*\(\s*\)[^{}\n]*(?:\n[ \t]*\.[^{}\n]*)*\n?[ \t]*$/.test(m.slice(Math.max(0, hit.index! - 250), hit.index))) continue;
      if (n >= 320 && n <= 720) report('centered-column', hit.index!, `A ${n} pt column fills about ${Math.round((n / INNER.w) * 100)}% of the open inner display.`);
    }
  },

  plist({ plist, report }) {
    const full = plist.keys.get('UIRequiresFullScreen');
    if (full && full.value === true) report('requires-full-screen', full.offset);
  },

  pbxproj({ file, report }) {
    const full = /INFOPLIST_KEY_UIRequiresFullScreen\s*=\s*YES;/.exec(file.content);
    if (full) report('requires-full-screen', full.index);
    const check = upgradeCheck(file.content);
    const tier = check ? tierFromUpgradeCheck(check.value) : '27.1';
    if (check && tier !== '27.1') {
      report('old-sdk', check.offset, `Last upgraded with Xcode ${xcodeVersion(check.value)}; Duo users likely see ${tierLabel(tier)}.`);
    }
  },
});
