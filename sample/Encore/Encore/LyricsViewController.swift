import UIKit
import WebKit

/// Shows the lyrics page for the current track, with a field for writing a note.
final class LyricsViewController: UIViewController {
    private let webView = WKWebView()
    private let noteField = UITextField()

    override func viewDidLoad() {
        super.viewDidLoad()
        view.addSubview(webView)
        view.addSubview(noteField)
        webView.loadHTMLString("<meta name=\"viewport\" content=\"width=390, user-scalable=no\"><p>Night Drive</p>", baseURL: nil)
        NotificationCenter.default.addObserver(self, selector: #selector(keyboardWillShow), name: UIResponder.keyboardWillShowNotification, object: nil)
    }

    override func viewWillTransition(to size: CGSize, with coordinator: UIViewControllerTransitionCoordinator) {
        super.viewWillTransition(to: size, with: coordinator)
        webView.reload()
    }

    @objc private func keyboardWillShow(_ note: Notification) {
        guard let frame = note.userInfo?[UIResponder.keyboardFrameEndUserInfoKey] as? CGRect else { return }
        noteField.frame.origin.y = view.bounds.height - frame.height - 44
    }
}
