import SwiftUI
import UIKit

enum AdaptiveLayout {
    static func isPadLandscape(_ size: CGSize) -> Bool {
        let scene = UIApplication.shared.connectedScenes
            .compactMap { $0 as? UIWindowScene }
            .first { $0.activationState == .foregroundActive }
        // Keyboard avoidance changes content height, but not the window bounds.
        let windowSize = scene?.windows.first(where: \.isKeyWindow)?.bounds.size ?? size
        return UIDevice.current.userInterfaceIdiom == .pad && windowSize.width > windowSize.height
    }
}
