import XCTest
@testable import HerdrRemote

final class ProtocolTests: XCTestCase {
    private func frame(_ sequence: Int, full: Bool = false, bytes: Data = Data([0xff, 0, 0x1b])) -> Data {
        var data = try! JSONSerialization.data(withJSONObject: ["type": "terminal.frame", "seq": sequence,
            "full": full, "encoding": "ansi", "bytes": bytes.base64EncodedString()])
        data.append(10)
        return data
    }
    func testFragmentedBinarySafeCheckpointAndDiff() throws {
        var decoder = HerdrFrameDecoder()
        let initial = frame(1, full: true)
        XCTAssertEqual(try decoder.append(initial.prefix(10)), [])
        XCTAssertEqual(try decoder.append(initial.dropFirst(10)), [Data([0x1b, 0x63, 0xff, 0, 0x1b])])
        XCTAssertEqual(try decoder.append(frame(2)), [Data([0xff, 0, 0x1b])])
    }
    func testMissingCheckpointAndSequenceGapsFail() throws {
        var decoder = HerdrFrameDecoder()
        XCTAssertThrowsError(try decoder.append(frame(1)))
        _ = try decoder.append(frame(5, full: true))
        XCTAssertThrowsError(try decoder.append(frame(7)))
        _ = try decoder.append(frame(20, full: true))
        XCTAssertThrowsError(try decoder.append(frame(20)))
    }
    func testMemoryCap() {
        var decoder = HerdrFrameDecoder()
        XCTAssertThrowsError(try decoder.append(Data(repeating: 65, count: 2 * 1024 * 1024 + 1)))
    }
    func testFinalFrameIsDeliveredBeforeCloseInSameChunk() throws {
        var decoder = HerdrFrameDecoder()
        let data = frame(1, full: true) + Data("{\"type\":\"terminal.closed\"}\n".utf8)
        XCTAssertEqual(try decoder.append(data), [Data([0x1b, 0x63, 0xff, 0, 0x1b])])
        XCTAssertTrue(decoder.closed)
        XCTAssertThrowsError(try decoder.append(frame(2)))
    }
    func testCommandValuesAreQuoted() throws {
        let config = try HerdrSSHConfiguration(host: "example.com", port: 22, username: "me", password: "pass",
            hostPublicKey: "public", session: "work'; echo unsafe", executable: "/opt/homebrew/bin/herdr")
        XCTAssertEqual(config.snapshotCommand, "'/opt/homebrew/bin/herdr' '--session' 'work'\\''; echo unsafe' 'api' 'snapshot'")
        XCTAssertFalse(config.controlCommand(pane: "w1:p1", cols: 80, rows: 24).contains("--takeover"))
    }
    func testInvalidConfiguration() {
        XCTAssertThrowsError(try HerdrSSHConfiguration(host: "", port: 0, username: "", password: "",
            hostPublicKey: "", session: "default"))
    }
}
