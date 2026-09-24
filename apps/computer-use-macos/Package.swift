// swift-tools-version: 5.9
import PackageDescription
let package = Package(
    name: "EvoWorkComputerUse",
    platforms: [.macOS("14.4")],
    products: [.executable(name: "EvoWorkComputerUse", targets: ["EvoWorkComputerUse"])],
    targets: [
        .target(name: "EvoWorkComputerUsePolicy"),
        .executableTarget(name: "EvoWorkComputerUse", dependencies: ["EvoWorkComputerUsePolicy"], linkerSettings: [
            .linkedFramework("AppKit"), .linkedFramework("ApplicationServices"),
            .linkedFramework("ScreenCaptureKit"), .linkedFramework("Security")
        ]),
        .executableTarget(name: "EvoWorkComputerUsePolicyTests", dependencies: ["EvoWorkComputerUsePolicy"])
    ]
)
