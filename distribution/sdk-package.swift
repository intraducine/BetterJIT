// swift-tools-version: 5.9
import PackageDescription
let package = Package(name: "BetterJIT", platforms: [.iOS(.v17), .macOS(.v13)],
    products: [.library(name: "BetterJIT", targets: ["BetterJIT"]),
               .library(name: "BetterJITWebKit", targets: ["BetterJITWebKit"]),
               .library(name: "BetterJITFEX", targets: ["BetterJITFEX"]),
               .library(name: "BetterJITLinux", targets: ["BetterJITLinux"])],
    targets: [.target(name: "BetterJIT"),
              .target(name: "BetterJITWebKit", dependencies: ["BetterJIT"], resources: [.copy("Resources")]),
              .target(name: "BetterJITFEX", dependencies: ["BetterJIT"]),
              .target(name: "BetterJITLinux", dependencies: ["BetterJIT"], resources: [.copy("Resources")]),
              .testTarget(name: "BetterJITTests", dependencies: ["BetterJIT"], path: "SwiftTests/BetterJITTests"),
              .testTarget(name: "BetterJITFEXTests", dependencies: ["BetterJITFEX"], path: "SwiftTests/BetterJITFEXTests"),
              .testTarget(name: "BetterJITWebKitTests", dependencies: ["BetterJIT", "BetterJITWebKit"], path: "SwiftTests/BetterJITWebKitTests"),
              .testTarget(name: "BetterJITLinuxTests", dependencies: ["BetterJITLinux"], path: "SwiftTests/BetterJITLinuxTests")])
