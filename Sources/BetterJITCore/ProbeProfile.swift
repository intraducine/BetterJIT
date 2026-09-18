import Foundation

public enum ProbeProfile {
    /// Retains the original CLI/profile API for loopback regression tests.
    public static func make(address: LoopbackAddress) throws -> Data {
        try encode(host: address.rawValue, name: "BetterJIT Probe (\(address.rawValue))", interfaceExperiment: false)
    }

    public static func make(target: InterfaceTarget) throws -> Data {
        guard target.isPresent(in: try LocalInterfaces.snapshot()) else {
            throw ProfileError.unavailable
        }
        return try encode(host: target.address, name: target.vpnName, interfaceExperiment: true)
    }

    private static func encode(host: String, name: String, interfaceExperiment: Bool) throws -> Data {
        let prefix = interfaceExperiment ? "io.github.intraducine.betterjit.interfaceprobe" : "io.github.intraducine.betterjit.probe"
        let display = interfaceExperiment ? "BetterJIT Interface Probe" : "BetterJIT Loopback Probe"
        let vpn: [String: Any] = [
            "PayloadType": "com.apple.vpn.managed", "PayloadVersion": 1,
            "PayloadIdentifier": prefix + ".vpn",
            "PayloadUUID": interfaceExperiment ? "98421448-AB4E-405C-9EEA-8216BCF30686" : "BDF909C1-2C73-4FAA-B240-6974B0888B73",
            "PayloadDisplayName": display, "UserDefinedName": name, "VPNType": "IKEv2",
            "IPv4": ["OverridePrimary": 0],
            "IKEv2": [
                "RemoteAddress": host, "RemoteIdentifier": "betterjit-probe.invalid",
                "LocalIdentifier": "betterjit-client.invalid", "AuthenticationMethod": "SharedSecret",
                "SharedSecret": randomBytes(count: 32).base64EncodedString(), "ExtendedAuthEnabled": 0,
                "OnDemandEnabled": 0, "IncludeAllNetworks": 0, "EnforceRoutes": 0,
                "EnableFallback": 0, "DisableMOBIKE": 1, "DisableRedirect": 1,
                "DeadPeerDetectionRate": "None"
            ] as [String: Any]
        ]
        let profile: [String: Any] = [
            "PayloadType": "Configuration", "PayloadVersion": 1,
            "PayloadIdentifier": prefix + ".profile",
            "PayloadUUID": interfaceExperiment ? "2B85C712-E124-4668-9785-D7012BDB3C5E" : "1821771B-A022-41D6-BD1F-D474E8C55B90",
            "PayloadDisplayName": display,
            "PayloadDescription": "COOKIE transport experiment only. Does not enable JIT or establish a VPN. RemoteAddress is the selected device address; no native interface override. Remove after testing.",
            "PayloadRemovalDisallowed": false, "PayloadContent": [vpn]
        ]
        return try PropertyListSerialization.data(fromPropertyList: profile, format: .xml, options: 0)
    }
    private enum ProfileError: Error, LocalizedError {
        case unavailable
        var errorDescription: String? { "Selected interface address is unavailable. Refresh addresses and generate a matching profile." }
    }
}
