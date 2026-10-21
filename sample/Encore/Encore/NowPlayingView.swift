import SwiftUI

struct NowPlayingView: View {
    var body: some View {
        ScrollView {
            ArrangementView {
                PlayerArtwork()
            } secondary: {
                NavigationSplitView {
                    UpNextList()
                } detail: {
                    Text("Lyrics")
                }
            }
        }
    }
}

struct PlayerArtwork: View {
    var body: some View {
        RoundedRectangle(cornerRadius: 24)
            .aspectRatio(1, contentMode: .fit)
    }
}

struct UpNextList: View {
    var body: some View {
        List(0..<8) { index in
            Text("Track \(index + 1)")
        }
    }
}
