import { INNER } from '../duo';
import { APP_TARGET, tierFromUpgradeCheck, tierLabel, upgradeCheck, xcodeVersion } from '../sdk';
import { lineAround } from '../text';
import { blockAt, headerOf, type SwiftSource } from '../swift';
import { chainHas, chainRoot, defineGroup, PREPARE, POSE } from './engine';

// iPhone point sizes from the iPhone SE through the 17 Pro Max.
const NOT_SCREEN = /\b(?:preferredContentSize|UIGraphicsImageRenderer|thumbnail\w*|targetSize|imageSize|estimated\w*|snapshot\w*|drawHierarchy|render\w*|\w*Preview|GADAdSize\w*|adSize|bannerSize|video\w*Size|export\w*|canvas\w*|renderSize|outputSize|\w*OniPad|\w*ForPad)\b/i;
/** A few lines either side, where a size's purpose is named: `func preferredContentSize`, `renderAsImage()` on the next line. */
function around(m: string, at: number): string {
  let from = at;
  let to = at;
  for (let i = 0; i < 3 && from > 0; i++) from = m.lastIndexOf('\n', from - 1);
  for (let i = 0; i < 3 && to !== -1; i++) to = m.indexOf('\n', to + 1);
  return m.slice(Math.max(0, from), to === -1 ? m.length : to);
}

const PHONE_WIDTHS = new Set([320, 375, 390, 393, 402, 414, 428, 430, 440]);
const PHONE_HEIGHTS = new Set([568, 667, 736, 812, 844, 852, 874, 896, 926, 932, 956]);

