import LocalAuthentication
import SwiftUI

struct UnlockView: View {
    @State private var canUseBiometrics = false

    var body: some View {
        VStack(spacing: 16) {
            Image("Cover")
                .resizable()
                .frame(maxWidth: .infinity, maxHeight: 160)
            Text("Your library is locked")
                .font(.system(size: 22, weight: .semibold))
            if canUseBiometrics {
                Button("Unlock with Face ID", action: unlock)
            }
        }
        .onAppear {
            let context = LAContext()
            _ = context.canEvaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, error: nil)
            canUseBiometrics = context.biometryType == .faceID
        }
    }

    private func unlock() {}
}
