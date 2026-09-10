import SwiftUI

@main
struct TerminalzApp: App {
    @StateObject private var store = TerminalStore()

    var body: some Scene {
        WindowGroup {
            TerminalBrowser()
                .environmentObject(store)
                .preferredColorScheme(.dark)
                .tint(.blue)
        }
    }
}
