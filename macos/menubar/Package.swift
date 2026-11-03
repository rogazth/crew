// swift-tools-version:5.9
// Crew's menu bar extra: a macOS-only helper the app starts beside its window.
import PackageDescription

let package = Package(
    name: "CrewMenuBar",
    platforms: [.macOS(.v13)],
    targets: [
        .executableTarget(name: "CrewMenuBar", path: "Sources/CrewMenuBar"),
    ]
)
