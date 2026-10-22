import { describe, expect, it } from 'vitest';
import { applyFixes, audit } from '../../src/core/audit';
import { PAIN_POINTS } from '../../src/core/painPoints';
import { RULES } from '../../src/core/rules';
import type { SourceFile } from '../../src/core/types';

const swift = (content: string): SourceFile[] => [{ path: 'A.swift', content }];
const ids = (content: string) => audit(swift(content)).findings.map((f) => f.ruleId);

describe('pain point map', () => {
  it('files every rule under exactly one reviewer pain point', () => {
    const filed = PAIN_POINTS.flatMap((p) => p.rules);
    expect([...filed].sort()).toEqual(RULES.map((r) => r.id).sort());
    for (const p of PAIN_POINTS) expect(p.cause.length).toBeGreaterThan(20);
  });
});

describe('fold continuity', () => {
  it('flags views swapped on size class, which lose their state on fold', () => {
    expect(ids('if sizeClass == .compact {\n  Compact()\n} else {\n  Wide()\n}')).toEqual(['state-reset']);
    expect(ids('Player().id(UUID())')).toEqual(['state-reset']);
    expect(ids('if sizeClass == .compact {\n  Compact()\n}')).toEqual([]);
    expect(ids('let layout = sizeClass == .compact ? AnyLayout(VStackLayout()) : AnyLayout(HStackLayout())')).toEqual([]);
  });

  it('flags code that assumes one window', () => {
    expect(ids('let w = UIApplication.shared.windows.first\nlet k = UIApplication.shared.keyWindow')).toEqual(['key-window', 'key-window']);
    expect(ids('let s = UIApplication.shared.connectedScenes.first')).toEqual(['key-window']);
    expect(ids('let w = view.window')).toEqual([]);
  });
});

describe('small or stretched', () => {
  it('flags fixed font sizes unless they scale with Dynamic Type', () => {
    expect(ids('Text("a").font(.system(size: 14))\nlabel.font = UIFont.systemFont(ofSize: 12)')).toEqual(['fixed-font', 'fixed-font']);
    expect(ids('Text("a").font(.custom("Inter", size: 14, relativeTo: .body))')).toEqual([]);
    expect(ids('label.font = UIFontMetrics.default.scaledFont(for: UIFont.systemFont(ofSize: 12))')).toEqual([]);
  });

  it('flags resizable images with no aspect ratio, with a review fix', () => {
    const code = 'Image("art")\n  .resizable()\n  .frame(width: 100)';
    expect(ids(code)).toEqual(['stretched-image']);
    const fixed = applyFixes(swift(code), audit(swift(code)).findings, 'all').files[0].content;
    expect(fixed).toBe('Image("art")\n  .resizable()\n  .scaledToFit()\n  .frame(width: 100)');
    expect(ids('Image("art").resizable().aspectRatio(contentMode: .fill)')).toEqual([]);
    expect(ids('Image("art").resizable().scaledToFill()')).toEqual([]);
    expect(ids('Image("tile").resizable(resizingMode: .tile)')).toEqual([]);
    expect(ids('imageView.contentMode = .scaleToFill')).toEqual(['stretched-image']);
  });
});

describe('hardware assumptions', () => {
  it('flags Face ID-only flows and copy', () => {
    expect(ids('if context.biometryType == .faceID { showUnlock() }')).toEqual(['biometry-faceid']);
    expect(ids('button.setTitle("Unlock with Face ID", for: .normal)')).toEqual(['biometry-faceid']);
    expect(ids('switch context.biometryType {\ncase .faceID: a()\ncase .touchID: b()\ndefault: c()\n}')).toEqual([]);
    expect(ids('// Face ID is great')).toEqual([]);
  });

  it('flags force-unwrapped lenses and the TrueDepth camera', () => {
    expect(ids('let d = AVCaptureDevice.default(.builtInTripleCamera, for: .video, position: .back)!')).toEqual(['camera-hardware']);
    expect(ids('let d = AVCaptureDevice.default(.builtInTrueDepthCamera, for: .video, position: .front)')).toEqual(['camera-hardware']);
    expect(ids('guard let d = AVCaptureDevice.default(for: .video) else { return }')).toEqual([]);
  });
});

describe('hinge and edges', () => {
  it('flags full-screen video and camera previews that ignore the hinge', () => {
    expect(ids('let layer = AVPlayerLayer(player: p)')).toEqual(['hinge-media']);
    expect(ids('VideoPlayer(player: p)')).toEqual(['hinge-media']);
    expect(ids('VideoPlayer(player: p)\nGeometryReader { proxy in let r = proxy.reservedRegions(kind: .division) }')).toEqual([]);
  });

  it('flags screen-edge pans', () => {
    expect(ids('let pan = UIScreenEdgePanGestureRecognizer(target: self, action: #selector(back))')).toEqual(['edge-gesture']);
  });
});
