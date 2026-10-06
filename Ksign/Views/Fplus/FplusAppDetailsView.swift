import SwiftUI
import NimbleViews

struct FplusAppDetailsView: View {
	@Environment(\.dismiss) private var dismiss
	@State private var versions: [FplusStoreVersion] = []
	@State private var isLoading = true
	@State private var isImporting = false
	@State private var errorMessage: String?
	@State private var alertMessage: String?
	@State private var isAlertPresented = false

	let app: FplusStoreApp
	let apiBaseURL: String

	private let client = FplusAPIClient()

	var body: some View {
		NavigationStack {
			ScrollView {
				VStack(alignment: .leading, spacing: 20) {
					HStack(spacing: 15) {
						FplusAppIcon(url: app.iconURL, baseURL: apiBaseURL, name: app.name)
							.frame(width: 78, height: 78)
						VStack(alignment: .leading, spacing: 5) {
							Text(app.name)
								.font(.title2.weight(.bold))
							Text(app.category)
								.font(.subheadline)
								.foregroundStyle(.secondary)
							if let version = app.version {
								Text("Version \(version)")
									.font(.caption)
									.foregroundStyle(.secondary)
							}
						}
						.frame(maxWidth: .infinity, alignment: .leading)
					}

					Text(app.description)
						.font(.body)

					if let version = versions.first {
						_section(.localized("What's New")) {
							Text(version.releaseNotes.isEmpty ? .localized("No release notes provided.") : version.releaseNotes)
								.foregroundStyle(.secondary)
						}

						_section(.localized("Version Details")) {
							LabeledContent(.localized("Version"), value: version.version)
							LabeledContent(.localized("Build"), value: version.build)
							LabeledContent(.localized("File Size"), value: ByteCountFormatter.string(fromByteCount: version.downloadSize, countStyle: .file))
						}
					}

					if let errorMessage {
						Label(errorMessage, systemImage: "exclamationmark.triangle")
							.font(.footnote)
							.foregroundStyle(.red)
					}

					Button {
						Task { await _downloadAndImport() }
					} label: {
						if isImporting {
							ProgressView()
								.frame(maxWidth: .infinity)
						} else {
							Text(.localized("Download to KSign Library"))
								.frame(maxWidth: .infinity)
						}
					}
					.buttonStyle(.borderedProminent)
					.disabled(isLoading || isImporting || versions.first?.downloadURL.isEmpty != false)

					Text(.localized("The IPA is downloaded to this device, SHA-256 verified, and imported into KSign. Signing remains local and uses your existing KSign certificate."))
						.font(.footnote)
						.foregroundStyle(.secondary)
				}
				.padding()
			}
			.navigationTitle(.localized("App Details"))
			.navigationBarTitleDisplayMode(.inline)
			.toolbar {
				ToolbarItem(placement: .topBarTrailing) {
					Button(.localized("Done")) { dismiss() }
				}
			}
			.overlay {
				if isLoading {
					ProgressView(.localized("Loading app details"))
						.padding()
						.background(.regularMaterial, in: RoundedRectangle(cornerRadius: 12))
				}
			}
			.task {
				do {
					versions = try await client.details(for: app, baseURL: apiBaseURL)
					errorMessage = versions.isEmpty ? .localized("No downloadable version is published yet.") : nil
				} catch {
					errorMessage = error.localizedDescription
				}
				isLoading = false
			}
			.alert(.localized("Fplus Store"), isPresented: $isAlertPresented) {
				Button(.localized("OK"), role: .cancel) {}
			} message: {
				Text(alertMessage ?? "")
			}
		}
	}

	private func _section<Content: View>(
		_ title: String,
		@ViewBuilder content: () -> Content
	) -> some View {
		VStack(alignment: .leading, spacing: 10) {
			Text(title)
				.font(.headline)
			content()
				.font(.subheadline)
		}
		.frame(maxWidth: .infinity, alignment: .leading)
		.padding()
		.background(Color(.secondarySystemBackground), in: RoundedRectangle(cornerRadius: 14))
	}

	@MainActor
	private func _downloadAndImport() async {
		guard let version = versions.first else { return }
		isImporting = true
		errorMessage = nil
		defer { isImporting = false }

		do {
			let localIPA = try await client.download(version, baseURL: apiBaseURL)
			try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
				FR.handlePackageFile(localIPA) { error in
					if let error {
						continuation.resume(throwing: error)
					} else {
						continuation.resume()
					}
				}
			}
			alertMessage = .localized("The verified IPA was imported into the KSign Library. Open Library to select a certificate, sign, and install locally.")
			isAlertPresented = true
		} catch {
			errorMessage = error.localizedDescription
		}
	}
}
