import Foundation

public enum ProbeProfile {
    /// The user installs this removable profile through Settings. The app does not
    /// call NEVPNManager or request either Personal VPN or Network Extension entitlements.
    public static func make(address: LoopbackAddress) throws -> Data {
        let vpn: [String: Any] = [
            "PayloadType": "com.apple.vpn.managed",
            "PayloadVersion": 1,
            "PayloadIdentifier": "io.github.intraducine.betterjit.probe.vpn",
            "PayloadUUID": "BDF909C1-2C73-4FAA-B240-6974B0888B73",
            "PayloadDisplayName": "BetterJIT Loopback Probe",
            "UserDefinedName": "BetterJIT Probe (\(address.rawValue))",
            "VPNType": "IKEv2",
            "IPv4": ["OverridePrimary": 0],
            "IKEv2": [
                "RemoteAddress": address.rawValue,
                "RemoteIdentifier": "betterjit-probe.invalid",
                "LocalIdentifier": "betterjit-client.invalid",
                "AuthenticationMethod": "SharedSecret",
                "SharedSecret": randomBytes(count: 32).base64EncodedString(),
                "ExtendedAuthEnabled": 0,
                "OnDemandEnabled": 0,
                "IncludeAllNetworks": 0,
                "EnforceRoutes": 0,
                "EnableFallback": 0,
                "DisableMOBIKE": 1,
                "DisableRedirect": 1,
                "DeadPeerDetectionRate": "None"
            ] as [String: Any]
        ]
        let profile: [String: Any] = [
            "PayloadType": "Configuration",
            "PayloadVersion": 1,
            "PayloadIdentifier": "io.github.intraducine.betterjit.probe.profile",
            "PayloadUUID": "1821771B-A022-41D6-BD1F-D474E8C55B90",
            "PayloadDisplayName": "BetterJIT Loopback Probe",
            "PayloadDescription": "Localhost reachability experiment only. Does not enable JIT. The test VPN intentionally fails negotiation. Remove after testing.",
            "PayloadRemovalDisallowed": false,
            "PayloadContent": [vpn]
        ]
        return try PropertyListSerialization.data(fromPropertyList: profile, format: .xml, options: 0)
    }
}
