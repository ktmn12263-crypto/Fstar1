import NimbleViews
import SwiftUI

struct FplusView: View {
	@AppStorage("Fplus.apiBaseURL") private var apiBaseURL = ""
	@StateObject private var viewModel = FplusStoreViewModel()
	@State private var searchText = ""
	@State private var selectedCategory: String?
	@State private var isUpdateImporting = false
	@State private var isUpdateAlertPresented = false
	@State private var updateAlertMessage = ""

	private let apiClient = FplusAPIClient()

	private var categories: [String] {
		Array(Set(viewModel.apps.map(\.category))).sorted()
	}

	private var filteredApps: [FplusStoreApp] {
		viewModel.apps.filter { app in
			let matchesSearch = searchText.isEmpty ||
				app.name.localizedCaseInsensitiveContains(searchText) ||
				app.description.localizedCaseInsensitiveContains(searchText) ||
				app.category.localizedCaseInsensitiveContains(searchText)
			let matchesCategory = selectedCategory == nil || app.category == selectedCategory
			return matchesSearch && matchesCategory
		}
	}
	private var featuredApps: [FplusStoreApp] {
		filteredApps.filter(\.featured)
	}

	var body: some View {
		NavigationStack {
			Group {
				if viewModel.isLoading && viewModel.apps.isEmpty && viewModel.availableAppUpdate == nil {
					_progressState
				} else if let error = viewModel.errorMessage, viewModel.apps.isEmpty && viewModel.availableAppUpdate == nil {
					_errorState(error)
				} else if viewModel.apps.isEmpty && viewModel.availableAppUpdate == nil {
					_emptyState
				} else {
					_storeContent
				}
			}
			.navigationTitle("Fplus")
			.searchable(text: $searchText, prompt: .localized("Search apps"))
			.toolbar {
				ToolbarItemGroup(placement: .topBarTrailing) {
					NavigationLink {
						FplusWebPageView()
					} label: {
						Image(systemName: "safari")
					}
					.accessibilityLabel("Custom Portal")

					NavigationLink {
						FplusAccountView()
					} label: {
						Image(systemName: "gearshape.2")
					}
					.accessibilityLabel(.localized("Settings"))
				}
			}
			.refreshable {
				await viewModel.load(from: apiBaseURL)
			}
			.sheet(item: $viewModel.selectedApp) { app in
				FplusAppDetailsView(app: app, apiBaseURL: apiBaseURL)
			}
			.alert(.localized("KSign Update"), isPresented: $isUpdateAlertPresented) {
				Button(.localized("OK"), role: .cancel) {}
			} message: {
				Text(updateAlertMessage)
			}
			.task(id: apiBaseURL) {
				await viewModel.load(from: apiBaseURL)
			}
		}
	}

