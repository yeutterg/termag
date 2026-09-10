import SwiftUI
import WebKit

struct TerminalDetail: View {
    @EnvironmentObject private var store: TerminalStore
    @Environment(\.scenePhase) private var scenePhase
    let server: URL
    let project: TerminalProject
    let tab: TerminalTab
    @State private var generation = UUID()

    private var url: URL {
        var parts = URLComponents(url: server.appendingPathComponent("native/terminal"), resolvingAgainstBaseURL: false)!
        parts.queryItems = [URLQueryItem(name: "project", value: project.id), URLQueryItem(name: "tab", value: tab.id)]
        return parts.url!
    }

    private var layoutIdentity: String {
        project.tabs.filter { ($0.runtimeTabId ?? $0.id) == (tab.runtimeTabId ?? tab.id) }
            .map { "\($0.id):\($0.layout ?? "")" }.joined(separator: "|")
    }

    var body: some View {
        Group {
            if scenePhase == .active {
                ServerWebView(url: url, dataStore: store.websiteData)
                    .id("\(generation):\(layoutIdentity)")
            } else {
                Color.black.overlay { Image(systemName: "terminal").foregroundStyle(.secondary) }
            }
        }
        .navigationTitle(tab.runtimeTabName ?? tab.name)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            Button("Reconnect", systemImage: "arrow.clockwise") { generation = UUID() }
        }
    }
}

/// WebKit owns only the terminal surface.
/// No JS message handler, terminal-output bridge, disk cache, or bundled web dashboard.
struct ServerWebView: UIViewRepresentable {
    let url: URL
    let dataStore: WKWebsiteDataStore

    func makeCoordinator() -> Coordinator { Coordinator(self) }

    func makeUIView(context: Context) -> WKWebView {
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = dataStore
        let view = WKWebView(frame: .zero, configuration: configuration)
        view.navigationDelegate = context.coordinator
        view.uiDelegate = context.coordinator
        view.isOpaque = false
        view.backgroundColor = .black
        view.scrollView.backgroundColor = .black
        view.scrollView.contentInsetAdjustmentBehavior = .never
        view.scrollView.isScrollEnabled = false
        view.isInspectable = false
        view.load(URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData))
        return view
    }

    func updateUIView(_ view: WKWebView, context: Context) { }

    static func dismantleUIView(_ view: WKWebView, coordinator: Coordinator) {
        view.stopLoading()
        view.navigationDelegate = nil
        view.uiDelegate = nil
        // Tear down the page and its WebSockets immediately when leaving a terminal.
        view.loadHTMLString("", baseURL: nil)
    }

    @MainActor
    final class Coordinator: NSObject, WKNavigationDelegate, WKUIDelegate {
        let parent: ServerWebView
        init(_ parent: ServerWebView) { self.parent = parent }

        private func sameOrigin(_ url: URL) -> Bool {
            url.scheme == parent.url.scheme && url.host == parent.url.host &&
                (url.port ?? 443) == (parent.url.port ?? 443)
        }

        func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction,
                     decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
            if action.request.url?.absoluteString == "about:blank" {
                decisionHandler(.allow)
                return
            }
            guard let url = action.request.url, url.scheme == "https" else {
                decisionHandler(.cancel)
                return
            }
            if sameOrigin(url), url.path == "/native/terminal" {
                decisionHandler(.allow)
            } else {
                decisionHandler(.cancel)
                if action.navigationType == .linkActivated {
                    UIApplication.shared.open(url)
                } else {
                    showError(webView, "Your session expired. Disconnect in Settings, then sign in again.")
                }
            }
        }

        func webView(_ webView: WKWebView, decidePolicyFor response: WKNavigationResponse,
                     decisionHandler: @escaping (WKNavigationResponsePolicy) -> Void) {
            if response.isForMainFrame, let http = response.response as? HTTPURLResponse,
               http.statusCode >= 400 {
                decisionHandler(.cancel)
                showError(webView, "This terminal is unavailable. Refresh your spaces or reconnect. The server must include the iOS terminal route.")
            } else { decisionHandler(.allow) }
        }

        func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
            if (error as NSError).code != NSURLErrorCancelled {
                showError(webView, "Couldn’t connect to the server. Check your connection, then try again.")
            }
        }

        func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
            if (error as NSError).code != NSURLErrorCancelled {
                showError(webView, "The connection was interrupted. Try reconnecting.")
            }
        }

        func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
            webView.load(URLRequest(url: parent.url, cachePolicy: .reloadIgnoringLocalCacheData))
        }

        func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
                     for action: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
            guard let url = action.request.url, url.scheme == "https" else { return nil }
            UIApplication.shared.open(url)
            return nil
        }

        private func showError(_ view: WKWebView, _ message: String) {
            // Messages are fixed local strings, never terminal/server payloads.
            view.loadHTMLString("""
            <html><head><meta name="viewport" content="width=device-width,initial-scale=1">
            <meta name="color-scheme" content="dark"></head>
            <body style="background:#000;color:#aaa;font:17px -apple-system;padding:24px">\(message)</body></html>
            """, baseURL: nil)
        }
    }
}
