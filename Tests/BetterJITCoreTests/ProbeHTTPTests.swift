import XCTest
@testable import BetterJITCore

final class ProbeHTTPTests: XCTestCase {
    func testFragmentedAndPipelinedRequests() throws {
        var data = Data("POST /xlat/region HTTP/1.1\r\nContent-Length: 4\r\n\r\nab".utf8)
        XCTAssertNil(try ProbeHTTP.pop(&data))
        data.append(Data("cdGET /index.html HTTP/1.1\r\n\r\n".utf8))
        let first = try XCTUnwrap(ProbeHTTP.pop(&data))
        XCTAssertEqual(first.method, "POST")
        XCTAssertEqual(first.body, Data("abcd".utf8))
        XCTAssertEqual(try ProbeHTTP.pop(&data)?.target, "/index.html")
        XCTAssertTrue(data.isEmpty)
    }
    func testBadFramingRejectedWithoutMutatingBuffer() {
        for headers in ["Content-Length: -1", "Content-Length: +1", "Content-Length: abc",
            "Content-Length: 999999999999999999999999", "Content-Length: 1\r\nContent-Length: 1",
            "Transfer-Encoding: chunked", "Content-Length: 4\r\nTransfer-Encoding: chunked",
            "Content-Length : 4", "malformed", "Content-Length: 1, 1"] {
            var data = Data("POST / HTTP/1.1\r\n\(headers)\r\n\r\nbody".utf8)
            let original = data
            XCTAssertThrowsError(try ProbeHTTP.pop(&data), headers)
            XCTAssertEqual(data, original)
        }
    }
    func testLimitsApplyBeforeBodyAllocation() {
        var largeBody = Data("POST / HTTP/1.1\r\nContent-Length: 65\r\n\r\n".utf8)
        XCTAssertThrowsError(try ProbeHTTP.pop(&largeBody, maxBody: 64)) {
            XCTAssertEqual(($0 as? ProbeHTTP.Failure)?.status, 413)
        }
        var largeHeader = Data(repeating: 65, count: 65)
        XCTAssertThrowsError(try ProbeHTTP.pop(&largeHeader, maxHeader: 64)) {
            XCTAssertEqual(($0 as? ProbeHTTP.Failure)?.status, 431)
        }
    }
    func testBadRequestLines() {
        for line in ["GET", "GET //other/path HTTP/1.1", "GET http://other/ HTTP/1.1",
                     "GET / HTTP/9.0", "GET  / HTTP/1.1"] {
            var data = Data("\(line)\r\n\r\n".utf8)
            XCTAssertThrowsError(try ProbeHTTP.pop(&data))
        }
    }
    func testEmptyBodyAndBinaryBody() throws {
        var empty = Data("GET / HTTP/1.1\r\nHost: localhost\r\n\r\n".utf8)
        XCTAssertEqual(try ProbeHTTP.pop(&empty)?.body, Data())
        var binary = Data("POST / HTTP/1.1\r\nContent-Length: 3\r\n\r\n".utf8)
        binary.append(contentsOf: [0, 255, 128])
        XCTAssertEqual(try ProbeHTTP.pop(&binary)?.body, Data([0, 255, 128]))
    }
    func testPathsCannotEscapeRootIncludingSymlinks() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }
        try FileManager.default.createSymbolicLink(at: root.appendingPathComponent("escape"),
                                                  withDestinationURL: root.deletingLastPathComponent())
        XCTAssertNotNil(ProbeHTTP.file("fex/config.json", beneath: root))
        for path in ["../outside", "/absolute", "fex/../../outside", "escape/outside", "bad\0name"] {
            XCTAssertNil(ProbeHTTP.file(path, beneath: root), path)
        }
    }
}
