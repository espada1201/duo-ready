// Regressions found by independent review: fixes must never produce broken or reinterpreted Swift.
import { describe, expect, it } from 'vitest';
import { applyFixes, audit } from '../../src/core/audit';
import { maskSwift } from '../../src/core/swift';
import type { SourceFile } from '../../src/core/types';

const swift = (content: string): SourceFile[] => [{ path: 'A.swift', content }];
const fixes = (content: string) => audit(swift(content)).findings.filter((f) => f.fix);
const fixed = (content: string) => applyFixes(swift(content), audit(swift(content)).findings, 'all').files[0].content;

describe('UIScreen.main fixes only where traitCollection/view/bounds resolve', () => {
  it.each([
    ['stored property', 'class V: UIView { let s = UIScreen.main.scale }'],
    ['lazy closure', 'class V: UIView { lazy var s = { UIScreen.main.scale }() }'],
    ['static func', 'class V: UIView { static func f() -> CGFloat { UIScreen.main.scale } }'],
    ['class func', 'class V: UIView { class func f() -> CGFloat { UIScreen.main.scale } }'],
    ['nested type', 'class V: UIView { struct Helper { func f() -> CGFloat { UIScreen.main.scale } } }'],
    ['escaping closure', 'class C: UIViewController { func f() { load { [weak self] in let s = UIScreen.main.scale } } }'],
    ['init', 'class V: UIView { init() { let s = UIScreen.main.scale; super.init(frame: .zero) } }'],
    ['representable', 'struct R: UIViewRepresentable { func makeUIView(context: Context) -> UIView { let b = UIScreen.main.bounds; return UIView() } }'],
    ['flow layout', 'class L: UICollectionViewFlowLayout { override func prepare() { let w = UIScreen.main.bounds.width } }'],
  ])('%s: no fix', (_, code) => {
    expect(fixes(code)).toEqual([]);
  });

  it('fixes inside instance methods, including through if/for blocks, as review-level', () => {
    const code = 'class C: UIViewController {\n  func f() {\n    if ok { for x in y { let s = UIScreen.main.scale } }\n  }\n}';
    const [f] = fixes(code);
    expect(f.fix!.confidence).toBe('review');
    expect(fixed(code)).toContain('let s = self.traitCollection.displayScale');
  });

  it('uses the innermost UIKit type', () => {
    const code = 'class C: UIViewController {\n  final class Cell: UITableViewCell {\n    func f() { let b = UIScreen.main.bounds }\n  }\n}';
    expect(fixed(code)).toContain('let b = self.bounds');
  });

  it('binds to self, not to a parameter named view', () => {
    expect(fixed('class C: UIViewController {\n  func layout(view: UIView) { view.frame.size.width = UIScreen.main.bounds.width - 32 }\n}')).toContain('= self.view.bounds.width - 32');
  });

  it('offers no bounds fix in comparisons or mid-transition, and points to the size parameter', () => {
    expect(fixes('class C: UIViewController {\n  func f() { if UIScreen.main.bounds.width == view.frame.size.width { } }\n}')).toEqual([]);
    const transition = audit(swift('class C: UIViewController {\n  override func viewWillTransition(to size: CGSize, with c: UIViewControllerTransitionCoordinator) { let w = UIScreen.main.bounds.width }\n}')).findings;
    expect(transition.map((f) => [f.ruleId, !!f.fix])).toEqual([['uiscreen-main', false]]);
    expect(transition[0].message).toContain('size parameter');
  });

  it('fills, not fits, a full-bleed background', () => {
    expect(fixed('Image("bg")\n  .resizable()\n  .edgesIgnoringSafeArea(.all)')).toContain('.resizable()\n  .scaledToFill()');
  });

  it('does not rewrite nativeScale', () => {
    expect(fixes('class V: UIView { func f() { let s = UIScreen.main.nativeScale } }')).toEqual([]);
  });
});

describe('symmetric safe-area fix respects arithmetic', () => {
  it.each([
    ['decimal factor', 'let w = v.bounds.width - v.safeAreaInsets.left * 2.5'],
    ['division after', 'let w = v.bounds.width - v.safeAreaInsets.left * 2 / 3'],
    ['multiply before', 'let w = 3 * v.bounds.width - v.safeAreaInsets.left * 2'],
    ['subtraction before', 'let w = total - v.bounds.width - v.safeAreaInsets.left * 2'],
  ])('%s: no fix', (_, code) => {
    expect(fixes(code)).toEqual([]);
  });
});

