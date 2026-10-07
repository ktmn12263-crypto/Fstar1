import CryptoKit
import Combine
import Foundation
import NimbleViews

struct FplusStoreApp: Decodable, Identifiable, Hashable {
	let id: String
	let name: String
	let version: String?
	let iconURL: String?
	let description: String
	let category: String
	let featured: Bool
	let downloadSize: Int64
	let publishedAt: String
	let sha256: String?
	let downloadURL: String?

	enum CodingKeys: String, CodingKey {
		case id, name, version, description, category, featured, sha256
		case iconURL = "icon_url"
		case downloadSize = "download_size"
		case publishedAt = "published_at"
		case downloadURL = "download_url"
	}
}

struct FplusStoreVersion: Decodable, Identifiable, Hashable {
	let id: String
	let version: String
	let build: String
	let downloadSize: Int64
	let sha256: String
	let releaseNotes: String
	let publishedAt: String?
	let downloadURL: String

	enum CodingKeys: String, CodingKey {
		case id, version, build, sha256
		case downloadSize = "download_size"
		case releaseNotes = "release_notes"
		case publishedAt = "published_at"
		case downloadURL = "download_url"
	}
}

struct FplusAppUpdate: Decodable {
	let latestVersion: String
	let minimumVersion: String
	let mandatory: Bool
	let downloadURL: String?
	let sha256: String?
	let releaseNotes: [String]

	enum CodingKeys: String, CodingKey {
		case mandatory, sha256
		case latestVersion = "latest_version"
		case minimumVersion = "minimum_version"
		case downloadURL = "download_url"
		case releaseNotes = "release_notes"
	}
}

private struct FplusAppsResponse: Decodable {
	let apps: [FplusStoreApp]
}

private struct FplusUpdateResponse: Decodable {
	let latestVersion: String
	let minimumVersion: String
	let mandatory: Bool
	let downloadURL: String?
	let sha256: String?
	let releaseNotes: [String]

	enum CodingKeys: String, CodingKey {
		case mandatory, sha256
		case latestVersion = "latest_version"
		case minimumVersion = "minimum_version"
		case downloadURL = "download_url"
		case releaseNotes = "release_notes"
	}

	var update: FplusAppUpdate {
		FplusAppUpdate(
			latestVersion: latestVersion,
			minimumVersion: minimumVersion,
			mandatory: mandatory,
			downloadURL: downloadURL,
			sha256: sha256,
			releaseNotes: releaseNotes
		)
	}
}

private struct FplusAppDetailsResponse: Decodable {
	let app: FplusStoreApp
	let versions: [FplusStoreVersion]
}

private struct FplusErrorResponse: Decodable {
	let error: String
}

struct FplusUser: Decodable {
	let id: String
	let username: String
	let role: String
}

struct FplusLoginResponse: Decodable {
	let token: String
	let expires_at: String
	let user: FplusUser
}

struct FplusDevice: Decodable, Identifiable {
	let id: String
	let device_identifier: String
	let udid: String?
	let name: String?
	let status: String
}

private struct FplusDeviceStatusResponse: Decodable {
	let devices: [FplusDevice]
}

struct FplusDeviceRegisterResponse: Decodable {
	let device_id: String
	let status: String
	let message: String?
}

struct FplusEntitlementResponse: Decodable {
	let allowed: Bool
	let status: String
	let expires_at: String?
}

struct FplusSigningPackage: Decodable {
	let certificate_id: String
	let name: String
	let p12_base64: String
	let provision_base64: String
	let password: String
	let expiration: String?
}

struct FplusAPIClient {
	enum APIError: LocalizedError {
		case invalidBaseURL
		case invalidResponse
		case server(String)
		case checksumMismatch
		case noDownloadAvailable

		var errorDescription: String? {
			switch self {
			case .invalidBaseURL:
				return .localized("Enter a valid HTTPS Fplus server URL.")
			case .invalidResponse:
				return .localized("The Fplus server returned an invalid response.")
			case .server(let message):
				return message
			case .checksumMismatch:
				return .localized("The downloaded IPA failed SHA-256 verification.")
			case .noDownloadAvailable:
				return .localized("This app version is not available for download.")
			}
		}
	}

	func apps(baseURL: String) async throws -> [FplusStoreApp] {
		let url = try endpoint("api/store/apps", baseURL: baseURL)
		let (data, response) = try await URLSession.shared.data(from: url)
		try validate(response, data: data)
		return try JSONDecoder().decode(FplusAppsResponse.self, from: data).apps
	}

	func details(for app: FplusStoreApp, baseURL: String) async throws -> [FplusStoreVersion] {
		let url = try endpoint("api/store/apps/\(app.id)", baseURL: baseURL)
		let (data, response) = try await URLSession.shared.data(from: url)
		try validate(response, data: data)
		return try JSONDecoder().decode(FplusAppDetailsResponse.self, from: data).versions
	}

