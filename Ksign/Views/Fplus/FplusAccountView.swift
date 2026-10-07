import SwiftUI
import NimbleViews

struct FplusAccountView: View {
	@AppStorage("Fplus.apiBaseURL") private var apiBaseURL = ""
	@AppStorage("Fplus.sessionToken") private var sessionToken = ""
	@AppStorage("Fplus.username") private var loggedInUsername = ""
	@AppStorage("Fplus.registeredDeviceId") private var registeredDeviceId = ""

	@State private var usernameInput = ""
	@State private var passwordInput = ""
	@State private var isLoading = false
	@State private var alertTitle = ""
	@State private var alertMessage = ""
	@State private var showAlert = false
	@State private var deviceStatusText = "Unknown"
	@State private var deviceStatusColor: Color = .secondary
	@State private var entitlementActive = false

	private let client = FplusAPIClient()

	private var deviceIdentifier: String {
		UIDevice.current.identifierForVendor?.uuidString ?? "unknown-device"
	}

	private var deviceName: String {
		UIDevice.current.name
	}

	var body: some View {
		NBList("Fplus Account") {
			Section(header: Text("Fplus Server")) {
				TextField("https://192.168.1.10:4317", text: $apiBaseURL)
					.textContentType(.URL)
					.keyboardType(.URL)
					.textInputAutocapitalization(.never)
					.autocorrectionDisabled()
			} footer: {
				Text("Enter the HTTPS address of your Fplus server (PC network IP or domain).")
			}

			if sessionToken.isEmpty {
				Section(header: Text("Account Sign In")) {
					TextField("Username", text: $usernameInput)
						.textInputAutocapitalization(.never)
						.autocorrectionDisabled()
					SecureField("Password", text: $passwordInput)

					Button {
						Task { await _login() }
					} label: {
						if isLoading {
							ProgressView()
								.frame(maxWidth: .infinity, alignment: .center)
						} else {
							Text("Sign In")
								.frame(maxWidth: .infinity, alignment: .center)
						}
					}
					.disabled(isLoading || usernameInput.trimmingCharacters(in: .whitespaces).isEmpty || passwordInput.isEmpty)
				} footer: {
					Text("Sign in with the customer account created by your store administrator.")
				}
			} else {
				Section(header: Text("Signed In Account")) {
					LabeledContent("User", value: loggedInUsername)
					Button("Sign Out", role: .destructive) {
						sessionToken = ""
						loggedInUsername = ""
						registeredDeviceId = ""
						deviceStatusText = "Unknown"
						deviceStatusColor = .secondary
					}
				}

				Section(header: Text("Device Status")) {
					LabeledContent("Device Name", value: deviceName)
					LabeledContent("Identifier", value: String(deviceIdentifier.prefix(12)) + "...")
					HStack {
						Text("Status")
						Spacer()
						Text(deviceStatusText)
							.foregroundStyle(deviceStatusColor)
							.fontWeight(.semibold)
					}

					Button {
						Task { await _registerOrRefreshDevice() }
					} label: {
						Text("Register / Refresh Device")
					}
				} footer: {
					if deviceStatusText == "pending" {
						Text("Device registration is pending administrator approval in the Admin Panel.")
					} else if deviceStatusText == "active" {
						Text("Device is approved and verified.")
					}
				}

				if deviceStatusText == "active" {
					Section(header: Text("Signing Certificate")) {
						Button {
							Task { await _syncSigningCertificate() }
						} label: {
							HStack {
								Image(systemName: "signature")
								Text("Sync Signing Certificate to KSign")
							}
						}
						.disabled(isLoading)
					} footer: {
						Text("Downloads your authorized certificate package and imports it directly into KSign's signing engine for local IPA signing.")
					}
				}
			}

			Section(header: Text("KSign Settings")) {
				NavigationLink {
					SettingsView()
				} label: {
					Label("KSign App Settings", systemImage: "gearshape.2")
				}
			}
		}
		.alert(alertTitle, isPresented: $showAlert) {
			Button("OK", role: .cancel) {}
		} message: {
			Text(alertMessage)
		}
		.task {
			if !sessionToken.isEmpty {
				await _checkDeviceStatus()
			}
		}
	}

	@MainActor
	private func _login() async {
		isLoading = true
		defer { isLoading = false }
		do {
			let response = try await client.login(baseURL: apiBaseURL, username: usernameInput, password: passwordInput)
			sessionToken = response.token
			loggedInUsername = response.user.username
			passwordInput = ""
			await _registerOrRefreshDevice()
		} catch {
			alertTitle = "Sign In Failed"
			alertMessage = error.localizedDescription
			showAlert = true
		}
	}

	@MainActor
	private func _registerOrRefreshDevice() async {
		guard !sessionToken.isEmpty else { return }
		isLoading = true
		defer { isLoading = false }
		do {
			let res = try await client.registerDevice(
				baseURL: apiBaseURL,
				token: sessionToken,
				deviceIdentifier: deviceIdentifier,
				name: deviceName,
				udid: deviceIdentifier
			)
			registeredDeviceId = res.device_id
			deviceStatusText = res.status
			_updateColor(res.status)
			await _checkDeviceStatus()
		} catch {
			alertTitle = "Device Registration"
			alertMessage = error.localizedDescription
			showAlert = true
		}
	}

	@MainActor
	private func _checkDeviceStatus() async {
		guard !sessionToken.isEmpty else { return }
		do {
			let devices = try await client.deviceStatus(baseURL: apiBaseURL, token: sessionToken)
			if let match = devices.first(where: { $0.device_identifier == deviceIdentifier }) {
				registeredDeviceId = match.id
				deviceStatusText = match.status
				_updateColor(match.status)

				let entitlement = try await client.checkEntitlement(baseURL: apiBaseURL, token: sessionToken, deviceId: match.id)
				entitlementActive = entitlement.allowed
			}
		} catch {
			deviceStatusText = "Error"
			deviceStatusColor = .red
		}
	}

	@MainActor
	private func _syncSigningCertificate() async {
		guard !registeredDeviceId.isEmpty else { return }
		isLoading = true
		defer { isLoading = false }
		do {
			let pkg = try await client.requestSigningPackage(
				baseURL: apiBaseURL,
				token: sessionToken,
				deviceId: registeredDeviceId
			)
			try await client.installSigningPackage(pkg)
			alertTitle = "Success"
			alertMessage = "Signing certificate '\(pkg.name)' imported into KSign! You can now sign any IPA locally."
			showAlert = true
		} catch {
			alertTitle = "Signing Certificate"
			alertMessage = error.localizedDescription
			showAlert = true
		}
	}

	private func _updateColor(_ status: String) {
		switch status {
		case "active": deviceStatusColor = .green
		case "pending": deviceStatusColor = .orange
		case "revoked": deviceStatusColor = .red
		default: deviceStatusColor = .secondary
		}
	}
}
