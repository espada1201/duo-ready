// False alarms and misses found by the ponytail review and by auditing five open-source iOS apps
// (IceCubes, NetNewsWire, Wikipedia, Mastodon, Home Assistant).
import { describe, expect, it } from 'vitest';
import { audit, isRelevant } from '../../src/core/audit';
import type { SourceFile } from '../../src/core/types';

const ids = (files: SourceFile[]) => audit(files).findings.map((f) => f.ruleId);
const swift = (content: string, path = 'A.swift') => ids([{ path, content }]);
const pbx = (settings: string[]) => settings.map((s) => `buildSettings = {\n${s}\n};`).join('\n');

describe('strings and comments', () => {
  it('a /* inside a string does not hide later strings', () => {
    expect(swift('let g = "/tmp/*"\nlet t = "Unlock with Face ID"')).toEqual(['biometry-faceid']);
  });

  it('a multi-line Font.custom with relativeTo scales', () => {
    expect(swift('Text("a").font(.custom("Avenir",\n  size: 17,\n  relativeTo: .body))')).toEqual([]);
  });
});

describe('orientation', () => {
  it('ignores isLandscape on the app’s own types and orientation read for cameras or sensors', () => {
    expect(swift('let w = displayData.isLandscape ? 1 : 2')).toEqual([]);
    expect(swift('let o = AVCaptureVideoOrientation(deviceOrientation: UIDevice.current.orientation)')).toEqual([]);
    expect(swift('sensor.set(UIDevice.current.orientation.rawValue)')).toEqual([]);
    expect(swift('connection.videoOrientation = .portrait\nvar o = UIDevice.current.orientation')).toEqual([]);
    expect(swift('if view.window?.windowScene?.interfaceOrientation.isLandscape == true {}')).toEqual(['orientation-layout']);
  });

  it('lets the _iPhone build setting win, and skips watch and extension targets', () => {
    const generic = 'INFOPLIST_KEY_UISupportedInterfaceOrientations = UIInterfaceOrientationPortrait;';
    const iphone = 'INFOPLIST_KEY_UISupportedInterfaceOrientations_iPhone = "UIInterfaceOrientationPortrait UIInterfaceOrientationLandscapeLeft";';
    expect(ids([{ path: 'A.xcodeproj/project.pbxproj', content: pbx([`${generic}\n${iphone}`]) }])).toEqual([]);
    expect(ids([{ path: 'A.xcodeproj/project.pbxproj', content: pbx([`${generic}\nSDKROOT = watchos;`]) }])).toEqual([]);
    expect(ids([{ path: 'A.xcodeproj/project.pbxproj', content: pbx([generic]) }])).toEqual(['portrait-only']);
  });

  it('skips a watch app’s Info.plist', () => {
    const plist = '<plist><dict><key>WKApplication</key><true/><key>UISupportedInterfaceOrientations</key><array><string>UIInterfaceOrientationPortrait</string></array></dict></plist>';
    expect(ids([{ path: 'Watch/Info.plist', content: plist }])).toEqual([]);
  });
});

describe('code that never ships', () => {
  it('skips test files and folders', () => {
    expect(isRelevant('App/AppTests/LayoutTests.swift')).toBe(false);
    expect(isRelevant('Tests/Shared/Pose.test.swift')).toBe(false);
    expect(isRelevant('App/SpeedTest.swift')).toBe(true);
  });

  it('skips Xcode previews', () => {
    expect(swift('#Preview {\n  Card().frame(width: 375)\n}')).toEqual([]);
    expect(swift('struct P: PreviewProvider {\n  static var previews: some View { Card().previewLayout(.fixed(width: 375, height: 800)) }\n}')).toEqual([]);
    expect(swift('Card().frame(width: 375)')).toEqual(['fixed-device-size']);
  });
});

describe('bars and cameras', () => {
  it('flags bars by name only when the type is the bar itself, and not a bar built just to measure it', () => {
    expect(swift('struct ComposeToolbarView: View { var body: some View { EmptyView() } }')).toEqual(['hand-built-bar']);
    expect(swift('struct NativeTabBarContainerView: View { var body: some View { EmptyView() } }')).toEqual([]);
    expect(swift('let h = UINavigationBar().bounds.height')).toEqual([]);
  });

  it('does not read `!= nil` as a force unwrap', () => {
    expect(swift('let has = AVCaptureDevice.default(.builtInWideAngleCamera, for: .video, position: .front) != nil')).toEqual([]);
  });
});