	func appUpdate(baseURL: String) async throws -> FplusAppUpdate {
		let url = try endpoint("api/app/update", baseURL: baseURL)
		let (data, response) = try await URLSession.shared.data(from: url)
		try validate(response, data: data)
		return try JSONDecoder().decode(FplusUpdateResponse.self, from: data).update
	}

	func download(_ version: FplusStoreVersion, baseURL: String) async throws -> URL {
		guard let url = Self.resolve(version.downloadURL, against: baseURL) else {
			throw APIError.noDownloadAvailable
		}
		let (temporaryURL, response) = try await URLSession.shared.download(from: url)
		defer { try? FileManager.default.removeItem(at: temporaryURL) }
		try validate(response, data: nil)

		guard try Self.sha256(of: temporaryURL).caseInsensitiveCompare(version.sha256) == .orderedSame else {
			throw APIError.checksumMismatch
		}

		let downloadsDirectory = URL.documentsDirectory.appending(path: "FplusDownloads", directoryHint: .isDirectory)
		try FileManager.default.createDirectory(at: downloadsDirectory, withIntermediateDirectories: true)
		let destination = downloadsDirectory.appending(path: "\(UUID().uuidString).ipa")
		try FileManager.default.moveItem(at: temporaryURL, to: destination)
		return destination
	}

	func login(baseURL: String, username: String, password: String) async throws -> FplusLoginResponse {
		let url = try endpoint("api/auth/login", baseURL: baseURL)
		var request = URLRequest(url: url)
		request.httpMethod = "POST"
		request.setValue("application/json", forHTTPHeaderField: "Content-Type")
		let body = ["username": username, "password": password]
		request.httpBody = try JSONSerialization.data(withJSONObject: body)
		let (data, response) = try await URLSession.shared.data(for: request)
		try validate(response, data: data)
		return try JSONDecoder().decode(FplusLoginResponse.self, from: data)
	}

	func registerDevice(baseURL: String, token: String, deviceIdentifier: String, name: String, udid: String?) async throws -> FplusDeviceRegisterResponse {
		let url = try endpoint("api/device/register", baseURL: baseURL)
		var request = URLRequest(url: url)
		request.httpMethod = "POST"
		request.setValue("application/json", forHTTPHeaderField: "Content-Type")
		request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
		var body: [String: Any] = ["device_identifier": deviceIdentifier, "name": name]
		if let udid = udid, !udid.isEmpty { body["udid"] = udid }
		request.httpBody = try JSONSerialization.data(withJSONObject: body)
		let (data, response) = try await URLSession.shared.data(for: request)
		try validate(response, data: data)
		return try JSONDecoder().decode(FplusDeviceRegisterResponse.self, from: data)
	}

	func deviceStatus(baseURL: String, token: String) async throws -> [FplusDevice] {
		let url = try endpoint("api/device/status", baseURL: baseURL)
		var request = URLRequest(url: url)
		request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
		let (data, response) = try await URLSession.shared.data(for: request)
		try validate(response, data: data)
		return try JSONDecoder().decode(FplusDeviceStatusResponse.self, from: data).devices
	}

	func checkEntitlement(baseURL: String, token: String, deviceId: String) async throws -> FplusEntitlementResponse {
		let url = try endpoint("api/entitlement?device_id=\(deviceId)", baseURL: baseURL)
		var request = URLRequest(url: url)
		request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
		let (data, response) = try await URLSession.shared.data(for: request)
		try validate(response, data: data)
		return try JSONDecoder().decode(FplusEntitlementResponse.self, from: data)
	}

	func requestSigningPackage(baseURL: String, token: String, deviceId: String) async throws -> FplusSigningPackage {
		let url = try endpoint("api/signing-package/request", baseURL: baseURL)
		var request = URLRequest(url: url)
		request.httpMethod = "POST"
		request.setValue("application/json", forHTTPHeaderField: "Content-Type")
		request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
		let body = ["device_id": deviceId]
		request.httpBody = try JSONSerialization.data(withJSONObject: body)
		let (data, response) = try await URLSession.shared.data(for: request)
		try validate(response, data: data)
		return try JSONDecoder().decode(FplusSigningPackage.self, from: data)
	}

	func installSigningPackage(_ package: FplusSigningPackage) async throws {
		guard let p12Data = Data(base64Encoded: package.p12_base64),
		      let provData = Data(base64Encoded: package.provision_base64) else {
			throw APIError.server("Invalid base64 payload in signing package.")
		}

		let tempDir = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)
		try FileManager.default.createDirectory(at: tempDir, withIntermediateDirectories: true)
		defer { try? FileManager.default.removeItem(at: tempDir) }

