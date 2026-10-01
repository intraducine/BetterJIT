// swift-tools-version: 5.9
import PackageDescription
let package = Package(name: "NativeServiceHost", dependencies: [.package(name: "BetterJIT", path: "../../..")],
    targets: [.executableTarget(name: "NativeServiceHost", dependencies: [.product(name: "BetterJIT", package: "BetterJIT")])])