	private var _storeContent: some View {
		ScrollView {
			VStack(alignment: .leading, spacing: 24) {
				_settingsLink

				if let update = viewModel.availableAppUpdate {
					_section(.localized("KSign Update")) {
						VStack(alignment: .leading, spacing: 10) {
							Label(
								update.mandatory
									? .localized("Required update")
									: .localized("New version available"),
								systemImage: update.mandatory ? "exclamationmark.circle.fill" : "arrow.down.circle.fill"
							)
							.font(.headline)

							Text("Version \(update.latestVersion)")
								.font(.subheadline.weight(.semibold))
							if !update.releaseNotes.isEmpty {
								Text(update.releaseNotes.map { "• \($0)" }.joined(separator: "\n"))
									.font(.subheadline)
									.foregroundStyle(.secondary)
							}

							Button {
								Task { await _downloadUpdate(update) }
							} label: {
								if isUpdateImporting {
									ProgressView()
										.frame(maxWidth: .infinity)
								} else {
									Text(.localized("Download Update to KSign Library"))
										.frame(maxWidth: .infinity)
								}
							}
							.buttonStyle(.borderedProminent)
							.disabled(isUpdateImporting)

							Text(update.mandatory
								? .localized("The store marks this release as required. KSign cannot force installation; continue through the supported local signing workflow.")
								: .localized("Updates are shown explicitly. Installation still uses the supported KSign distribution and local signing flow."))
								.font(.footnote)
								.foregroundStyle(.secondary)
						}
						.padding()
						.background(Color(.secondarySystemBackground), in: RoundedRectangle(cornerRadius: 16))
					}
				}

				if !featuredApps.isEmpty {
					_section(.localized("Featured Apps")) {
						ForEach(featuredApps) { app in
							FplusStoreCard(app: app, apiBaseURL: apiBaseURL) {
								viewModel.selectedApp = app
							}
						}
					}
				}

				if !filteredApps.isEmpty {
					_section(.localized("Recently Added")) {
						ForEach(filteredApps) { app in
							FplusStoreCard(app: app, apiBaseURL: apiBaseURL) {
								viewModel.selectedApp = app
							}
						}
					}
				} else {
					_contentMessage(
						title: viewModel.apps.isEmpty
							? .localized("No apps published yet")
							: .localized("No matching apps"),
						message: viewModel.apps.isEmpty
							? .localized("Apps published to your Fplus server will appear here.")
							: .localized("Try another search or category.")
					)
				}

				if !categories.isEmpty {
					VStack(alignment: .leading, spacing: 12) {
						Text(.localized("Categories"))
							.font(.title3.weight(.semibold))
						ScrollView(.horizontal, showsIndicators: false) {
							HStack(spacing: 8) {
								_categoryChip(.localized("All Apps"), category: nil)
								ForEach(categories, id: \.self) { category in
									_categoryChip(category, category: category)
								}
							}
						}
					}
				}

				if let error = viewModel.errorMessage {
					_contentMessage(
						title: .localized("Unable to refresh"),
						message: error,
						actionTitle: .localized("Try Again")
					) {
						Task { await viewModel.load(from: apiBaseURL) }
					}
				}

				if let updateError = viewModel.updateErrorMessage {
					_contentMessage(
						title: .localized("Unable to check for KSign updates"),
						message: updateError
					)
				}
			}
			.padding()
		}
		.overlay(alignment: .top) {
			if viewModel.isLoading && !viewModel.apps.isEmpty {
				ProgressView()
					.padding(.top, 8)
			}
		}
	}

	private var _settingsLink: some View {
		NavigationLink {
			SettingsView()
		} label: {
			Label(.localized("KSign Settings"), systemImage: "gearshape.2")
				.frame(maxWidth: .infinity, alignment: .leading)
		}
		.buttonStyle(.bordered)
	}

	private var _progressState: some View {
		VStack(spacing: 12) {
			ProgressView()
			Text(.localized("Loading Fplus Store"))
				.font(.headline)
			Text(.localized("Connecting to your configured store server."))
				.font(.subheadline)
				.foregroundStyle(.secondary)
		}
		.frame(maxWidth: .infinity, maxHeight: .infinity)
	}

	private var _emptyState: some View {
		VStack(spacing: 12) {
			Image(systemName: "bag")
				.font(.largeTitle)
				.foregroundStyle(.secondary)
			Text(.localized("No apps published yet"))
				.font(.headline)
			Text(.localized("Apps published to your Fplus server will appear here."))
				.font(.subheadline)
				.foregroundStyle(.secondary)
				.multilineTextAlignment(.center)
			_settingsLink
				.padding(.top, 8)
		}
		.padding(28)
		.frame(maxWidth: .infinity, maxHeight: .infinity)
	}

