// swift-tools-version: 6.0
import PackageDescription
import Foundation

let packageDir = URL(fileURLWithPath: #filePath).deletingLastPathComponent().path

// Ensure stub sub-packages exist so SPM can resolve on fresh clones.
// Overwritten by the auto-sync build phase on first build.
do {
    let fm = FileManager.default
    let stubs: [(String, String)] = [
        ("build/xcframeworks", """
        // swift-tools-version: 5.9
        import PackageDescription
        let package = Package(name: "ReactNative", products: [
            .library(name: "ReactNative", targets: ["ReactNativeStub"]),
            .library(name: "ReactNativeDependencies", targets: ["ReactNativeStub"]),
            .library(name: "hermes-engine", targets: ["ReactNativeStub"]),
        ], targets: [.target(name: "ReactNativeStub", path: "_stub", sources: ["Stub.swift"])])
        """),
        ("build/generated/autolinking", """
        // swift-tools-version: 5.9
        import PackageDescription
        let package = Package(name: "Autolinked", products: [
            .library(name: "Autolinked", targets: ["AutolinkedStub"]),
        ], targets: [.target(name: "AutolinkedStub", path: "_stub", sources: ["Stub.swift"])])
        """),
        ("build/generated/ios", """
        // swift-tools-version: 5.9
        import PackageDescription
        let package = Package(name: "React-GeneratedCode", products: [
            .library(name: "ReactCodegen", targets: ["ReactGeneratedCodeStub"]),
            .library(name: "ReactAppDependencyProvider", targets: ["ReactGeneratedCodeStub"]),
        ], targets: [.target(name: "ReactGeneratedCodeStub", path: "_stub", sources: ["Stub.swift"])])
        """),
    ]
    for (dir, content) in stubs {
        let pkgSwift = packageDir + "/" + dir + "/Package.swift"
        if !fm.fileExists(atPath: pkgSwift) {
            try? fm.createDirectory(atPath: packageDir + "/" + dir + "/_stub", withIntermediateDirectories: true)
            try? content.write(toFile: pkgSwift, atomically: true, encoding: .utf8)
            try? "// Placeholder".write(toFile: packageDir + "/" + dir + "/_stub/Stub.swift", atomically: true, encoding: .utf8)
        }
    }
}

// ZERO-I (Option B + Form 2): React core headers resolve with NO search-path
// flags at all — the React binaryTarget's auto -F serves `<React/...>` and
// `<react/...>` (headers + module map live inside the framework), and the
// ReactNativeHeaders binaryTarget auto-serves every other namespace
// (<jsi/...>, <ReactCommon/...>, <yoga/...>, <folly/...>, ...). The ONLY
// remaining -I is the app's own generated headers (codegen/autolinking).
let appHeaders = packageDir + "/build/xcframeworks/ReactAppHeaders"

let cFlags: [String] = ["-I", appHeaders]
let cxxFlags: [String] = cFlags
let swiftFlags: [String] = []

let package = Package(
    name: "RNTester",
    platforms: [.iOS(.v15)],
    products: [
        .library(name: "RNTesterApp", targets: ["RNTesterApp"]),
        .library(name: "RNTesterAppSwift", targets: ["RNTesterAppSwift"]),
    ],
    dependencies: [
        .package(name: "Autolinked", path: "build/generated/autolinking"),
        .package(name: "React-GeneratedCode", path: "build/generated/ios"),
        .package(name: "ReactNative", path: "build/xcframeworks"),
    ],
    targets: [
        .target(
            name: "RNTesterApp",
            dependencies: [
                .product(name: "ReactNative", package: "ReactNative"),
                .product(name: "ReactNativeHeaders", package: "ReactNative"),
                .product(name: "ReactNativeDependencies", package: "ReactNative"),
                .product(name: "hermes-engine", package: "ReactNative"),
                .product(name: "Autolinked", package: "Autolinked"),
                .product(name: "ReactCodegen", package: "React-GeneratedCode"),
                .product(name: "ReactAppDependencyProvider", package: "React-GeneratedCode"),
            ],
            path: "RNTester",
            exclude: ["SwiftTest.swift", "main.m", "Info.plist", "Images.xcassets", "LaunchScreen.storyboard"],
            publicHeadersPath: ".",
            cSettings: [.unsafeFlags(cFlags)],
            cxxSettings: [.unsafeFlags(cxxFlags)]
        ),
        // Swift sources in a separate target (SPM does not allow mixed-language targets)
        .target(
            name: "RNTesterAppSwift",
            dependencies: ["RNTesterApp"],
            path: "RNTester",
            sources: ["SwiftTest.swift"],
            swiftSettings: [.unsafeFlags(swiftFlags)]
        ),
    ],
    cxxLanguageStandard: .cxx20
)
