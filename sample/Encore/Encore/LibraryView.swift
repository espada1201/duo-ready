import SwiftUI

struct LibraryView: View {
    @Environment(\.horizontalSizeClass) private var horizontalSizeClass
    @State private var selection = 0

    var body: some View {
        TabView(selection: $selection) {
            NavigationView {
                AlbumGrid()
                    .navigationTitle("Library")
            }
            .tag(0)
            SearchView()
                .tag(1)
        }
    }
}

struct AlbumGrid: View {
    @Environment(\.horizontalSizeClass) private var horizontalSizeClass

    var columns: Int {
        UIDevice.current.userInterfaceIdiom == .pad ? 4 : 2
    }

    var body: some View {
        if horizontalSizeClass == .regular {
            HStack {
                AlbumList()
                NowPlayingView()
            }
        } else {
            AlbumList()
                .frame(maxWidth: 500)
        }
    }
}

struct AlbumList: View {
    var body: some View {
        List(0..<20) { index in
            Text("Album \(index + 1)")
        }
    }
}

struct SearchView: View {
    var body: some View {
        Text("Search the catalog for \"UIScreen.main\" fans")
            .frame(width: 390)
    }
}

struct MiniTabBar: View {
    var body: some View {
        HStack {
            Image(systemName: "play.fill")
            Spacer()
            Image(systemName: "forward.fill")
        }
        .padding()
    }
}
