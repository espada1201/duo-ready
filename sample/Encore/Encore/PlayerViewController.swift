import UIKit

final class PlayerViewController: UIViewController {
    private let artwork = UIImageView()
    private let controls = UIToolbar()

    override func viewDidLoad() {
        super.viewDidLoad()
        view.addSubview(artwork)
        view.addSubview(controls)
        // Artwork is rendered at UIScreen.main.scale so it stays crisp.
        artwork.image = ArtworkCache.shared.image(scale: UIScreen.main.scale)
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        let side = view.bounds.width - view.safeAreaInsets.left * 2
        artwork.frame = CGRect(x: view.safeAreaInsets.left, y: 120, width: side, height: side)
        controls.frame = CGRect(x: 0, y: view.bounds.height - 88, width: view.bounds.width, height: 88)

        if UIDevice.current.orientation.isLandscape {
            artwork.isHidden = true
        }
    }
}

final class ArtworkCache {
    static let shared = ArtworkCache()
    func image(scale: CGFloat) -> UIImage? { nil }
}
