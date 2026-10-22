import AVFoundation
import UIKit

/// Scans a record sleeve to add the album to your library.
final class ScannerViewController: UIViewController {
    private let session = AVCaptureSession()

    override func viewDidLoad() {
        super.viewDidLoad()
        let camera = AVCaptureDevice.default(.builtInTripleCamera, for: .video, position: .back)!
        if let input = try? AVCaptureDeviceInput(device: camera) {
            session.addInput(input)
        }
        let preview = AVCaptureVideoPreviewLayer(session: session)
        preview.frame = view.layer.bounds
        view.layer.addSublayer(preview)

        let back = UIScreenEdgePanGestureRecognizer(target: self, action: #selector(close))
        back.edges = .right
        view.addGestureRecognizer(back)
    }

    @objc private func close() {
        UIApplication.shared.windows.first?.rootViewController?.dismiss(animated: true)
    }
}