const CONTROL = /^(?:Button|Link|Menu|NavigationLink|ShareLink|PasteButton|Toggle|Picker|TextField|SecureField|Label|ProgressView|Capsule|Rectangle|RoundedRectangle|Circle)$/;

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

  swift({ src, masked: m, report }) {
    // `CGRect(width: 320, height: 568)` is one hard-coded size, so one finding per line.
    const lines = new Set<number>();
    // `width <= 320` against a live size is a breakpoint, which adapts; `width: 320` and `== 320` pin one phone.
    // A maxWidth cap is a column, which centered-column covers.
    for (const hit of m.matchAll(/\b(width|height|minWidth|minHeight)\s*(?::|==)\s*(\d{3})(?:\.0)?\b/g)) {
      const n = Number(hit[2]);
      const isWidth = /width/i.test(hit[1]);
      // Popovers, rendered images and thumbnails have their own sizes, not the screen's.
      // 320 × 50 is the standard ad banner, not a screen.
      // A context-menu preview or popover has its own size.
      if (blockAt(src.root, hit.index!).argument === 'preview' || /presentationCompactAdaptation|popover/.test(m.slice(hit.index!, hit.index! + 120))) continue;
      if (NOT_SCREEN.test(around(m, hit.index!)) || (n === 320 && /\bheight\s*:\s*50\b/.test(lineAround(m, hit.index!)))) continue;
      // `super.init(frame: CGRect(x: 0, y: 0, width: 375, height: 250))` is a starting size; layout replaces it.
      if (/\bsuper\s*\.\s*init\s*\(\s*frame\s*:\s*CGRect\s*\([^()]*$/.test(m.slice(Math.max(0, hit.index! - 80), hit.index))) continue;
      // `let width = bounds.width > 0 ? bounds.width : 320` only falls back before the first layout pass.
      if (/\?[^:\n]*$/.test(m.slice(m.lastIndexOf('\n', hit.index!) + 1, hit.index))) continue;
      const line = m.lastIndexOf('\n', hit.index!);
      if (((isWidth && PHONE_WIDTHS.has(n)) || (!isWidth && PHONE_HEIGHTS.has(n))) && !lines.has(line)) {
        lines.add(line);
        report('fixed-device-size', hit.index!, `${n} pt is an iPhone ${isWidth ? 'screen width' : 'screen height'}; Duo windows are other sizes and change live.`);
      }
    }
    for (const hit of m.matchAll(/\.frame\s*\(\s*maxWidth\s*:\s*(\d{3})(?:\.0)?\s*[,)]/g)) {
      const n = Number(hit[1]);
      // A capped image (`.resizable()...frame(maxWidth: 400)`, or one kept to its aspect ratio) is a picture, not a column.
      const chainBefore = /(?:^|\n)[ \t]*[^\s.][^\n]*((?:\n[ \t]*\.[^\n]*)*)\n?[ \t]*$/.exec(m.slice(Math.max(0, hit.index! - 400), hit.index))?.[1] ?? '';
      if (/\.resizable\s*\(\s*\)[^{}\n]*(?:\n[ \t]*\.[^{}\n]*)*\n?[ \t]*$/.test(m.slice(Math.max(0, hit.index! - 250), hit.index)) || /\.(?:aspectRatio|scaledToFit|scaledToFill)\s*\(/.test(chainBefore)) continue;
      // A box capped both ways (`maxWidth: 350, maxHeight: 350`) is a card, not a column.
      if (/^[^)]*\bmaxHeight\s*:\s*\d/.test(m.slice(hit.index!, hit.index! + 120))) continue;
      // A capped button or progress bar is a control, not a column of content.
      if (CONTROL.test(chainRoot(src, hit.index!)?.name ?? '')) continue;
      // A few points tall is a bar or divider, not a column of content.
      if (/\bheight\s*:\s*1?\d(?:\.\d+)?\s*[,)]/.test(lineAround(m, hit.index!) + chainBefore) || chainHas(m, m.indexOf(')', hit.index!) + 1, /^frame$/, /\bheight\s*:\s*1?\d(?:\.\d+)?\s*(?:,|$)/)) continue;
      // A cap on a row, a bubble or a bar inside a screen is readable width; only a whole screen's content makes a column.
      if (!screenLevel(src, hit.index!)) continue;
      if (n >= 320 && n <= 720) report('centered-column', hit.index!, `A ${n} pt column fills about ${Math.round((n / INNER.w) * 100)}% of the open inner display.`);
    }
  },

  objc({ masked: m, report }) {
    for (const hit of m.matchAll(/\b(?:CGRectMake\s*\([^,()]*,[^,()]*,|CGSizeMake\s*\()\s*(\d{2,4})(?:\.0*)?[fF]?\s*,\s*(\d{2,4})(?:\.0*)?[fF]?\s*\)/g)) {
      const [w, h] = [Number(hit[1]), Number(hit[2])];
      if (NOT_SCREEN.test(lineAround(m, hit.index!)) || !(PHONE_WIDTHS.has(w) || PHONE_HEIGHTS.has(h))) continue;
      // `[super initWithFrame:CGRectMake(0, 0, 320, 393)]` is a starting size; layout replaces it.
      if (/\[\s*super\s+initWithFrame\s*:\s*$/.test(m.slice(Math.max(0, hit.index! - 40), hit.index))) continue;
      report('fixed-device-size', hit.index!, `${w} × ${h} pt is an iPhone screen size; Duo windows are other sizes and change live.`);
    }
  },

  plist({ plist, report }) {
    const full = plist.keys.get('UIRequiresFullScreen');
    if (full && full.value === true) report('requires-full-screen', full.offset);
  },

  pbxproj({ file, facts, report }) {
    const full = /INFOPLIST_KEY_UIRequiresFullScreen\s*=\s*YES;/.exec(file.content);
    if (full) report('requires-full-screen', full.index);
    const check = upgradeCheck(file.content);
    const tier = check ? tierFromUpgradeCheck(check.value) : '27.1';
    // A framework project builds with the app's SDK, so only the app's own project counts when there is one.
    if (check && tier !== '27.1' && (!facts.hasAppProject || APP_TARGET.test(file.content))) {
      report('old-sdk', check.offset, `Last upgraded with Xcode ${xcodeVersion(check.value)}; Duo users likely see ${tierLabel(tier)}.`);
    }
  },
});

/** Whether the chain at `at` is a screen's whole content: directly in `body` (or a pasted snippet), through ifs, switches and wrappers only. */
function screenLevel(src: SwiftSource, at: number): boolean {
  for (let b = blockAt(src.root, at); b.parent; b = b.parent) {
    const head = headerOf(src, b);
    if (/\bvar\s+body\s*:\s*some\s+View$/.test(head)) return true;
    if (!/^(?:\}\s*)?(?:else\b|if\b|switch\b|Group$|ZStack\b|NavigationStack\b|NavigationView$|ScrollView\b|GeometryReader\b)/.test(head)) return false;
  }
  return true;
}
