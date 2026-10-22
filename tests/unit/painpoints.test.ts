import { describe, expect, it } from 'vitest';
import { applyFixes, audit } from '../../src/core/audit';
import { PAIN_POINTS, RULES } from '../../src/core/rules';
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

describe('partial audits', () => {
  it('caps the grade when no Info.plist or Xcode project was given', () => {
    const pasted = audit(swift('let x = 1'));
    expect(pasted).toMatchObject({ score: 100, partial: true, grade: 'Close' });
    const project = audit([...swift('let x = 1'), { path: 'A.xcodeproj/project.pbxproj', content: 'LastUpgradeCheck = 2710;' }]);
    expect(project).toMatchObject({ partial: false, grade: 'Duo-ready' });
  });

  it('marks project-level rules so the lab can say they were not checked', () => {
    expect(RULES.filter((r) => r.project).map((r) => r.id).sort()).toEqual(['old-sdk', 'portrait-only', 'requires-full-screen']);
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

describe('web content and games', () => {
  it('flags web viewports pinned to a phone width, in HTML files and Swift strings', () => {
    const html = audit([{ path: 'Web/index.html', content: '<head><meta name="viewport" content="width=375"></head>' }]);
    expect(html.findings.map((f) => f.ruleId)).toEqual(['webview-viewport']);
    expect(audit([{ path: 'Web/index.html', content: '<meta name="viewport" content="width=device-width, initial-scale=1">' }]).findings).toEqual([]);
    expect(ids('web.loadHTMLString("<meta name=\\"viewport\\" content=\\"width=390\\">", baseURL: nil)')).toEqual(['webview-viewport']);
    expect(ids('// viewport width=390')).toEqual([]);
  });

  it('flags web views reloaded on every size change', () => {
    expect(ids('override func viewWillTransition(to size: CGSize, with c: UIViewControllerTransitionCoordinator) {\n  super.viewWillTransition(to: size, with: c)\n  web.reload()\n}')).toEqual(['webview-viewport']);
    expect(ids('.onChange(of: horizontalSizeClass) { _ in\n  web.reload()\n}')).toEqual(['webview-viewport']);
    expect(ids('func refresh() {\n  web.reload()\n}')).toEqual([]);
  });

  it('flags SpriteKit scenes that stretch or letterbox', () => {
    expect(ids('scene.scaleMode = .fill\nother.scaleMode = .aspectFit')).toEqual(['game-aspect', 'game-aspect']);
    expect(ids('scene.scaleMode = .resizeFill')).toEqual([]);
  });
});

describe('hinge and edges', () => {
  it('flags keyboard frame math unless the keyboard layout guide is used', () => {
    expect(ids('let f = note.userInfo?[UIResponder.keyboardFrameEndUserInfoKey] as? CGRect')).toEqual(['keyboard-frame']);
    expect(ids('let f = note.userInfo?[UIResponder.keyboardFrameEndUserInfoKey] as? CGRect\nfield.bottomAnchor.constraint(equalTo: view.keyboardLayoutGuide.topAnchor)')).toEqual([]);
  });

  it('flags full-screen video and camera previews that ignore the hinge', () => {
    expect(ids('let layer = AVPlayerLayer(player: p)')).toEqual(['hinge-media']);
    expect(ids('VideoPlayer(player: p)')).toEqual(['hinge-media']);
    expect(ids('VideoPlayer(player: p)\nGeometryReader { proxy in let r = proxy.reservedRegions(kind: .division) }')).toEqual([]);
  });

  it('flags screen-edge pans', () => {
    expect(ids('let pan = UIScreenEdgePanGestureRecognizer(target: self, action: #selector(back))')).toEqual(['edge-gesture']);
  });
});
