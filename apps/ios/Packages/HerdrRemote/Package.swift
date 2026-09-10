// swift-tools-version:6.1
import PackageDescription

let package = Package(
    name: "HerdrRemote",
    platforms: [.iOS(.v17), .macOS(.v13)],
    products: [.library(name: "HerdrRemote", targets: ["HerdrRemote"])],
    dependencies: [
        .package(url: "https://github.com/apple/swift-nio-ssh.git", exact: "0.15.0"),
        .package(url: "https://github.com/apple/swift-nio.git", exact: "2.102.0")
    ],
    targets: [
        .target(name: "HerdrRemote", dependencies: [
            .product(name: "NIOSSH", package: "swift-nio-ssh"),
            .product(name: "NIOCore", package: "swift-nio"),
            .product(name: "NIOPosix", package: "swift-nio")
        ]),
        .testTarget(name: "HerdrRemoteTests", dependencies: ["HerdrRemote"])
    ],
    swiftLanguageModes: [.v5]
)
