// swift-tools-version: 5.9
import PackageDescription
let package = Package(name: "BetterJIT", platforms: [.iOS(.v17), .macOS(.v13)],
    products: [.library(name: "BetterJIT", targets: ["BetterJIT"]),
               .library(name: "BetterJITWebKit", targets: ["BetterJITWebKit"]),
               .library(name: "BetterJITFEX", targets: ["BetterJITFEX"])],
    targets: [.target(name: "BetterJIT"),
              .target(name: "BetterJITWebKit", dependencies: ["BetterJIT"], resources: [.copy("Resources")]),
              .target(name: "BetterJITFEX", dependencies: ["BetterJIT"]),
              .testTarget(name: "BetterJITTests", dependencies: ["BetterJIT"]),
              .testTarget(name: "BetterJITFEXTests", dependencies: ["BetterJITFEX"]),
              .testTarget(name: "BetterJITWebKitTests", dependencies: ["BetterJIT", "BetterJITWebKit"])])