	private func _errorState(_ message: String) -> some View {
		VStack(spacing: 12) {
			Image(systemName: "wifi.exclamationmark")
				.font(.largeTitle)
				.foregroundStyle(.secondary)
			Text(.localized("Unable to connect"))
				.font(.headline)
			Text(message)
				.font(.subheadline)
				.foregroundStyle(.secondary)
				.multilineTextAlignment(.center)
			if apiBaseURL.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
				NavigationLink {
					FplusAccountView()
				} label: {
					Text(.localized("Configure Server"))
				}
				.buttonStyle(.borderedProminent)
			} else {
				Button(.localized("Try Again")) {
					Task { await viewModel.load(from: apiBaseURL) }
				}
				.buttonStyle(.borderedProminent)
			}
		}
		.padding(28)
		.frame(maxWidth: .infinity, maxHeight: .infinity)
	}

	private func _section<Content: View>(
		_ title: String,
		@ViewBuilder content: () -> Content
	) -> some View {
		VStack(alignment: .leading, spacing: 12) {
			Text(title)
				.font(.title3.weight(.semibold))
			content()
		}
		.frame(maxWidth: .infinity, alignment: .leading)
	}

	private func _categoryChip(_ title: String, category: String?) -> some View {
		Button {
			selectedCategory = category
		} label: {
			Text(title)
				.font(.subheadline.weight(.medium))
				.padding(.horizontal, 14)
				.padding(.vertical, 8)
				.background(
					selectedCategory == category ? Color.accentColor : Color(.secondarySystemBackground),
					in: Capsule()
				)
				.foregroundStyle(selectedCategory == category ? Color.white : Color.primary)
		}
		.buttonStyle(.plain)
	}

	private func _contentMessage(
		title: String,
		message: String,
		actionTitle: String? = nil,
		action: (() -> Void)? = nil
	) -> some View {
		VStack(alignment: .leading, spacing: 8) {
			Text(title)
				.font(.headline)
			Text(message)
				.font(.subheadline)
				.foregroundStyle(.secondary)
			if let actionTitle, let action {
				Button(actionTitle, action: action)
					.buttonStyle(.bordered)
			}
		}
		.frame(maxWidth: .infinity, alignment: .leading)
		.padding()
		.background(Color(.secondarySystemBackground), in: RoundedRectangle(cornerRadius: 14))
	}

	@MainActor
	private func _downloadUpdate(_ update: FplusAppUpdate) async {
		guard let downloadURL = update.downloadURL, let sha256 = update.sha256 else { return }
		isUpdateImporting = true
		defer { isUpdateImporting = false }
		let version = FplusStoreVersion(
			id: "ksign-update",
			version: update.latestVersion,
			build: "0",
			downloadSize: 0,
			sha256: sha256,
			releaseNotes: update.releaseNotes.joined(separator: "\n"),
			publishedAt: nil,
			downloadURL: downloadURL
		)

		do {
			let localIPA = try await apiClient.download(version, baseURL: apiBaseURL)
			try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
				FR.handlePackageFile(localIPA) { error in
					if let error {
						continuation.resume(throwing: error)
					} else {
						continuation.resume()
					}
				}
			}
			updateAlertMessage = .localized("The verified update was added to the KSign Library. Continue using the supported installation workflow for this build.")
			isUpdateAlertPresented = true
		} catch {
			updateAlertMessage = error.localizedDescription
			isUpdateAlertPresented = true
		}
	}
}

struct FplusStoreCard: View {
	let app: FplusStoreApp
	let apiBaseURL: String
	let select: () -> Void

	var body: some View {
		Button(action: select) {
			HStack(spacing: 12) {
				FplusAppIcon(url: app.iconURL, baseURL: apiBaseURL, name: app.name)
					.frame(width: 56, height: 56)
				VStack(alignment: .leading, spacing: 4) {
					Text(app.name)
						.font(.headline)
						.lineLimit(1)
					Text(app.description.isEmpty ? app.category : app.description)
						.font(.subheadline)
						.foregroundStyle(.secondary)
						.lineLimit(2)
					Text("\(app.category) · \(app.version.map { "v\($0)" } ?? .localized("Details"))")
						.font(.caption)
						.foregroundStyle(.tertiary)
				}
				.frame(maxWidth: .infinity, alignment: .leading)
				Image(systemName: "chevron.right")
					.font(.caption.weight(.semibold))
					.foregroundStyle(.tertiary)
			}
			.padding(12)
			.background(Color(.secondarySystemBackground), in: RoundedRectangle(cornerRadius: 16))
			.contentShape(RoundedRectangle(cornerRadius: 16))
		}
		.buttonStyle(.plain)
	}
}

struct FplusAppIcon: View {
	let url: String?
	let baseURL: String
	let name: String

	var body: some View {
		Group {
			if let url, let resolved = FplusAPIClient.resolve(url, against: baseURL) {
				AsyncImage(url: resolved) { phase in
					if let image = phase.image {
						image.resizable().scaledToFill()
					} else {
						_placeholder
					}
				}
			} else {
				_placeholder
			}
		}
		.clipShape(RoundedRectangle(cornerRadius: 14))
	}

	private var _placeholder: some View {
		ZStack {
			RoundedRectangle(cornerRadius: 14)
				.fill(Color.accentColor.gradient)
			Text(String(name.prefix(1)).uppercased())
				.font(.title2.weight(.bold))
				.foregroundStyle(.white)
		}
	}
}
