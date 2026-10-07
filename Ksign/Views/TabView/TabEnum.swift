//
//  TabEnum.swift
//  feather
//
//  Created by samara on 22.03.2025.
//

import SwiftUI
import NimbleViews

enum TabEnum: String, CaseIterable, Hashable {
    case files
	case sources
	case library
    case fplus
	case certificates
	case appstore
    case downloader
	var title: String {
		switch self {
        case .files:        return .localized("Files")
		case .sources:     	return .localized("Sources")
		case .library: 		return .localized("Library")
        case .fplus: 		return "Fplus"
		case .certificates:	return .localized("Certificates")
		case .appstore: 	return .localized("App Store")
        case .downloader:   return .localized("Downloads")
		}
	}
	
	var icon: String {
		switch self {
        case .files:        return "folder.fill"
		case .sources: 		return "globe.desk"
		case .library: 		return "square.grid.2x2"
        case .fplus: 		return "bag"
		case .certificates: return "person.text.rectangle"
		case .appstore: 	return "plus.app.fill"
        case .downloader:    return "square.and.arrow.down.fill"
		}
	}
	
	@ViewBuilder
	static func view(for tab: TabEnum) -> some View {
		switch tab {
        case .files: FilesView()
		case .sources: SourcesView()
		case .library: LibraryView()
        case .fplus: FplusView()
		case .certificates: NBNavigationView(.localized("Certificates")) { CertificatesView() }
		case .appstore: AppstoreView()
        case .downloader: DownloaderView()
		}
	}
	
	static var defaultTabs: [TabEnum] {
		return [
			.fplus,
			.files,
			.library,
			.appstore,
			.downloader,
		]
	}
	
	static var customizableTabs: [TabEnum] {
		return [
			.certificates
		]
	}
}
