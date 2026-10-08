import SwiftUI
import WebKit

/// A full-screen WebView that loads a server-driven custom page from Fplus.
/// The page slug is stored in @AppStorage so the user or admin can change
/// it live without rebuilding the app.
struct FplusWebPageView: View {
	@AppStorage("Fplus.apiBaseURL") private var apiBaseURL: String = ""
	@AppStorage("fplus_custom_page_slug") private var pageSlug: String = "home"

	@State private var pageTitle: String = "Custom Page"
	@State private var htmlContent: String = ""
	@State private var isLoading = true
	@State private var errorMessage: String? = nil

	var body: some View {
		Group {
			if isLoading {
				VStack(spacing: 12) {
					ProgressView()
					Text("Loading...")
						.font(.footnote)
						.foregroundStyle(.secondary)
				}
				.frame(maxWidth: .infinity, maxHeight: .infinity)
			} else if let error = errorMessage {
				VStack(spacing: 16) {
					Image(systemName: "exclamationmark.triangle.fill")
						.font(.system(size: 40))
						.foregroundStyle(.orange)
					Text("Unable to load page")
						.font(.headline)
					Text(error)
						.font(.subheadline)
						.multilineTextAlignment(.center)
						.foregroundStyle(.secondary)
						.padding(.horizontal)
					Button("Retry") {
						Task { await loadPage() }
					}
					.buttonStyle(.borderedProminent)
				}
				.frame(maxWidth: .infinity, maxHeight: .infinity)
			} else {
				CustomWebView(html: htmlContent, baseURL: apiBaseURL)
					.ignoresSafeArea(edges: .bottom)
			}
		}
		.navigationTitle(pageTitle)
		.navigationBarTitleDisplayMode(.inline)
		.toolbar {
			ToolbarItem(placement: .topBarTrailing) {
				Button {
					Task { await loadPage() }
				} label: {
					Image(systemName: "arrow.clockwise")
				}
				.accessibilityLabel("Reload")
			}
		}
		.task { await loadPage() }
		.refreshable { await loadPage() }
	}

	private func loadPage() async {
		guard !apiBaseURL.isEmpty else {
			errorMessage = "Fplus server URL is not configured. Please set it in Settings → Fplus."
			isLoading = false
			return
		}
		guard !pageSlug.isEmpty else {
			errorMessage = "Page slug is empty. Please configure it in Fplus Settings."
			isLoading = false
			return
		}

		isLoading = true
		errorMessage = nil
		do {
			let base = apiBaseURL.hasSuffix("/") ? String(apiBaseURL.dropLast()) : apiBaseURL
			guard let url = URL(string: "\(base)/api/store/page/\(pageSlug)") else {
				throw URLError(.badURL)
			}
			var req = URLRequest(url: url)
			req.timeoutInterval = 15
			let (data, response) = try await URLSession.shared.data(for: req)
			if let http = response as? HTTPURLResponse, http.statusCode != 200 {
				if http.statusCode == 404 {
					throw NSError(domain: "Fplus", code: 404, userInfo: [NSLocalizedDescriptionKey: "Page '\(pageSlug)' not found. Create it in Admin Panel → Custom Pages."])
				}
				throw NSError(domain: "Fplus", code: http.statusCode, userInfo: [NSLocalizedDescriptionKey: "Server returned code \(http.statusCode)"])
			}
			struct PageResponse: Decodable {
				let title: String
				let html: String
			}
			let decoded = try JSONDecoder().decode(PageResponse.self, from: data)
			pageTitle = decoded.title.isEmpty ? pageSlug : decoded.title
			htmlContent = decoded.html
			isLoading = false
		} catch {
			errorMessage = error.localizedDescription
			isLoading = false
		}
	}
}

/// UIViewRepresentable wrapper around WKWebView that renders raw HTML and
/// bypasses local self-signed TLS cert challenges.
private struct CustomWebView: UIViewRepresentable {
	let html: String
	let baseURL: String

	func makeCoordinator() -> Coordinator {
		Coordinator()
	}

	func makeUIView(context: Context) -> WKWebView {
		let config = WKWebViewConfiguration()
		config.allowsInlineMediaPlayback = true
		let webView = WKWebView(frame: .zero, configuration: config)
		webView.navigationDelegate = context.coordinator
		webView.scrollView.contentInsetAdjustmentBehavior = .automatic
		return webView
	}

	func updateUIView(_ webView: WKWebView, context: Context) {
		let base = URL(string: baseURL.hasSuffix("/") ? String(baseURL.dropLast()) : baseURL)
		webView.loadHTMLString(html, baseURL: base)
	}

	class Coordinator: NSObject, WKNavigationDelegate {
		func webView(
			_ webView: WKWebView,
			didReceive challenge: URLAuthenticationChallenge,
			completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void
		) {
			if challenge.protectionSpace.authenticationMethod == NSURLAuthenticationMethodServerTrust,
			   let serverTrust = challenge.protectionSpace.serverTrust {
				completionHandler(.useCredential, URLCredential(trust: serverTrust))
				return
			}
			completionHandler(.performDefaultHandling, nil)
		}
	}
}
