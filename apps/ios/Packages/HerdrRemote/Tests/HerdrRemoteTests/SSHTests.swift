import XCTest
import NIOCore
import NIOPosix
import NIOSSH
@testable import HerdrRemote

final class SSHTests: XCTestCase {
    func testPinnedSSHExecSnapshotAndInteractiveControl() async throws {
        let fixture = try await Fixture.start()
        defer { fixture.stop() }
        let client = try await HerdrSSH.connect(fixture.configuration())
        let snapshot = try await client.snapshot()
        XCTAssertEqual(snapshot.panes.map(\.id), ["w1:p1"])
        let stream = try await client.control(pane: "w1:p1", cols: 80, rows: 24)
        var iterator = stream.output.makeAsyncIterator()
        var decoder = HerdrFrameDecoder()
        let initial = try await iterator.next()
        XCTAssertNotNil(initial)
        XCTAssertEqual(try decoder.append(initial!), [Data([0x1b, 0x63, 0x41])])
        try await stream.input(Data([0xff, 0, 0x42]))
        let next = try await iterator.next()
        XCTAssertNotNil(next)
        XCTAssertEqual(try decoder.append(next!), [Data([0xff, 0, 0x42])])
        stream.close()
        await client.close()
    }

    func testUntrustedHostKeyIsRejected() async throws {
        let fixture = try await Fixture.start()
        defer { fixture.stop() }
        let wrongKey = NIOSSHPrivateKey(ed25519Key: .init()).publicKey
        let client = try await HerdrSSH.connect(fixture.configuration(key: wrongKey))
        do {
            _ = try await client.snapshot()
            XCTFail("Untrusted SSH host key was accepted")
        } catch { /* Expected: no snapshot can be read from an untrusted host. */ }
        await client.close()
    }
}

private final class Fixture {
    let group: MultiThreadedEventLoopGroup
    let channel: Channel
    let hostKey: NIOSSHPublicKey
    init(group: MultiThreadedEventLoopGroup, channel: Channel, hostKey: NIOSSHPublicKey) {
        self.group = group; self.channel = channel; self.hostKey = hostKey
    }
    static func start() async throws -> Fixture {
        let group = MultiThreadedEventLoopGroup(numberOfThreads: 1)
        let key = NIOSSHPrivateKey(ed25519Key: .init())
        let server = try await ServerBootstrap(group: group).childChannelInitializer { channel in
            channel.eventLoop.makeCompletedFuture {
                let handler = NIOSSHHandler(role: .server(.init(hostKeys: [key], userAuthDelegate: FixtureAuthentication())),
                    allocator: channel.allocator, inboundChildChannelInitializer: { child, _ in
                        child.pipeline.addHandler(FixtureCommands())
                    })
                try channel.pipeline.syncOperations.addHandler(handler)
            }
        }.bind(host: "127.0.0.1", port: 0).get()
        return Fixture(group: group, channel: server, hostKey: key.publicKey)
    }
    func configuration(key: NIOSSHPublicKey? = nil) throws -> HerdrSSHConfiguration {
        try HerdrSSHConfiguration(host: "127.0.0.1", port: channel.localAddress!.port!, username: "test", password: "test",
            hostPublicKey: String(openSSHPublicKey: key ?? hostKey), session: "default")
    }
    func stop() {
        channel.close(promise: nil)
        group.shutdownGracefully { _ in }
    }
}

private final class FixtureAuthentication: NIOSSHServerUserAuthenticationDelegate {
    var supportedAuthenticationMethods: NIOSSHAvailableUserAuthenticationMethods { .password }
    func requestReceived(request: NIOSSHUserAuthenticationRequest,
                         responsePromise: EventLoopPromise<NIOSSHUserAuthenticationOutcome>) {
        if case .password(let password) = request.request, request.username == "test", password.password == "test" {
            responsePromise.succeed(.success)
        } else { responsePromise.succeed(.failure) }
    }
}

private final class FixtureCommands: ChannelInboundHandler {
    typealias InboundIn = SSHChannelData
    func userInboundEventTriggered(context: ChannelHandlerContext, event: Any) {
        guard let request = event as? SSHChannelRequestEvent.ExecRequest else { return }
        if request.wantReply { context.triggerUserOutboundEvent(ChannelSuccessEvent(), promise: nil) }
        if request.command.hasSuffix("'api' 'snapshot'") {
            let snapshot = #"{"result":{"snapshot":{"workspaces":[],"tabs":[],"panes":[{"pane_id":"w1:p1","tab_id":"w1:t1"}]}}}"#
            write(context, Data(snapshot.utf8))
            context.close(promise: nil)
        } else if request.command.contains("'terminal' 'session' 'control' 'w1:p1'") {
            frame(context, sequence: 1, full: true, bytes: Data([0x41]))
        } else { context.close(promise: nil) }
    }
    func channelRead(context: ChannelHandlerContext, data: NIOAny) {
        guard case .byteBuffer(let buffer) = unwrapInboundIn(data).data,
              let object = try? JSONSerialization.jsonObject(with: Data(buffer.readableBytesView)) as? [String: String],
              object["type"] == "terminal.input", let encoded = object["bytes"],
              let bytes = Data(base64Encoded: encoded) else { return }
        frame(context, sequence: 2, full: false, bytes: bytes)
    }
    func frame(_ context: ChannelHandlerContext, sequence: Int, full: Bool, bytes: Data) {
        var data = try! JSONSerialization.data(withJSONObject: ["type": "terminal.frame", "seq": sequence,
            "full": full, "encoding": "ansi", "bytes": bytes.base64EncodedString()])
        data.append(10)
        write(context, data)
    }
    func write(_ context: ChannelHandlerContext, _ data: Data) {
        context.writeAndFlush(NIOAny(SSHChannelData(type: .channel, data: .byteBuffer(ByteBuffer(bytes: data)))), promise: nil)
    }
}
