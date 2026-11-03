// swift-tools-version: 6.2
import PackageDescription

let package = Package(
    name: "QuickenSpeech",
    platforms: [.macOS(.v14)],
    dependencies: [
        .package(path: "../.deps/FluidAudio")
    ],
    targets: [.executableTarget(name: "quicken-speech", dependencies: [.product(name: "FluidAudio", package: "FluidAudio")])]
)
