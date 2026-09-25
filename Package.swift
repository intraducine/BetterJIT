// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "BetterJIT",
    platforms: [.iOS(.v17), .macOS(.v13)],
    products: [
        .library(name: "BetterJITCore", targets: ["BetterJITCore"]),
        .executable(name: "betterjit-probe", targets: ["BetterJITCLI"])
    ],
    targets: [
        .target(name: "BetterJITCore"),
        .executableTarget(name: "BetterJITCLI", dependencies: ["BetterJITCore"]),
        .testTarget(name: "BetterJITCoreTests", dependencies: ["BetterJITCore"])
    ]
)
