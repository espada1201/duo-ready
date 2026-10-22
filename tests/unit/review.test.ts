// Regressions found by independent review: fixes must never produce broken or reinterpreted Swift.
import { describe, expect, it } from 'vitest';
import { applyFixes, audit } from '../../src/core/audit';
import { parseObjC } from '../../src/core/objc';
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
    expect(ids(swift('label.font = UIFont.systemFont(ofSize: UIFont.preferredFont(forTextStyle: .body).pointSize, weight: .bold)'))).toEqual([]);
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

  it('flags a photo the window can stretch, not one in a fixed frame', () => {
    expect(ids(swift('Image(uiImage: photo)\n  .resizable()\n  .frame(width: 60, height: 60)'))).toEqual([]);
    expect(ids(swift('Image(uiImage: photo)\n  .resizable()\n  .frame(maxWidth: .infinity)'))).toEqual(['stretched-image']);
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

describe('fifth review: skips must not hide real screens', () => {
  const ids = (files: SourceFile[]) => audit(files).findings.map((f) => f.ruleId);
  const one = (content: string) => ids(swift(content));

  it('audits a real screen named like a preview', () => {
    expect(one('struct LinkPreview: View {\n  var body: some View {\n    Text("a").font(.system(size: 17))\n  }\n}')).toEqual(['fixed-font']);
  });

  it('skips sample data a file keeps for its #Preview', () => {
    expect(one('#Preview { ListPickerPreview.standard }\nenum ListPickerPreview {\n  static var standard: some View {\n    NavigationView {\n      Text("a")\n    }\n  }\n}')).toEqual([]);
  });

  it('audits a shared file that imports WatchKit only for watchOS', () => {
    expect(one('#if os(iOS)\nimport UIKit\n#elseif os(watchOS)\nimport WatchKit\n#endif\nlet s = UIScreen.main.scale')).toEqual(['uiscreen-main']);
    expect(ids([{ path: 'App/WatchAppSettings/Screen.swift', content: 'let s = UIScreen.main.scale' }])).toEqual(['uiscreen-main']);
    expect(ids([{ path: 'App/MyApp WatchKit Extension/Root.swift', content: 'let s = UIScreen.main.scale' }])).toEqual([]);
  });

  it('keeps fixed fonts flagged outside the PDF code in the same file', () => {
    const code = 'class InvoiceVC: UIViewController {\n  override func viewDidLoad() {\n    title2.font = UIFont.systemFont(ofSize: 22)\n  }\n  func export() -> Data {\n    let r = UIGraphicsPDFRenderer(bounds: .zero)\n    return r.pdfData { _ in\n      let f = UIFont.systemFont(ofSize: 12)\n    }\n  }\n}';
    expect(audit(swift(code)).findings.map((f) => [f.ruleId, f.line])).toEqual([['fixed-font', 3]]);
  });

  it('only treats TrueDepth as listed when it sits in the same brackets as another lens', () => {
    expect(one('let s = DiscoverySession(deviceTypes: [.builtInWideAngleCamera], mediaType: .video, position: .front)\nlet d = AVCaptureDevice.default(.builtInTrueDepthCamera, for: .video, position: .front)\nlet o: [String: Any] = [:]')).toEqual(['camera-hardware']);
  });

  it('keeps a centered column flagged next to an unrelated resizable image', () => {
    expect(one('struct V: View {\n  var body: some View {\n    VStack {\n      Image("a").resizable().scaledToFit()\n      Text("Welcome")\n    }\n    .frame(maxWidth: 600)\n  }\n}')).toEqual(['centered-column']);
  });

  it('puts #endif on its own line when a modifier followed the TabView', () => {
    const files = [
      { path: 'App/Main.swift', content: 'struct M: View {\n  var body: some View {\n    TabView {\n      A()\n    }.tint(.red)\n  }\n}' },
      { path: 'project.yml', content: 'targets:\n  App:\n    supportedDestinations: [iOS, visionOS]\n' },
    ];
    const out = applyFixes(files, audit(files).findings, 'all').files[0].content;
    expect(out).toContain('    }\n    #if os(iOS)\n    .defaultTabBarPlacement(.sidebar)\n    #endif\n    .tint(.red)');
  });

  it.each([
    ['inline mapping', 'options:\n  deploymentTarget: { iOS: 15.0, watchOS: 8.0 }\n', 15],
    ['per-SDK setting', 'IPHONEOS_DEPLOYMENT_TARGET[sdk=iphoneos*] = 14.0\n', 14],
    ['commented-out setting', '// IPHONEOS_DEPLOYMENT_TARGET = 12.0\nIPHONEOS_DEPLOYMENT_TARGET = 15.0\n', 15],
  ])('reads the deployment target from a %s', (_, config, target) => {
    const view = { path: 'App/Root.swift', content: 'struct R: View {\n  var body: some View {\n    NavigationView {\n      List {}\n    }\n  }\n}' };
    const path = config.startsWith('options') ? 'project.yml' : 'Base.xcconfig';
    expect(audit([view, { path, content: config }]).findings.find((f) => f.ruleId === 'navigation-view')!.message).toContain(`deploys to iOS ${target}`);
  });

  it('ignores a platform named only in a YAML comment', () => {
    const files = [
      { path: 'App/Main.swift', content: 'struct M: View {\n  var body: some View {\n    TabView {\n      A()\n    }\n  }\n}' },
      { path: 'project.yml', content: 'targets:\n  App:\n    platform: iOS # macOS later\n' },
    ];
    expect(applyFixes(files, audit(files).findings, 'all').files[0].content).not.toContain('#if os(iOS)');
  });
});

describe('scale', () => {
  it('stays linear with thousands of findings in one file', () => {
    const content = 'Image("a")\n.resizable()\n'.repeat(20000);
    const start = performance.now();
    expect(audit(swift(content)).findings).toHaveLength(20000);
    expect(performance.now() - start).toBeLessThan(3000);
  });
});

describe('sixth review: games, web views, media and cross-platform apps', () => {
  const ids = (files: SourceFile[]) => audit(files).findings.map((f) => f.ruleId);
  const one = (content: string) => ids(swift(content));

  it.each([
    ['a protocol requirement named like a resize callback', 'protocol P {\n  func traitCollectionDidChange()\n}\nclass H {\n  func refresh() { web.reload() }\n}'],
    ['a resizable image handed to a closure', 'struct V: View {\n  var body: some View {\n    content(Image(uiImage: ui).resizable())\n  }\n}'],
    ['a blur-hash placeholder', 'struct V: View {\n  var body: some View {\n    Image(blurHash: hash, size: .init(width: 8, height: 8))?.resizable()\n  }\n}'],
    ['an AdMob banner size', 'let banner = GADBannerView(adSize: GADAdSizeFromCGSize(CGSize(width: 320, height: 50)))'],
    ['Face ID in a translator note', 'let t = NSLocalizedString("unlock", value: "Unlock", comment: "Shown on the Face ID prompt")'],
    ['a tvOS idiom check', 'let gap = UIDevice.current.userInterfaceIdiom == .tv ? 30 : 15'],
  ])('ignores %s', (_, code) => {
    expect(one(code)).toEqual([]);
  });

  it('reports an idiom wrapper where it is used, not where it is defined', () => {
    const files = [
      { path: 'Ext.swift', content: 'extension UIDevice {\n  static var isPad: Bool {\n    current.userInterfaceIdiom == .pad\n  }\n}' },
      { path: 'Grid.swift', content: 'let columns = UIDevice.isPad ? 4 : 2' },
    ];
    expect(audit(files).findings.map((f) => f.path)).toEqual(['Grid.swift']);
  });

  it('only counts VideoPlayer as AVKit’s when the app has no type of that name', () => {
    const mine = { path: 'Player/VideoPlayer.swift', content: 'struct VideoPlayer: View {\n  var body: some View { Color.black }\n}' };
    expect(ids([mine, { path: 'Route.swift', content: 'let v = VideoPlayer()' }])).toEqual([]);
    expect(ids([mine, { path: 'Clip.swift', content: 'import AVKit\nlet v = VideoPlayer(player: p)' }])).toEqual(['hinge-media']);
    expect(one('let v = VideoPlayer(player: p)')).toEqual(['hinge-media']);
  });

  it('reads SKSceneScaleMode spelled out', () => {
    expect(one('scene.scaleMode = SKSceneScaleMode.aspectFit')).toEqual(['game-aspect']);
  });

  it('follows a size class bound to another name', () => {
    expect(one('struct V: View {\n  @Environment(\\.horizontalSizeClass) var hs\n  var body: some View {\n    if hs != .compact {\n      HStack { A(); B() }\n    }\n  }\n}')).toEqual(['manual-two-pane']);
  });

  it('flags portrait locks set in code', () => {
    expect(one('class C: UIViewController {\n  override var supportedInterfaceOrientations: UIInterfaceOrientationMask { .portrait }\n}')).toEqual(['portrait-only']);
    expect(one('class A: UIResponder, UIApplicationDelegate {\n  func application(_ app: UIApplication, supportedInterfaceOrientationsFor window: UIWindow?) -> UIInterfaceOrientationMask {\n    return .portrait\n  }\n}')).toContain('portrait-only');
  });

  it('checks Objective-C too, and ignores Mac-only Xcode projects and Flutter plugins', () => {
    const r = audit([
      { path: 'App/A.swift', content: 'let a = 1' },
      { path: 'App/Legacy.m', content: '[UIScreen mainScreen];' },
      { path: 'macos/Runner.xcodeproj/project.pbxproj', content: 'LastUpgradeCheck = 0600;\nSDKROOT = macosx;' },
      { path: 'plugins/pay/pubspec.yaml', content: 'name: pay\nflutter:\n  plugin:\n    platforms: {}\n' },
    ]);
    expect(r.objcFiles).toBe(1);
    expect(r.swiftFiles).toBe(1);
    expect(r.findings.map((f) => [f.ruleId, f.path])).toEqual([['uiscreen-main', 'App/Legacy.m']]);
  });

  it.each([
    ['[UIScreen mainScreen] bounds', 'CGRect r = [[UIScreen mainScreen] bounds];', 'uiscreen-main'],
    ['an idiom macro', 'if (UI_USER_INTERFACE_IDIOM() == UIUserInterfaceIdiomPad) { cols = 4; }', 'idiom-layout'],
    ['a fixed font', 'label.font = [UIFont systemFontOfSize:17];', 'fixed-font'],
    ['keyboard frame math', 'CGRect k = [info[UIKeyboardFrameEndUserInfoKey] CGRectValue];', 'keyboard-frame'],
    ['the key window', 'UIWindow *w = [UIApplication sharedApplication].keyWindow;', 'key-window'],
    ['status bar orientation', 'if (UIInterfaceOrientationIsLandscape([UIApplication sharedApplication].statusBarOrientation)) {}', 'orientation-layout'],
    ['a portrait lock', '- (UIInterfaceOrientationMask)supportedInterfaceOrientations {\n    return UIInterfaceOrientationMaskPortrait;\n}', 'portrait-only'],
    ['a hand-built toolbar', 'UIToolbar *bar = [[UIToolbar alloc] initWithFrame:CGRectZero];', 'hand-built-bar'],
    ['an edge pan', 'id g = [[UIScreenEdgePanGestureRecognizer alloc] initWithTarget:self action:@selector(back:)];', 'edge-gesture'],
    ['an iPhone-sized frame', 'self.view.frame = CGRectMake(0, 0, 375, 667);', 'fixed-device-size'],
    ['TrueDepth alone', 'AVCaptureDevice *d = [AVCaptureDevice defaultDeviceWithDeviceType:AVCaptureDeviceTypeBuiltInTrueDepthCamera mediaType:AVMediaTypeVideo position:AVCaptureDevicePositionFront];', 'camera-hardware'],
    ['Face ID copy', 'label.text = @"Unlock with Face ID";', 'biometry-faceid'],
  ])('finds %s in Objective-C', (_, code, rule) => {
    expect(ids([{ path: 'Legacy.m', content: code }])).toContain(rule);
  });

  it.each([
    ['a tvOS idiom check', 'if (UI_USER_INTERFACE_IDIOM() == UIUserInterfaceIdiomTV) {}'],
    ['scaled fonts', 'label.font = [[UIFontMetrics defaultMetrics] scaledFontForFont:[UIFont systemFontOfSize:17]];'],
    ['a size read from a text style', 'f.font = [UIFont systemFontOfSize:[Style fontSizeForTextStyle:UIFontTextStyleTitle1]\n    weight:UIFontWeightBold];'],
    ['TrueDepth among lenses', 'NSArray *t = @[AVCaptureDeviceTypeBuiltInWideAngleCamera, AVCaptureDeviceTypeBuiltInTrueDepthCamera];'],
    ['code in comments', '// [UIScreen mainScreen]\n/* UIKeyboardFrameEndUserInfoKey */'],
  ])('ignores %s in Objective-C', (_, code) => {
    expect(ids([{ path: 'Legacy.m', content: code }])).toEqual([]);
  });
});

const ids = (files: SourceFile[]) => audit(files).findings.map((f) => f.ruleId);

describe('seventh review: Objective-C', () => {
  const objc = (content: string, path = 'App/Legacy.m') => ids([{ path, content }]);

  it.each([
    ['a selector named like a font call', 'SEL s = @selector(systemFontOfSize:weight:);'],
    ['a layer type check', 'if ([layer isKindOfClass:[AVPlayerLayer class]]) {}'],
    ['a Mac idiom check', 'if ([UIDevice currentDevice].userInterfaceIdiom == UIUserInterfaceIdiomMac) {}'],
    ['a keyboard type by idiom', 'field.keyboardType = UI_USER_INTERFACE_IDIOM() == UIUserInterfaceIdiomPad ? UIKeyboardTypeDefault : UIKeyboardTypeNumberPad;'],
    ['two empty strings joined', 'NSString *s = @"" "";'],
    ['a quote character', "unichar q = '\"';"],
    ['C++ raw strings', 'auto s = R"(\nAvoid [UIScreen mainScreen]\n)";'],
    ['code under #if 0', '#if 0\nCGRect r = [UIScreen mainScreen].bounds;\n#endif'],
  ])('ignores %s', (_, code) => {
    expect(objc(code, 'App/Legacy.mm')).toEqual([]);
  });

  it.each([
    ['code after two empty strings', 'NSString *s = @"" "";\nCGRect r = [UIScreen mainScreen].bounds;', 'uiscreen-main'],
    ['code after a quote character', "unichar q = '\"'; CGRect r = [UIScreen mainScreen].bounds;", 'uiscreen-main'],
    ['the #else of #if 0', '#if 0\nint a;\n#else\nCGRect r = [UIScreen mainScreen].bounds;\n#endif', 'uiscreen-main'],
    ['an iPad check next to a Mac check', 'BOOL big = idiom == UIUserInterfaceIdiomMac || [UIDevice currentDevice].userInterfaceIdiom == UIUserInterfaceIdiomPad;', 'idiom-layout'],
    ['a nested font name', 'l.font = [UIFont fontWithName:[self fontName] size:12];', 'fixed-font'],
    ['a size on the next line', 'l.font = [UIFont fontWithName:@"Avenir"\n                      size:12];', 'fixed-font'],
    ['the delegate window', 'UIWindow *w = [UIApplication sharedApplication].delegate.window;', 'key-window'],
    ['the delegate window as messages', 'UIWindow *w = [[[UIApplication sharedApplication] delegate] window];', 'key-window'],
    ['interfaceOrientation', 'if (UIInterfaceOrientationIsLandscape(self.interfaceOrientation)) {}', 'orientation-layout'],
    ['a bar made with new', 'UITabBar *bar = [UITabBar new];', 'hand-built-bar'],
    ['an iPhone width with a bar height', 'v.frame = CGRectMake(0, 0, 375, 44);', 'fixed-device-size'],
    ['a float suffix', 'v.frame = CGRectMake(0, 0, 320.f, 568.f);', 'fixed-device-size'],
    ['a parenthesised portrait lock', '- (UIInterfaceOrientationMask)supportedInterfaceOrientations {\n  return (UIInterfaceOrientationMaskPortrait);\n}', 'portrait-only'],
    ['a video view', '+ (Class)layerClass {\n  return [AVPlayerLayer class];\n}', 'hinge-media'],
    ['a macro in a header', '#define SCREEN_W [UIScreen mainScreen].bounds.size.width', 'uiscreen-main'],
  ])('finds %s', (_, code, rule) => {
    expect(objc(code, /define/.test(code) ? 'App/Constants.h' : 'App/Legacy.m')).toContain(rule);
  });

  it('reads the app and scene delegates from Objective-C', () => {
    const plist = { path: 'App/Info.plist', content: '<plist><dict><key>UIApplicationSceneManifest</key><dict/></dict></plist>' };
    const swiftApp = { path: 'App/AppDelegate.swift', content: 'class AppDelegate: UIResponder, UIApplicationDelegate {}' };
    expect(ids([swiftApp, plist, { path: 'App/SceneDelegate.m', content: '@interface SceneDelegate : UIResponder <UIWindowSceneDelegate>\n@end' }])).not.toContain('no-scene-lifecycle');
    expect(ids([{ path: 'App/AppDelegate.h', content: '@interface AppDelegate : UIResponder <UIApplicationDelegate>\n@end' }])).toContain('no-scene-lifecycle');
  });

  it('skips vendored "Third Party" folders and Objective-C tests', () => {
    expect(objc('CGRect r = [UIScreen mainScreen].bounds;', 'App/Third Party Code/NYT/View.m')).toEqual([]);
    expect(objc('CGRect r = [UIScreen mainScreen].bounds;', 'App/LegacyTests.m')).toEqual([]);
  });

  it('stays fast on odd input', () => {
    const started = performance.now();
    objc('[UIFont systemFontOfSize:12] '.repeat(20_000));
    objc('- supportedInterfaceOrientationsForWindow:'.repeat(20_000));
    objc(`x = @"${'Face ID '.repeat(50_000)}"; ${'[UIScreen mainScreen] '.repeat(20_000)}`);
    expect(performance.now() - started).toBeLessThan(3000);
  });
});

it('sees a fixed font beside a text-style font in Swift', () => {
  expect(ids([{ path: 'A.swift', content: 'label.font = c ? UIFont.preferredFont(forTextStyle: .body) : UIFont.systemFont(ofSize: 14)' }])).toContain('fixed-font');
  expect(ids([{ path: 'A.swift', content: 'label.font = UIFont.systemFont(ofSize: UIFontDescriptor.preferredFontDescriptor(withTextStyle: .body).pointSize)' }])).toEqual([]);
});


it('treats a project modifier that frames a square as a square frame', () => {
  const square = { path: 'UI/View+Square.swift', content: 'extension View {\n  public func square(size: CGFloat, alignment: Alignment = .center) -> some View {\n    frame(width: size, height: size, alignment: alignment)\n  }\n}' };
  const icon = { path: 'UI/Row.swift', content: 'struct Row: View {\n  var body: some View {\n    Image(DS.Icon.star)\n      .resizable()\n      .square(size: 20)\n  }\n}' };
  expect(ids([square, icon])).not.toContain('stretched-image');
  expect(ids([icon])).toContain('stretched-image');
});

it('reports a rule once per line, and skips lowercase test folders', () => {
  const line = 'let wide = (UIDevice.current.userInterfaceIdiom == .pad && x) || (UIDevice.current.userInterfaceIdiom == .phone && y)';
  expect(ids([{ path: 'A.swift', content: line }]).filter((r) => r === 'idiom-layout')).toHaveLength(1);
  expect(ids([{ path: 'app/focus-ios-tests/XCUITest/Base.swift', content: line }])).toEqual([]);
  expect(ids([{ path: 'app/tests/Base.swift', content: line }])).toEqual([]);
});

describe('eighth review: offsets and C++ literals', () => {
  it.each([
    ['a prefixed raw string', 'const char *t = uR"(\n[UIFont systemFontOfSize:12];)";\nx = 1;', []],
    ['a digit separator', 'if (n > 1\'000) { [UIFont systemFontOfSize:12]; }', ['fixed-font']],
    ['a wide character literal', "wchar_t c = L'['; [UIFont systemFontOfSize:12];", ['fixed-font']],
    ['a CRLF line continuation', 'NSString *s = @"a\\\r\nb"; [UIFont systemFontOfSize:12];', ['fixed-font']],
  ])('reads %s in Objective-C++', (_, content, expected) => {
    expect(ids([{ path: 'A.mm', content }])).toEqual(expected);
  });

  it('keeps offsets right after a byte-order mark', () => {
    const content = '﻿struct A: View {\n  var body: some View { Image("logo").resizable() }\n}';
    const fixed = applyFixes([{ path: 'A.swift', content }], audit([{ path: 'A.swift', content }]).findings, 'all').files[0].content;
    expect(fixed).toContain('.resizable().scaledToFit()');
  });

  it('keeps same-line findings that say different things', () => {
    const r = audit([{ path: 'A.m', content: 'UIToolbar *a = [UIToolbar new]; UITabBar *b = [UITabBar new];' }]);
    expect(r.findings.filter((f) => f.ruleId === 'hand-built-bar')).toHaveLength(2);
  });
});

it('keeps every offset and line break when masking odd Objective-C', () => {
  const pieces = ['"', "'", '@"', 'R"(', ')"', '/*', '*/', '//', '\\', '\n', '\r\n', '#if 0\n', '#endif\n', '{', '}', '﻿', "1'0", 'u8R"x('];
  let seed = 7;
  const pick = () => pieces[(seed = (seed * 1103515245 + 12345) & 0x7fffffff) % pieces.length];
  for (let k = 0; k < 300; k++) {
    const text = Array.from({ length: 12 }, () => pick() + 'a ').join('');
    const { masked } = parseObjC(text);
    expect(masked.length).toBe(text.length);
    expect([...masked].filter((c) => c === '\n').length).toBe([...text].filter((c) => c === '\n').length);
  }
});

describe('precision review', () => {
  const swiftIds = (content: string) => ids([{ path: 'A.swift', content }]);
  it.each([
    ['a capped button', 'Button {\n  go()\n} label: {\n  Text("Go")\n}\n.buttonStyle(.borderedProminent)\n.frame(maxWidth: 360)'],
    ['a capped progress bar', 'Capsule()\n  .foregroundStyle(.blue)\n  .frame(maxWidth: 400)'],
    ['a size breakpoint', 'if view.frame.width <= 320 { compact() }'],
    ['an icon with a template rendering mode', 'Image(Icons.cloud)\n  .renderingMode(.template)\n  .resizable()\n  .frame(width: size, height: size)'],
    ['Face ID copy beside its Touch ID twin', 'let a = "Use Face ID to unlock"\nlet b = "Use Touch ID to unlock"'],
    ['a Face ID check with a Touch ID branch', 'let d = ctx.biometryType == .faceID ? .faceIdDescription : .touchIdDescription'],
  ])('ignores %s', (_, code) => {
    expect(swiftIds(code)).toEqual([]);
  });

  it('still flags a capped content column', () => {
    expect(swiftIds('VStack {\n  content\n}\n.frame(maxWidth: 500)')).toEqual(['centered-column']);
  });
});

it('skips rows of equal cards and library demo apps', () => {
  const row = 'if horizontalSizeClass == .regular {\n  HStack {\n    ForEach(items) { Card(item: $0) }\n  }\n}';
  expect(ids([{ path: 'A.swift', content: row }])).not.toContain('manual-two-pane');
  expect(ids([{ path: 'Lib/Example/App.swift', content: 'let s = UIScreen.main.bounds' }])).toEqual([]);
  expect(ids([{ path: 'Demo/App.swift', content: 'let s = UIScreen.main.bounds' }])).toEqual([]);
});

it('treats content passed into a size-class swap as stateful', () => {
  const swap = (a: string, b: string) => ids([{ path: 'A.swift', content: `if verticalSizeClass == .regular {\n  ${a}\n} else {\n  ${b}\n}` }]);
  expect(swap('VStack(spacing: 24, content: content)', 'HStack(spacing: 24, content: content)')).toContain('state-reset');
  expect(swap('VStack { imageContent() }', 'HStack { imageContent() }')).toContain('state-reset');
  expect(swap('VStack { Image("a"); Text(title) }', 'HStack { Image("a"); Text(title) }')).not.toContain('state-reset');
});

describe('code that never ships to Duo', () => {
  const swiftIds = (content: string) => ids([{ path: 'A.swift', content }]);
  it.each([
    ['an old-iOS fallback', 'if #available(iOS 16, *) {\n  ok()\n} else {\n  let s = UIScreen.main.bounds\n}'],
    ['an #unavailable branch', 'if #unavailable(iOS 17) {\n  let s = UIScreen.main.bounds\n}'],
    ['a guard #available else', 'func f() {\n  guard #available(iOS 16, *) else {\n    let s = UIScreen.main.bounds\n    return\n  }\n}'],
    ['debug-only code', '#if DEBUG\nlet s = UIScreen.main.bounds\n#endif'],
  ])('skips %s', (_, code) => {
    expect(swiftIds(code)).toEqual([]);
  });

  it.each([
    ['the #available branch itself', 'if #available(iOS 16, *) {\n  let s = UIScreen.main.bounds\n}'],
    ['an else after a compound condition', 'if #available(iOS 16, *), ready {\n  ok()\n} else {\n  let s = UIScreen.main.bounds\n}'],
    ['a fallback for a newer iOS', 'if #available(iOS 28, *) {\n  ok()\n} else {\n  let s = UIScreen.main.bounds\n}'],
    ['the release side of #if DEBUG', '#if DEBUG\nlet a = 1\n#else\nlet s = UIScreen.main.bounds\n#endif'],
  ])('keeps %s', (_, code) => {
    expect(swiftIds(code)).toContain('uiscreen-main');
  });
});

describe('second precision review', () => {
  const swiftIds = (content: string, path = 'A.swift') => ids([{ path, content }]);
  it.each([
    ['a spinner given a fresh identity', 'ProgressView()\n  .progressViewStyle(.circular)\n  .id(UUID())'],
    ['an estimated cell size', 'layout.estimatedItemSize = CGSize(width: 375, height: 80)'],
    ['a standard ad banner', 'banner.frame = CGRect(x: 0, y: 0, width: 320, height: 50)'],
    ['a view rendered to an image', 'let image = view.renderAsImage(size: CGSize(width: 375, height: 666))'],
  ])('ignores %s', (_, code) => {
    expect(swiftIds(code)).toEqual([]);
  });
  it('skips test spies and testing modules', () => {
    expect(swiftIds('let s = UIScreen.main.bounds', 'Inbox/LAContextSpy.swift')).toEqual([]);
    expect(swiftIds('let s = UIScreen.main.bounds', 'InboxTesting/Helpers.swift')).toEqual([]);
  });
});

it('skips a TabView whose sidebar placement is set where its property is used', () => {
  const code = 'struct App: View {\n  var body: some View {\n    tabs.defaultTabBarPlacement(.sidebar)\n  }\n  var tabs: some View {\n    TabView {\n      Text("a")\n    }\n  }\n}';
  expect(ids([{ path: 'A.swift', content: code }])).not.toContain('tab-sidebar');
  expect(ids([{ path: 'A.swift', content: code.replace('.defaultTabBarPlacement(.sidebar)', '') }])).toContain('tab-sidebar');
});

it('skips a capped bar a few points tall', () => {
  expect(ids([{ path: 'A.swift', content: 'ZStack {\n  track\n}\n.frame(maxWidth: 360)\n.frame(height: 4)' }])).toEqual([]);
});

describe('third precision review', () => {
  const swiftIds = (content: string, path = 'A.swift') => ids([{ path, content }]);
  it.each([
    ['.id(UUID()) on a row of a spinner past #if lines', 'HStack {\n  ProgressView()\n  Spacer()\n}\n#if !os(visionOS)\n.listRowBackground(Color.clear)\n#endif\n.id(UUID())'],
    ['an icon picked by a ternary in a square frame', 'struct S: View {\n  var body: some View {\n    Image(open ? Icons.up : Icons.down)\n      .resizable()\n      .frame(width: 16, height: 16)\n  }\n}'],
    ['a placeholder handed to a sized avatar', 'AvatarView(url: url, diameter: 72, placeholderImage: Image("gravatar").resizable())'],
    ['a context-menu preview width', 'Text(log)\n  .contextMenu {\n    Button("Copy") {}\n  } preview: {\n    Text(log)\n      .frame(width: 320)\n  }'],
    ['a popover width', 'VStack { Text("a") }\n  .frame(idealWidth: 280, maxWidth: 320)\n  .presentationCompactAdaptation(.popover)'],
    ['an action sheet style picked by idiom', 'let style: UIAlertController.Style = UIDevice.current.userInterfaceIdiom == .pad ? .alert : .actionSheet; let a = UIAlertController(title: nil, message: nil, preferredStyle: style)'],
    ['a scene delegate lookup', 'let d = UIApplication.shared.connectedScenes.first?.delegate as? SceneDelegate'],
    ['a QR scanner viewfinder', 'let layer = AVCaptureVideoPreviewLayer(session: s)\noutput.metadataObjectTypes = [.qr]'],
  ])('ignores %s', (_, code) => {
    expect(swiftIds(code)).toEqual([]);
  });
  it('skips files that import a test framework, wherever they are', () => {
    expect(swiftIds('import XCTest\nlet size = CGSize(width: 375, height: 667)', 'App/SortViewTest.swift')).toEqual([]);
    expect(swiftIds('let s = UIScreen.main.bounds', 'Kickstarter-Framework-iOSTests/A.swift')).toEqual([]);
  });
  it('accepts a scene configuration supplied in code', () => {
    const app = 'class AppDelegate: UIResponder, UIApplicationDelegate {\n  func application(_ a: UIApplication, configurationForConnecting s: UISceneSession, options: UIScene.ConnectionOptions) -> UISceneConfiguration { fatalError() }\n}';
    expect(ids([{ path: 'A.swift', content: app }, { path: 'S.swift', content: 'class SceneDelegate: NSObject, UIWindowSceneDelegate {}' }])).not.toContain('no-scene-lifecycle');
  });
});

describe('fourth precision review', () => {
  const swiftIds = (content: string, path = 'A.swift') => ids([{ path, content }]);
  it.each([
    ['a size rendered to an image on the next line', 'view.frame.size = CGSize(width: 375, height: 666)\nview.layoutIfNeeded()\nlet image = view.renderAsImage()'],
    ['a popover content size', 'static func preferredContentSize(for model: M) -> CGSize {\n  CGSize(width: 375, height: 520)\n}'],
    ['an estimated size property', 'static var estimatedSize: CGSize {\n  return CGSize(width: 320, height: 63)\n}'],
    ['a preview helper', 'private func makeLoadingPreview() -> UIViewController {\n  let v = UIView()\n  v.frame = CGRect(x: 0, y: 0, width: 402, height: 874)\n  return UIViewController()\n}'],
  ])('ignores %s', (_, code) => {
    expect(swiftIds(code)).toEqual([]);
  });
  it('treats a project square modifier as a fixed frame for any image', () => {
    const square = { path: 'V.swift', content: 'extension View {\n  func square(size: CGFloat) -> some View {\n    frame(width: size, height: size)\n  }\n}' };
    expect(ids([square, { path: 'A.swift', content: 'image\n  .resizable()\n  .square(size: 20)' }])).not.toContain('stretched-image');
  });
  it('skips sample and demo apps in a repo', () => {
    for (const path of ['SampleBrowser/App.swift', 'JSQMessagesDemo/App.swift', 'SwiftExample/App.swift']) expect(swiftIds('let s = UIScreen.main.bounds', path)).toEqual([]);
  });
});

describe('full-screen media only', () => {
  const swiftIds = (content: string, path = 'A.swift') => ids([{ path, content }]);
  it.each([
    ['an inline video with an aspect ratio', 'import AVKit\nVideoPlayer(player: p)\n  .aspectRatio(16 / 9, contentMode: .fit)'],
    ['an inline video with a fixed height and an overlay', 'import AVKit\nVideoPlayer(player: p) {\n  Text("Live")\n}\n.frame(height: 220)'],
    ['a muted background loop', 'let layer = AVPlayerLayer(player: player)\nplayer.isMuted = true'],
  ])('ignores %s', (_, code) => {
    expect(swiftIds(code)).not.toContain('hinge-media');
  });
  it('still flags a video that fills the screen', () => {
    expect(swiftIds('import AVKit\nVideoPlayer(player: p)\n  .aspectRatio(contentMode: .fill)\n  .ignoresSafeArea()')).toContain('hinge-media');
    expect(swiftIds('import AVKit\nVideoPlayer(player: p)')).toContain('hinge-media');
    expect(swiftIds('let layer = AVPlayerLayer(player: player)')).toContain('hinge-media');
  });
  it('ignores a muted Objective-C loop', () => {
    expect(ids([{ path: 'A.m', content: 'AVPlayerLayer *l = [AVPlayerLayer playerLayerWithPlayer:p];\np.muted = YES;' }])).not.toContain('hinge-media');
    expect(ids([{ path: 'A.m', content: 'AVPlayerLayer *l = [AVPlayerLayer playerLayerWithPlayer:p];' }])).toContain('hinge-media');
  });
});

describe('keyboard overlap', () => {
  it('ignores handlers that measure the keyboard against the view', () => {
    const swift = 'let end = (n.userInfo?[UIResponder.keyboardFrameEndUserInfoKey] as? NSValue)?.cgRectValue ?? .zero\nlet local = view.convert(end, from: nil)\nlet overlap = view.bounds.intersection(local).height';
    const objc = 'CGRect end = [n.userInfo[UIKeyboardFrameEndUserInfoKey] CGRectValue];\nCGRect local = [self.view convertRect:end fromView:nil];\nCGFloat h = CGRectIntersection(self.view.bounds, local).size.height;';
    expect(ids([{ path: 'A.swift', content: swift }])).not.toContain('keyboard-frame');
    expect(ids([{ path: 'A.m', content: objc }])).not.toContain('keyboard-frame');
  });
  it('still flags subtracting the keyboard height from the screen', () => {
    const swift = 'let end = (n.userInfo?[UIResponder.keyboardFrameEndUserInfoKey] as? NSValue)?.cgRectValue ?? .zero\nbottom.constant = end.height';
    expect(ids([{ path: 'A.swift', content: swift }])).toContain('keyboard-frame');
  });
});

describe('internal-only gestures', () => {
  it('ignores an edge swipe that opens a debug menu', () => {
    const code = 'static func configure(in window: UIWindow?) {\n  guard BuildConfiguration.current.isInternal else { return }\n  let g = UIScreenEdgePanGestureRecognizer(target: self, action: #selector(open))\n}';
    expect(ids([{ path: 'A.swift', content: code }])).not.toContain('edge-gesture');
    expect(ids([{ path: 'A.swift', content: 'let g = UIScreenEdgePanGestureRecognizer(target: self, action: #selector(showDebugMenu(_:)))' }])).not.toContain('edge-gesture');
    expect(ids([{ path: 'A.swift', content: 'let g = UIScreenEdgePanGestureRecognizer(target: self, action: #selector(back))' }])).toContain('edge-gesture');
  });
});

describe('onboarding footers', () => {
  it('treats an onboarding toolbar as part of the flow, not app chrome', () => {
    expect(ids([{ path: 'A.swift', content: 'struct WMFAppOnboardingToolbar: View {\n  var body: some View { HStack {} }\n}' }])).not.toContain('hand-built-bar');
    expect(ids([{ path: 'A.swift', content: 'struct PlayerToolbar: View {\n  var body: some View { HStack {} }\n}' }])).toContain('hand-built-bar');
  });
});

describe('fifth precision review', () => {
  const swiftIds = (content: string, path = 'A.swift') => ids([{ path, content }]);
  it.each([
    ['a placeholder on its own line in a multi-line call', 'AvatarView(\n  diameter: 96,\n  placeholderImage: Image("gravatar").resizable()\n)'],
    ['an async image framed after its placeholder', 'CachedAsyncImage(url: url) { image in\n  image.resizable()\n} placeholder: {\n  Color.gray\n}\n.frame(width: 40, height: 40)'],
    ['images in a switch inside a fixed frame', 'Group {\n  switch state {\n  case .a:\n    Image(.a).resizable()\n  case .b:\n    Image(.b).resizable()\n  }\n}\n.frame(width: 64, height: 64)'],
    ['a picture capped after its aspect ratio', 'UserProfileImage(id: id)\n  .aspectRatio(contentMode: .fit)\n  .frame(maxWidth: 400)'],
    ['a card capped both ways', 'VStack {\n  Text("a")\n}\n.frame(maxWidth: 350, maxHeight: 350)'],
    ['a thin progress bar', 'ZStack {\n  Capsule()\n}\n.frame(height: 4)\n.frame(maxWidth: 360)'],
    ['a left-edge back swipe', 'let g = UIScreenEdgePanGestureRecognizer(target: self, action: #selector(back))\ng.edges = .left'],
    ['an idiom parameter default', 'init(userInterfaceIdiom: UIUserInterfaceIdiom = .phone) {}'],
    ['a font drawn into an image', 'let image = UIGraphicsImageRenderer(size: s).image { _ in\n  let a = NSAttributedString(string: l, attributes: [.font: UIFont.systemFont(ofSize: 12)])\n}'],
    ['a widget view in a shared module', 'struct WidgetRow: View {\n  @Environment(\\.widgetRenderingMode) var mode\n  var body: some View { Text("1").font(.system(size: 12)) }\n}'],
  ])('ignores %s', (_, code) => {
    expect(swiftIds(code)).toEqual([]);
  });
  it('still flags a right-edge swipe, read per recognizer', () => {
    const code = 'let l = with(UIScreenEdgePanGestureRecognizer()) { $0.edges = .left }\nlet r = with(UIScreenEdgePanGestureRecognizer()) { $0.edges = .right }';
    expect(swiftIds(code)).toEqual(['edge-gesture']);
  });
  it.each([
    ['a starting frame handed to super', '- (instancetype)init {\n  if (self = [super initWithFrame:CGRectMake(0, 0, 320, 393)]) {}\n  return self;\n}'],
    ['a toolbar used as a field accessory', 'self.doneToolbar = [UIToolbar new];\nself.field.inputAccessoryView = self.doneToolbar;'],
    ['a left-edge swipe', 'UIScreenEdgePanGestureRecognizer *g = [[UIScreenEdgePanGestureRecognizer alloc] initWithTarget:self action:@selector(back:)];\ng.edges = UIRectEdgeLeft;'],
  ])('ignores Objective-C %s', (_, code) => {
    expect(ids([{ path: 'A.m', content: code }])).toEqual([]);
  });
});

describe('tall columns', () => {
  it('still flags a column capped in width but free in height', () => {
    expect(ids([{ path: 'A.swift', content: 'VStack {\n  Text("a")\n}\n.frame(maxWidth: 600, maxHeight: .infinity)' }])).toContain('centered-column');
  });
});

describe('other platforms', () => {
  const swiftIds = (content: string, path = 'A.swift') => ids([{ path, content }]);
  it('skips Mac and TV targets and branches', () => {
    expect(swiftIds('let s = UIScreen.main.bounds', 'Pocket Casts TV App/Player.swift')).toEqual([]);
    expect(swiftIds('let s = UIScreen.main.bounds', 'App/App_macOS.swift')).toEqual([]);
    expect(swiftIds('import AppKit\nlet s = UIScreen.main.bounds')).toEqual([]);
    expect(swiftIds('#if os(macOS)\nlet s = UIScreen.main.bounds\n#endif')).toEqual([]);
    expect(swiftIds('#if os(iOS)\nlet a = 1\n#elseif os(tvOS)\nlet s = UIScreen.main.bounds\n#endif')).toEqual([]);
    expect(swiftIds('#if os(iOS)\nlet a = 1\n#else\nlet s = UIScreen.main.bounds\n#endif')).toEqual([]);
  });
  it('keeps iOS code and features named like a platform', () => {
    expect(swiftIds('let s = UIScreen.main.bounds', 'App/Live TV Guide/Grid.swift')).toContain('uiscreen-main');
    expect(swiftIds('#if os(iOS) || os(macOS)\nlet s = UIScreen.main.bounds\n#endif')).toContain('uiscreen-main');
    expect(swiftIds('#if os(macOS)\nlet a = 1\n#else\nlet s = UIScreen.main.bounds\n#endif')).toContain('uiscreen-main');
  });
});

describe('held-out review', () => {
  const swiftIds = (content: string, path = 'A.swift') => ids([{ path, content }]);
  it.each([
    ['a NavigationView in stack style', 'NavigationView {\n  List {}\n}\n.navigationViewStyle(StackNavigationViewStyle())'],
    ['an icon in a project frame modifier', 'image\n  .resizable()\n  .modifier(CompoundIconFrame(fontSize: 20))'],
    ['a placeholder inside a chain that keeps the aspect ratio', 'KFImage.resource(r)\n  .placeholder { _ in\n    placeholder.resizable()\n  }\n  .resizable()\n  .aspectRatio(1, contentMode: .fit)'],
    ['a composer toolbar', 'struct ComposerToolbar: View {\n  var body: some View { HStack {} }\n}'],
    ['a picker accessory toolbar', 'final class PickerToolbarViewController: UIViewController {\n  override func loadView() {\n    let toolbar = UIToolbar()\n    self.view = toolbar\n  }\n}'],
    ['the foreground-active scene', 'let scene = UIApplication.shared.connectedScenes.first(where: { $0.activationState == .foregroundActive })'],
    ['a video export size', 'var videoSize: CGSize {\n  CGSize(width: 390, height: 694)\n}'],
    ['a width fallback before layout', 'let width = view.bounds.width > 0 ? view.bounds.width : 320'],
    ['an orientation handed to a presented player', 'player.orientationAtPresentation = view.window?.windowScene?.interfaceOrientation ?? .portrait'],
    ['a preferred rotation', 'private var preferredLandscapeOrientation: UIInterfaceOrientation {\n  UIDevice.current.orientation == .landscapeRight ? .landscapeLeft : .landscapeRight\n}'],
  ])('ignores %s', (_, code) => {
    expect(swiftIds(code)).toEqual([]);
  });
  it('still flags a NavigationView that shows columns and a screen toolbar', () => {
    expect(swiftIds('NavigationView {\n  List {}\n  Text("d")\n}')).toContain('navigation-view');
    expect(swiftIds('final class PlayerViewController: UIViewController {\n  let bar = UIToolbar()\n}')).toContain('hand-built-bar');
  });
});

describe('second held-out review', () => {
  const swiftIds = (content: string, path = 'A.swift') => ids([{ path, content }]);
  it('trusts callers that keep a view to its aspect ratio', () => {
    const view = { path: 'ImageView.swift', content: 'struct ImageView: View {\n  var body: some View {\n    KFImage(url)\n      .resizable()\n  }\n}' };
    expect(ids([view, { path: 'Menu.swift', content: 'let icon = AnyView(ImageView(url: u).scaledToFit())' }])).toEqual([]);
    expect(ids([view])).toContain('stretched-image');
  });
  it.each([
    ['an orientation parameter in a delegate signature', 'func windowScene(_ s: UIWindowScene, didUpdate c: any UICoordinateSpace, interfaceOrientation previous: UIInterfaceOrientation, traitCollection t: UITraitCollection) {}'],
    ['a font in a print renderer', 'final class Renderer: UIPrintPageRenderer {\n  override func drawHeaderForPage(at i: Int, in r: CGRect) {\n    let f = UIFont.systemFont(ofSize: 10)\n  }\n}'],
    ['a key window from the foreground-active scene', 'guard let w = UIApplication.shared.connectedScenes\n  .compactMap({ $0 as? UIWindowScene })\n  .first(where: { $0.activationState == .foregroundActive })?\n  .windows\n  .first(where: { $0.isKeyWindow }) else { return }'],
    ['a lazy accessory toolbar', 'final class VC: UIViewController {\n  lazy var inputToolbar: UIToolbar = {\n    var toolbar = UIToolbar()\n    return toolbar\n  }()\n  func setUp() { field.inputAccessoryView = inputToolbar }\n}'],
  ])('ignores %s', (_, code) => {
    expect(swiftIds(code)).toEqual([]);
  });
});

describe('foreground scenes', () => {
  const code = 'let w = UIApplication.shared.connectedScenes\n  .compactMap { $0 as? UIWindowScene }\n  .filter { $0.activationState == .foregroundActive }\n  .flatMap(\\.windows)\n  .first { $0.isKeyWindow }';
  it('flags a foreground-active key window only when the app shows several scenes', () => {
    const plist = { path: 'Info.plist', content: '<plist><dict><key>CFBundleName</key><string>A</string><key>UIApplicationSceneManifest</key><dict><key>UIApplicationSupportsMultipleScenes</key><true/></dict></dict></plist>' };
    expect(ids([{ path: 'A.swift', content: code }])).not.toContain('key-window');
    expect(ids([plist, { path: 'A.swift', content: code }])).toContain('key-window');
  });
});

describe('idiom wording', () => {
  it('ignores an idiom check that picks a name or an icon', () => {
    const code = 'private func storageName() -> String {\n  guard UIDevice.current.userInterfaceIdiom == .pad else { return "On My iPhone" }\n  return "On My iPad"\n}';
    expect(ids([{ path: 'A.swift', content: code }])).toEqual([]);
    expect(ids([{ path: 'A.swift', content: 'func layout() {\n  if UIDevice.current.userInterfaceIdiom == .pad { columns = 2 }\n}' }])).toContain('idiom-layout');
  });
});

describe('third held-out review', () => {
  const swiftIds = (content: string, path = 'A.swift') => ids([{ path, content }]);
  const pbx = (check: string, app: boolean) => `LastUpgradeCheck = ${check};\n${app ? 'productType = "com.apple.product-type.application";' : 'productType = "com.apple.product-type.framework";'}\nSDKROOT = iphoneos;`;
  it('reads the SDK from the app project, not its frameworks', () => {
    const found = ids([{ path: 'App.xcodeproj/project.pbxproj', content: pbx('2710', true) }, { path: 'Models/Models.xcodeproj/project.pbxproj', content: pbx('2700', false) }]);
    expect(found).not.toContain('old-sdk');
    expect(ids([{ path: 'Models/Models.xcodeproj/project.pbxproj', content: pbx('2700', false) }])).toContain('old-sdk');
  });
  it.each([
    ['a square frame helper', 'IconProvider.tor\n  .resizable()\n  .frame(.square(16))'],
    ['a theme applied to every scene', 'UIApplication.shared.connectedScenes.map({ scene in\n  (scene as? UIWindowScene)?.windows ?? []\n}).forEach({ windows in\n  for window in windows { window.overrideUserInterfaceStyle = .dark }\n})'],
    ['a starting frame handed to super', 'override init(frame: CGRect) {\n  super.init(frame: CGRect(x: 0, y: 0, width: 375, height: 250))\n}'],
  ])('ignores %s', (_, code) => {
    expect(swiftIds(code)).toEqual([]);
  });
  it('skips lowercase platform and sample folders', () => {
    expect(swiftIds('let s = UIScreen.main.bounds', 'apps/macos/Sources/A.swift')).toEqual([]);
    expect(swiftIds('let s = UIScreen.main.bounds', 'sampleapps/Bug/A.swift')).toEqual([]);
  });
});

describe('screen-level columns', () => {
  it('flags a cap on the whole screen, not on a row inside it', () => {
    const row = 'struct V: View {\n  var body: some View {\n    VStack {\n      Text("Poll").frame(maxWidth: 400)\n      List {}\n    }\n  }\n}';
    const screen = 'struct V: View {\n  var body: some View {\n    if wide {\n      Form {}\n        .frame(maxWidth: 500)\n    } else {\n      Form {}\n    }\n  }\n}';
    expect(ids([{ path: 'A.swift', content: row }])).not.toContain('centered-column');
    expect(ids([{ path: 'A.swift', content: screen }])).toContain('centered-column');
  });
});

describe('fourth held-out review', () => {
  const swiftIds = (content: string, path = 'A.swift') => ids([{ path, content }]);
  it.each([
    ['a stack style set on the content', 'var body: some View {\n  NavigationView {\n    ScrollView {}\n      .navigationViewStyle(.stack)\n  }\n}'],
    ['a fixed frame computed with a call', 'Image(systemName: "circle.fill")\n  .resizable()\n  .frame(width: d * min(scale, 1.5), height: d * min(scale, 1.5))'],
    ['an iPad sheet size', 'static let sizeOniPad: CGSize = CGSize(width: 375, height: 667)'],
  ])('ignores %s', (_, code) => {
    expect(swiftIds(code)).toEqual([]);
  });
  it('still flags a phone screen size', () => {
    expect(swiftIds('let size = CGSize(width: 375, height: 667)')).toContain('fixed-device-size');
  });
});

describe('views built in the same file', () => {
  const head = 'struct V: View {\n  @Environment(\\.horizontalSizeClass) var horizontalSizeClass\n';
  it('reads a local helper before calling a size-class swap stateful', () => {
    const stateless = head + '  var buttons: some View {\n    if horizontalSizeClass == .compact {\n      VStack { cashButton() }\n    } else {\n      HStack { cashButton() }\n    }\n  }\n  func cashButton() -> some View {\n    Button("Cash") {}\n  }\n}';
    const stateful = head + '  var form: some View {\n    if horizontalSizeClass == .compact {\n      VStack { fields }\n    } else {\n      HStack { fields }\n    }\n  }\n  var fields: some View {\n    TextField("Name", text: $name)\n  }\n}';
    expect(ids([{ path: 'A.swift', content: stateless }])).not.toContain('state-reset');
    expect(ids([{ path: 'A.swift', content: stateful }])).toContain('state-reset');
  });
});

describe('code review regressions', () => {
  const swiftIds = (content: string, path = 'A.swift') => ids([{ path, content }]);
  it('reads a ternary, not optional chaining, as a fallback', () => {
    expect(swiftIds('let s = view?.frame(width: 375, height: 667)')).toContain('fixed-device-size');
  });
  it('treats [.left] as a left-edge swipe', () => {
    expect(swiftIds('let g = UIScreenEdgePanGestureRecognizer(target: self, action: #selector(back))\ng.edges = [.left]')).toEqual([]);
  });
  it('only calls a player muted when it is', () => {
    expect(swiftIds('let layer = AVPlayerLayer(player: player)\nplayer.volume = 0.5')).toContain('hinge-media');
  });
  it('skips a one-line capped picture', () => {
    expect(swiftIds('var body: some View {\n  Hero().scaledToFit().frame(maxWidth: 400)\n}')).toEqual([]);
  });
  it('keeps the #else after an iOS #elseif off Duo', () => {
    expect(swiftIds('#if os(macOS)\nlet a = 1\n#elseif os(iOS)\nlet b = 2\n#else\nlet s = UIScreen.main.bounds\n#endif')).toEqual([]);
    expect(swiftIds('#if os(macOS)\nlet a = 1\n#elseif os(iOS)\nlet s = UIScreen.main.bounds\n#endif')).toContain('uiscreen-main');
  });
});

describe('scene loops', () => {
  it('ignores a style applied over the scenes just collected', () => {
    const code = 'let windowScenes = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }\nfor windowScene in windowScenes {\n  for window in windowScene.windows { window.overrideUserInterfaceStyle = style }\n}';
    expect(ids([{ path: 'A.swift', content: code }])).toEqual([]);
  });
});

describe('fifth held-out review', () => {
  const swiftIds = (content: string, path = 'A.swift') => ids([{ path, content }]);
  const plist = { path: 'Info.plist', content: '<plist><dict><key>CFBundleName</key><string>A</string><key>UIApplicationSceneManifest</key><dict><key>UIApplicationSupportsMultipleScenes</key><false/></dict><key>UIApplicationSceneManifest-macos</key><dict><key>UIApplicationSupportsMultipleScenes</key><true/></dict></dict></plist>' };
  it('leaves a TabView wrapper to the tab rule', () => {
    expect(swiftIds('struct TabBarView: View {\n  var body: some View {\n    TabView {}\n  }\n}')).toEqual(['tab-sidebar']);
  });
  it('takes connectedScenes.first in a single-scene app', () => {
    const code = 'guard let s = UIApplication.shared.connectedScenes.first as? UIWindowScene else { return }';
    expect(ids([plist, { path: 'A.swift', content: code }])).not.toContain('key-window');
    expect(swiftIds(code)).toContain('key-window');
  });
  it.each([
    ['a keyboard accessory toolbar frame', 'let toolBar = UIToolbar(frame: .init(x: 0, y: 0, width: 320, height: h))\nself.inputAccessoryView = toolBar'],
    ['the Face ID permission prompt', 'static let nsFaceIDUsageDescription = L10n.tr("InfoPlist", "NSFaceIDUsageDescription", fallback: "Use Face ID to unlock.")'],
  ])('ignores %s', (_, code) => {
    expect(swiftIds(code)).toEqual([]);
  });
});

describe('small UIKit images', () => {
  it('ignores scale-to-fill on an avatar, not on a hero image', () => {
    expect(ids([{ path: 'A.swift', content: 'avatarView.contentMode = .scaleToFill' }])).toEqual([]);
    expect(ids([{ path: 'A.swift', content: 'heroView.contentMode = .scaleToFill' }])).toEqual(['stretched-image']);
  });
});

describe('sixth held-out review', () => {
  it('skips playgrounds', () => {
    expect(ids([{ path: 'Docs/Try.playground/Contents.swift', content: 'let s = UIScreen.main.bounds' }])).toEqual([]);
  });
  it('says a key-window lookup works until the app adopts scenes', () => {
    const app = { path: 'AppDelegate.swift', content: 'class AppDelegate: UIResponder, UIApplicationDelegate {\n  var window: UIWindow?\n}' };
    const found = audit([app, { path: 'A.swift', content: 'let w = UIApplication.shared.keyWindow' }]).findings.find((f) => f.ruleId === 'key-window');
    expect(found?.message).toMatch(/once the app adopts scenes/);
  });
  it('leaves an orientation that only rotates a camera preview', () => {
    expect(ids([{ path: 'A.swift', content: 'let o = scene.interfaceOrientation\nconnection.videoOrientation = AVCaptureVideoOrientation(o)' }])).toEqual([]);
  });
});

describe('hairlines', () => {
  it('names a hairline width as low impact', () => {
    const f = audit([{ path: 'A.swift', content: 'let h = 1 / UIScreen.main.scale' }]).findings[0];
    expect(f.message).toMatch(/hairline/);
  });
});

describe('seventh held-out review', () => {
  const swiftIds = (content: string, path: string) => ids([{ path, content }]);
  it('skips test folders with spaces, developer tools, previews and debug screens', () => {
    for (const path of ['wire-ios/Wire-iOS Tests/Utils/A.swift', 'App/Sources/Developer/DeveloperTools/A.swift', 'UI/Preview/A.swift', 'Monal/Classes/DebugView.swift']) {
      expect(swiftIds('let s = UIScreen.main.bounds', path)).toEqual([]);
    }
  });
  it('reads the SDK once, from the shipping app project', () => {
    const pbx = (check: string, extensions: number) => `LastUpgradeCheck = ${check};\nproductType = "com.apple.product-type.application";\n${'productType = "com.apple.product-type.app-extension";\n'.repeat(extensions)}SDKROOT = iphoneos;`;
    const found = ids([
      { path: 'Sync/Sync.xcodeproj/project.pbxproj', content: pbx('1310', 0) },
      { path: 'App/App.xcodeproj/project.pbxproj', content: pbx('1310', 2) },
    ]);
    expect(found.filter((id) => id === 'old-sdk')).toHaveLength(1);
  });
});

describe('every window', () => {
  it('ignores code that touches every window, and viewport strings with no web view', () => {
    expect(ids([{ path: 'A.swift', content: 'UIApplication.shared.windows.forEach { $0.tintColor = .red }' }])).toEqual([]);
    expect(ids([{ path: 'A.swift', content: 'let html = "<meta name=\\"viewport\\" content=\\"width=320\\">"' }])).toEqual([]);
    expect(ids([{ path: 'A.swift', content: 'let html = "<meta name=\\"viewport\\" content=\\"width=320\\">"\nwebView.loadHTMLString(html, baseURL: nil)\nlet w = WKWebView()' }])).toContain('webview-viewport');
  });
});

describe('sizes that are not screens', () => {
  const swiftIds = (content: string) => ids([{ path: 'A.swift', content }]);
  it.each([
    ['a flow-layout header size', 'func collectionView(_ c: UICollectionView, layout l: UICollectionViewLayout, referenceSizeForHeaderInSection s: Int) -> CGSize {\n  CGSize(width: 320, height: 44)\n}'],
    ['a fitting size', 'let h = cell.systemLayoutSizeFitting(CGSize(width: 375, height: 0)).height'],
    ['a dialog card', 'VStack { Text("Alert") }\n  .frame(width: 320)\n  .background(Color.white)\n  .cornerRadius(12)'],
  ])('ignores %s', (_, code) => {
    expect(swiftIds(code)).toEqual([]);
  });
});

describe('eighth held-out review', () => {
  const swiftIds = (content: string) => ids([{ path: 'A.swift', content }]);
  it('ignores a flow-layout footer size inside a switch', () => {
    expect(swiftIds('func collectionView(_ c: UICollectionView, layout l: UICollectionViewLayout, referenceSizeForFooterInSection s: Int) -> CGSize\n{\n  switch s {\n  case 0:\n    return CGSize(width: 320, height: 20)\n  default:\n    return .zero\n  }\n}')).toEqual([]);
  });
  it('ignores a stretched avatar named just above or by its view type', () => {
    expect(swiftIds('let button = UIButton()\nbutton.layer.cornerRadius = avatarHeight / 2\nbutton.imageView?.contentMode = .scaleToFill')).toEqual([]);
    expect(swiftIds('class AvatarImageView: UIImageView {\n  func setup() {\n    self.contentMode = .scaleToFill\n  }\n}')).toEqual([]);
    expect(swiftIds('class HeroView: UIView {\n  func setup() {\n    imageView.contentMode = .scaleToFill\n  }\n}')).toContain('stretched-image');
  });
  it('flags a reload on resize only for web content', () => {
    const resize = (call: string) => swiftIds(`override func viewWillTransition(to size: CGSize, with coordinator: UIViewControllerTransitionCoordinator) {\n  ${call}\n}`);
    expect(resize('self.listContentController.reload()')).toEqual([]);
    expect(resize('webView.reload()')).toContain('webview-viewport');
  });
  it('ignores a stand-in toolbar drawn during a custom transition', () => {
    expect(swiftIds('class GamesSegue: UIStoryboardSegue {\n  func animate() {\n    let bar = UIToolbar(frame: .zero)\n  }\n}')).toEqual([]);
    expect(swiftIds('func animateTransition(using transitionContext: UIViewControllerContextTransitioning) {\n  let bar = UIToolbar(frame: .zero)\n  transitionContext.containerView.addSubview(bar)\n}')).toEqual([]);
  });
});

describe('ninth held-out review', () => {
  it('keeps a multi-platform App whose Mac adaptor sits under #elseif', () => {
    const app = '@main\nstruct MyApp: App {\n  #if os(iOS)\n  @UIApplicationDelegateAdaptor(AppDelegate.self) var d\n  #elseif os(macOS)\n  @NSApplicationDelegateAdaptor(AppDelegate.self) var d\n  #endif\n  var body: some Scene { WindowGroup { Text("") } }\n}';
    const found = ids([{ path: 'App.swift', content: app }, { path: 'AppDelegate.swift', content: 'class AppDelegate: NSObject, UIApplicationDelegate {}' }]);
    expect(found).not.toContain('no-scene-lifecycle');
  });
  it('reads the scene delegate from the Info.plist manifest', () => {
    const plist = '<plist><dict><key>UIApplicationSceneManifest</key><dict><key>UISceneConfigurations</key><dict><key>UIWindowSceneSessionRoleApplication</key><array><dict><key>UISceneDelegateClassName</key><string>AppSceneDelegate</string></dict></array></dict></dict></dict></plist>';
    const found = ids([{ path: 'Info.plist', content: plist }, { path: 'AppDelegate.h', content: '@interface AppDelegate : UIResponder <UIApplicationDelegate>\n@end' }]);
    expect(found).not.toContain('no-scene-lifecycle');
  });
  it('ignores a toolbar factory that returns the bar', () => {
    expect(ids([{ path: 'A.swift', content: 'enum UIUtils {\n  static func createToolbar() -> UIToolbar {\n    let bar = UIToolbar(frame: .zero)\n    return bar\n  }\n}' }])).toEqual([]);
  });
  it('skips the tab sidebar when another TabView in the project already has one', () => {
    const compact = 'struct CompactTabs: View {\n  var body: some View {\n    TabView {\n      Text("a")\n    }\n  }\n}';
    expect(ids([{ path: 'Compact.swift', content: compact }])).toContain('tab-sidebar');
    expect(ids([{ path: 'Compact.swift', content: compact }, { path: 'Wide.swift', content: 'struct Wide: View {\n  var body: some View {\n    TabView { Text("a") }\n      .tabViewStyle(.sidebarAdaptable)\n  }\n}' }])).not.toContain('tab-sidebar');
  });
  it('skips code after an early return every Duo build takes', () => {
    const fn = (v: string) => ids([{ path: 'A.swift', content: `func width() -> CGFloat {\n  if #available(iOS ${v}, *) {\n    return 300\n  }\n  return UIScreen.main.bounds.width\n}` }]);
    expect(fn('26.0')).toEqual([]);
    expect(fn('28.0')).toContain('uiscreen-main');
  });
});

describe('toolbar factories', () => {
  it('still flags a factory that pins its bar under the status bar', () => {
    expect(ids([{ path: 'A.swift', content: 'func createToolbarView() -> UIToolbar {\n  let bar = UIToolbar(frame: CGRect(x: 0, y: 0, width: webView.frame.width, height: 0))\n  bar.frame.size.height += statusBarHeight\n  return bar\n}' }])).toContain('hand-built-bar');
  });
});