describe('NavigationView fix', () => {
  it('leaves any multi-child NavigationView alone', () => {
    expect(fixes('NavigationView {\n  sidebar\n  DetailPlaceholder()\n}')).toEqual([]);
    expect(fixes('NavigationView { Sidebar(); Detail() }')).toEqual([]);
  });

  it('still fixes a single child with modifiers spanning lines', () => {
    expect(fixed('NavigationView {\n  List(items) { Text($0) }\n    .navigationTitle("A")\n}')).toMatch(/^NavigationStack \{/);
  });
});

describe('rule accuracy', () => {
  it('finds portrait locks in every build configuration, including the _iPhone key', () => {
    const pbx = [
      'LastUpgradeCheck = 2710;',
      'INFOPLIST_KEY_UISupportedInterfaceOrientations_iPad = "UIInterfaceOrientationPortrait UIInterfaceOrientationLandscapeLeft";',
      'INFOPLIST_KEY_UISupportedInterfaceOrientations_iPhone = UIInterfaceOrientationPortrait;',
    ].join('\n');
    expect(audit([{ path: 'A.xcodeproj/project.pbxproj', content: pbx }]).findings.map((f) => [f.ruleId, f.line])).toEqual([['portrait-only', 3]]);
    const plist = '<plist><dict><key>UISupportedInterfaceOrientations~iphone</key><array><string>UIInterfaceOrientationPortrait</string></array></dict></plist>';
    expect(audit([{ path: 'Info.plist', content: plist }]).findings.map((f) => f.ruleId)).toEqual(['portrait-only']);
  });

  it('flags only NavigationSplitView inside an ArrangementView', () => {
    const ok = 'ArrangementView {\n  A()\n} secondary: {\n  NavigationStack { B() }\n}';
    expect(audit(swift(ok)).findings).toEqual([]);
  });

  it('does not treat navigation destinations and sheets as scroll content', () => {
    const code = 'List {\n  NavigationLink {\n    ArrangementView { A() } secondary: { B() }\n  } label: { Text("x") }\n}\n.sheet(isPresented: $p) {\n  ArrangementView { A() } secondary: { B() }\n}';
    expect(audit(swift(code)).findings).toEqual([]);
  });

  it('respects .sidebarAdaptable and keeps CRLF line endings when adding the sidebar', () => {
    expect(audit(swift('TabView {\n  A()\n}\n.tabViewStyle(.sidebarAdaptable)')).findings).toEqual([]);
    expect(fixed('TabView {\r\n  A()\r\n}\r\n')).toBe('TabView {\r\n  A()\r\n}\r\n.defaultTabBarPlacement(.sidebar)\r\n');
  });

  it('only counts a real scene manifest key', () => {
    const files = [
      { path: 'App.swift', content: 'class AppDelegate: UIResponder, UIApplicationDelegate {}\nclass S: UIResponder, UIWindowSceneDelegate {}' },
      { path: 'Info.plist', content: '<plist><dict><!-- UIApplicationSceneManifest --><key>A</key><true/></dict></plist>' },
    ];
    expect(audit(files).findings.map((f) => f.ruleId)).toEqual(['no-scene-lifecycle']);
  });

  it('recognises size-class variables with other names', () => {
    expect(audit(swift('if hSizeClass == .regular {\n  HStack { A(); B() }\n}')).findings.map((f) => f.ruleId)).toEqual(['manual-two-pane']);
  });
});

describe('scanner', () => {
  it('masks regex literals so quotes and braces inside them are ignored', () => {
    const masked = maskSwift('let r = /"[{]/\nlet s = UIScreen.main.scale');
    expect(masked).toContain('UIScreen.main.scale');
    expect(masked).not.toContain('{');
    expect(maskSwift('let r = /[{]/')).not.toContain('{');
    expect(maskSwift('let half = a / 2 / b')).toBe('let half = a / 2 / b');
  });

  it('survives very deep nesting', () => {
    expect(() => audit(swift(`${'{'.repeat(20000)}let s = UIScreen.main.scale${'}'.repeat(20000)}`))).not.toThrow();
  });

  it('scans large files quickly', () => {
    const body = Array.from({ length: 3000 }, (_, i) => `  func f${i}() { let s = UIScreen.main.scale; run(x: { y }) }`).join('\n');
    const start = performance.now();
    const found = audit(swift(`class V: UIView {\n${body}\n}`)).findings;
    expect(found).toHaveLength(3000);
    expect(performance.now() - start).toBeLessThan(1500);
  });
});

describe('second review', () => {
  const ids = (files: SourceFile[]) => audit(files).findings.map((f) => f.ruleId);
  const pbx = (settings: string) => ({ path: 'A.xcodeproj/project.pbxproj', content: `buildSettings = {\n${settings}\n};` });

  it('recognises a SwiftUI App with attributes or access modifiers after @main', () => {
    const app = (head: string) => [{ path: 'App.swift', content: `${head} struct MyApp: App { var body: some Scene { WindowGroup {} } }\nclass D: UIResponder, UIApplicationDelegate {}` }];
    expect(ids(app('@main\n@MainActor'))).toEqual([]);
    expect(ids(app('@main public'))).toEqual([]);
  });

  it('leaves paged TabViews alone and reads modifiers past trailing closures', () => {
    expect(fixes('TabView {\n  A()\n}\n.tabViewStyle(.page)')).toEqual([]);
    expect(fixes('TabView(selection: $t) {\n  A()\n}\n.onChange(of: t) { _, n in log(n) }\n.tabViewStyle(.sidebarAdaptable)')).toEqual([]);
    expect(fixes('Image("a")\n  .resizable()\n  .overlay(alignment: .top) { Badge() }\n  .aspectRatio(1, contentMode: .fit)')).toEqual([]);
    expect(fixes('Image("a")\n  .resizable()\n  .frame(width: min(300, max(100, (200))))\n  .scaledToFill()')).toEqual([]);
    // An aspect modifier inside an overlay's closure doesn't cover the outer image.
    expect(ids(swift('Image("a")\n  .resizable()\n  .overlay { badge.resizable().scaledToFit() }'))).toEqual(['stretched-image']);
  });

  it('keeps an explicit column NavigationView and asks for review when other platforms build', () => {
    expect(fixes('NavigationView {\n  Sidebar()\n}\n.navigationViewStyle(.columns)')).toEqual([]);
    const shared = [pbx('IPHONEOS_DEPLOYMENT_TARGET = 17.0;\nWATCHOS_DEPLOYMENT_TARGET = 8.0;'), { path: 'V.swift', content: 'NavigationView {\n  List {}\n}' }];
    expect(audit(shared).findings.find((f) => f.ruleId === 'navigation-view')!.fix!.confidence).toBe('review');
  });

  it('a plist without app keys does not count as the app’s Info.plist', () => {
    const files = [{ path: 'GoogleService-Info.plist', content: '<plist><dict><key>API_KEY</key><string>x</string></dict></plist>' }, { path: 'A.swift', content: 'let a = 1' }];
    expect(audit(files).partial).toBe(true);
  });

  it('skips scaled fonts, keyboard toolbars and popover sizes, but not the real thing', () => {
    expect(ids(swift('func f() {\n  guard let f = UIFont(name: "Avenir", size: 17) else { return }\n  label.font = UIFontMetrics(forTextStyle: .body).scaledFont(for: f)\n}'))).toEqual([]);
    expect(ids(swift('let f = UIFont(name: "Avenir", size: 17)'))).toEqual(['fixed-font']);
    expect(ids(swift('let bar = UIToolbar()\nfield.inputAccessoryView = bar'))).toEqual([]);
    expect(ids(swift('let bar = UIToolbar()\nview.addSubview(bar)'))).toEqual(['hand-built-bar']);
    expect(ids(swift('preferredContentSize = CGSize(width: 320, height: 400)'))).toEqual([]);
    expect(ids(swift('view.frame = CGRect(x: 0, y: 0, width: 390, height: 10)'))).toEqual(['fixed-device-size']);
  });
});

describe('third review', () => {
  const ids = (files: SourceFile[]) => audit(files).findings.map((f) => f.ruleId);

  it('still flags photos and avatars in square frames; only symbols and assets are icons', () => {
    expect(ids(swift('Image(uiImage: photo)\n  .resizable()\n  .frame(width: 60, height: 60)'))).toEqual(['stretched-image']);
    expect(ids(swift('Image("logo")\n  .resizable()\n  .frame(width: 60, height: 60)'))).toEqual([]);
    expect(ids(swift('Image(systemName: "star")\n  .resizable()\n  .frame(width: 20, height: 20)'))).toEqual([]);
    expect(ids(swift('Image(iconName)\n  .resizable()\n  .frame(width: Size.icon, height: Size.icon)'))).toEqual([]);
  });

  it('only exempts a keyboard toolbar in the scope that assigns it', () => {
    const code = 'class C: UIViewController {\n  func a() { let toolbar = UIToolbar(); view.addSubview(toolbar) }\n  func b() { let toolbar = UIToolbar(); field.inputAccessoryView = toolbar }\n}';
    expect(ids(swift(code))).toEqual(['hand-built-bar']);
  });

  it('offers no bounds fix in loadView, where self.view would recurse', () => {
    const found = audit(swift('class C: UIViewController {\n  override func loadView() { view = UIView(frame: UIScreen.main.bounds) }\n}')).findings;
    expect(found.map((f) => [f.ruleId, !!f.fix])).toEqual([['uiscreen-main', false]]);
  });

  it('sees a passcode alternative past string interpolation', () => {
    expect(ids(swift('let t = "Unlock with Face ID \\(name) or use your passcode"'))).toEqual([]);
  });

  it('keeps an iPhone Info.plist that has WKAppBoundDomains', () => {
    const plist = '<plist><dict><key>WKAppBoundDomains</key><array/><key>UIRequiresFullScreen</key><true/></dict></plist>';
    expect(ids([{ path: 'Info.plist', content: plist }])).toEqual(['requires-full-screen']);
  });

  it('reads modifiers inside #if blocks in a chain', () => {
    expect(fixes('TabView {\n  A()\n}\n#if os(iOS)\n.tabViewStyle(.page)\n#endif')).toEqual([]);
    expect(ids(swift('Image("a")\n  .resizable()\n#if os(iOS)\nlet x = 1\n#endif'))).toEqual(['stretched-image']);
  });

  it('stays fast on unbalanced parentheses', () => {
    const start = performance.now();
    audit(swift(`TabView {}\n${'.a(('.repeat(40000)}`));
    expect(performance.now() - start).toBeLessThan(3000);
  });
});

describe('fourth review: apps the scanner had never seen', () => {
  const ids = (files: SourceFile[]) => audit(files).findings.map((f) => f.ruleId);
  const one = (content: string) => ids(swift(content));

  it.each([
    ['a Face ID preview title', '#Preview("Face ID Button") {\n  UnlockButton()\n}'],
    ['a static preview helper', 'struct V: View {\n  static func previewView() -> some View {\n    V().frame(width: 430, height: 330)\n  }\n}'],
    ['a frameForPreview helper', 'extension View {\n  func frameForPreview() -> some View {\n    frame(width: UIScreen.main.bounds.width)\n  }\n}'],
    ['a *_Previews type', 'struct Card_Previews {\n  static var v: some View { Text("a").frame(width: 390) }\n}'],
    ['TrueDepth as one lens among several', 'let s = AVCaptureDevice.DiscoverySession(deviceTypes: [.builtInWideAngleCamera, .builtInTrueDepthCamera], mediaType: .video, position: .front)'],
    ['a UIToolbar factory', 'extension UIToolbar {\n  static func make() -> UIToolbar {\n    let toolbar = UIToolbar()\n    return toolbar\n  }\n}'],
    ['a capped image', 'struct V: View {\n  var body: some View {\n    Image("hero")\n      .resizable()\n      .aspectRatio(contentMode: .fit)\n      .frame(maxWidth: 400)\n  }\n}'],
    ['an SF Symbol sized in points', 'struct V: View {\n  var body: some View {\n    Image(systemName: "star").foregroundStyle(.yellow).font(.system(size: 22))\n  }\n}'],
    ['a font in draw(_:)', 'class V: UIView {\n  override func draw(_ rect: CGRect) {\n    let f = UIFont.systemFont(ofSize: 14)\n  }\n}'],
    ['a keyboard type picked by idiom', 'field.keyboardType = UIDevice.current.userInterfaceIdiom == .pad ? .default : .numberPad'],
    ['a SwiftGen asset icon', 'struct V: View {\n  var body: some View {\n    Asset.Images.close.swiftUIImage.resizable().frame(width: 24, height: 24)\n  }\n}'],
  ])('ignores %s', (_, code) => {
    expect(one(code)).toEqual([]);
  });

  it('still flags TrueDepth when it is the only lens', () => {
    expect(one('let s = AVCaptureDevice.DiscoverySession(deviceTypes: [.builtInTrueDepthCamera], mediaType: .video, position: .front)')).toEqual(['camera-hardware']);
  });

  it('reports one hard-coded size once per line', () => {
    expect(one('let r = CGRect(x: 0, y: 0, width: 320, height: 568)')).toEqual(['fixed-device-size']);
  });

  it('finds key-window lookups through connectedScenes, even split over lines', () => {
    expect(one('let w = UIApplication.shared.connectedScenes\n  .compactMap { $0 as? UIWindowScene }\n  .flatMap { $0.windows }\n  .first { $0.isKeyWindow }')).toEqual(['key-window']);
  });

  it('follows idiom checks wrapped in a property to their call sites', () => {
    const wrapper = { path: 'Ext/UIDevice.swift', content: 'extension UIDevice {\n  static var isPad: Bool {\n    UIDevice.current.userInterfaceIdiom == .pad\n  }\n  static var isTV: Bool {\n    current.userInterfaceIdiom == .tv\n  }\n}' };
    const use = { path: 'App/Grid.swift', content: 'let columns = UIDevice.isPad ? 4 : 2\nlet gap = UIDevice.isTV ? 30 : 15' };
    const found = audit([wrapper, use]).findings.filter((f) => f.path === 'App/Grid.swift');
    expect(found.map((f) => [f.ruleId, f.line, f.message])).toEqual([['idiom-layout', 1, 'isPad is a device idiom check under another name.']]);
  });

  it('points brightness at the window scene’s screen', () => {
    expect(audit(swift('UIScreen.main.brightness = 1')).findings[0].message).toContain('windowScene?.screen');
  });

  it('skips mocks, test helpers and watch apps', () => {
    const code = 'let r = CGRect(x: 0, y: 0, width: 320, height: 568)';
    expect(ids([{ path: 'App/Mocks/MockVC.swift', content: code }, { path: 'App/TestHelpers/Support/Base.swift', content: code }])).toEqual([]);
    expect(ids([{ path: 'BitwardenWatchApp/Main.swift', content: 'NavigationView { List {} }' }])).toEqual([]);
    expect(ids([{ path: 'Shared/Root.swift', content: 'import WatchKit\nNavigationView { List {} }' }])).toEqual([]);
    expect(ids([{ path: 'Sources/Watch/Bridge.swift', content: 'let h = UIHostingController(rootView: NavigationView { List {} })' }])).toEqual(['navigation-view']);
  });

  it('reads the deployment target and other platforms from XcodeGen and .xcconfig files', () => {
    const view = { path: 'App/Root.swift', content: 'struct R: View {\n  var body: some View {\n    NavigationView {\n      List {}\n    }\n  }\n}' };
    const yml = { path: 'project.yml', content: 'options:\n  deploymentTarget:\n    iOS: 15.0\n    watchOS: 8.0\n' };
    expect(audit([view, yml]).findings.find((f) => f.ruleId === 'navigation-view')!.message).toContain('deploys to iOS 15');
    const xcconfig = { path: 'Configs/Base.xcconfig', content: 'IPHONEOS_DEPLOYMENT_TARGET = 17.0\n' };
    expect(audit([view, xcconfig]).findings.find((f) => f.ruleId === 'navigation-view')!.fix!.confidence).toBe('safe');
  });

  it('keeps the tab sidebar to iOS when the project builds for other platforms too', () => {
    const view = { path: 'App/Main.swift', content: 'struct M: View {\n  var body: some View {\n    TabView {\n      A()\n    }\n  }\n}' };
    const yml = { path: 'project.yml', content: 'targets:\n  TV:\n    platform: tvOS\n' };
    const files = [view, yml];
    const out = applyFixes(files, audit(files).findings, 'all').files[0].content;
    expect(out).toContain('    }\n    #if os(iOS)\n    .defaultTabBarPlacement(.sidebar)\n    #endif\n');
    expect(audit([{ path: 'App/Main.swift', content: out }, yml]).findings.map((f) => f.ruleId)).not.toContain('tab-sidebar');
  });
});