		let tempP12 = tempDir.appendingPathComponent("cert.p12")
		let tempProv = tempDir.appendingPathComponent("profile.mobileprovision")

		try p12Data.write(to: tempP12)
		try provData.write(to: tempProv)

		try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
			FR.handleCertificateFiles(
				p12URL: tempP12,
				provisionURL: tempProv,
				p12Password: package.password,
				certificateName: package.name
			) { error in
				if let error {
					continuation.resume(throwing: error)
				} else {
					continuation.resume()
				}
			}
		}
	}

	static func resolve(_ path: String, against baseURL: String) -> URL? {
		guard
			let base = URL(string: baseURL),
			let url = URL(string: path, relativeTo: base),
			url.host == base.host,
			url.port == base.port,
			url.scheme == base.scheme,
			url.user == nil,
			url.password == nil
		else {
			return nil
		}
		return url.absoluteURL
	}

	private func endpoint(_ path: String, baseURL: String) throws -> URL {
		guard
			let base = URL(string: baseURL.trimmingCharacters(in: .whitespacesAndNewlines)),
			base.scheme?.lowercased() == "https",
			base.host != nil,
			base.user == nil,
			base.password == nil,
			base.query == nil,
			base.fragment == nil
		else {
			throw APIError.invalidBaseURL
		}
		return base.appending(path: path)
	}

	private func validate(_ response: URLResponse, data: Data?) throws {
		guard let http = response as? HTTPURLResponse else {
			throw APIError.invalidResponse
		}
		guard (200..<300).contains(http.statusCode) else {
			let message = data.flatMap { try? JSONDecoder().decode(FplusErrorResponse.self, from: $0).error }
				?? HTTPURLResponse.localizedString(forStatusCode: http.statusCode)
			throw APIError.server(message)
		}
	}

	private static func sha256(of url: URL) throws -> String {
		let file = try FileHandle(forReadingFrom: url)
		defer { try? file.close() }
		var hasher = SHA256()
		while let chunk = try file.read(upToCount: 1024 * 1024), !chunk.isEmpty {
			hasher.update(data: chunk)
		}
		return hasher.finalize().map { String(format: "%02x", $0) }.joined()
	}
}

@MainActor
final class FplusStoreViewModel: ObservableObject {
	@Published private(set) var apps: [FplusStoreApp] = []
	@Published private(set) var isLoading = false
	@Published private(set) var errorMessage: String?
	@Published private(set) var appUpdate: FplusAppUpdate?
	@Published private(set) var updateErrorMessage: String?
	@Published var selectedApp: FplusStoreApp?

	private let client = FplusAPIClient()
	private var latestRequestID = UUID()
	private var loadedBaseURL: String?

	func load(from baseURL: String) async {
		let requestID = UUID()
		latestRequestID = requestID
		if loadedBaseURL != baseURL {
			loadedBaseURL = baseURL
			apps = []
			appUpdate = nil
			errorMessage = nil
			updateErrorMessage = nil
		}
		guard !baseURL.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
			apps = []
			errorMessage = .localized("Configure the HTTPS address of your Fplus server to browse its catalog.")
			isLoading = false
			return
		}

		isLoading = true
		do {
			let result = try await client.apps(baseURL: baseURL)
			guard requestID == latestRequestID else { return }
			apps = result
			errorMessage = nil
			do {
				let update = try await client.appUpdate(baseURL: baseURL)
				guard requestID == latestRequestID else { return }
				appUpdate = update
				updateErrorMessage = nil
			} catch {
				guard requestID == latestRequestID else { return }
				updateErrorMessage = error.localizedDescription
			}
		} catch {
			guard requestID == latestRequestID else { return }
			errorMessage = error.localizedDescription
		}
		if requestID == latestRequestID { isLoading = false }
	}

	var availableAppUpdate: FplusAppUpdate? {
		guard
			let appUpdate,
			appUpdate.downloadURL != nil,
			appUpdate.sha256 != nil
		else {
			return nil
		}
		let currentVersion = Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "0.0.0"
		guard FplusAPIClient.isNewer(appUpdate.latestVersion, than: currentVersion) else { return nil }
		return appUpdate
	}
}

extension FplusAPIClient {
	static func isNewer(_ candidate: String, than current: String) -> Bool {
		let candidateParts = candidate.split(separator: ".").compactMap { Int($0) }
		let currentParts = current.split(separator: ".").compactMap { Int($0) }
		guard !candidateParts.isEmpty, candidateParts.count == candidate.split(separator: ".").count else { return false }
		for index in 0..<max(candidateParts.count, currentParts.count) {
			let newPart = index < candidateParts.count ? candidateParts[index] : 0
			let oldPart = index < currentParts.count ? currentParts[index] : 0
			if newPart != oldPart { return newPart > oldPart }
		}
		return false
	}
}
