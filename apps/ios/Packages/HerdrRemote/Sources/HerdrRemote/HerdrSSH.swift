import Foundation
import NIOCore
import NIOPosix
import NIOSSH

public final class HerdrSSH: @unchecked Sendable {
    private static let group = MultiThreadedEventLoopGroup(numberOfThreads: 1)
    private let channel: Channel
    private let configuration: HerdrSSHConfiguration

    private init(channel: Channel, configuration: HerdrSSHConfiguration) {
        self.channel = channel
        self.configuration = configuration
    }

    public static func connect(_ configuration: HerdrSSHConfiguration) async throws -> HerdrSSH {
        let expected = try NIOSSHPublicKey(openSSHPublicKey: configuration.hostPublicKey)
        let channel = try await ClientBootstrap(group: group)
            .connectTimeout(.seconds(15))
            .channelInitializer { channel in
                channel.eventLoop.makeCompletedFuture {
                    let handler = NIOSSHHandler(role: .client(.init(
                        userAuthDelegate: PasswordAuthentication(configuration),
                        serverAuthDelegate: PinnedHostKey(expected)
                    )), allocator: channel.allocator, inboundChildChannelInitializer: nil)
                    try channel.pipeline.syncOperations.addHandler(handler)
                    try channel.pipeline.syncOperations.addHandler(CloseOnError())
                }
            }
            .connect(host: configuration.host, port: configuration.port).get()
        return HerdrSSH(channel: channel, configuration: configuration)
    }

    public func close() async { try? await channel.close().get() }

    public func snapshot() async throws -> HerdrSnapshot {
        let stream = try await open(configuration.snapshotCommand)
        let timeout = channel.eventLoop.scheduleTask(in: .seconds(20)) { stream.close() }
        defer { timeout.cancel(); stream.close() }
        var data = Data()
        for try await bytes in stream.output {
            try Task.checkCancellation()
            guard data.count + bytes.count <= 4 * 1024 * 1024 else { throw HerdrRemoteError.oversized }
            data.append(bytes)
        }
        return try HerdrSnapshot.decode(data)
    }

    public func control(pane: String, cols: Int, rows: Int) async throws -> HerdrTerminalStream {
        // Revalidate the selected native pane against this host's current inventory.
        guard !pane.contains("\0"), pane.utf8.count <= 256 else { throw HerdrRemoteError.invalidConfiguration }
        let inventory = try await snapshot()
        guard inventory.panes.contains(where: { $0.id == pane }) else { throw HerdrRemoteError.commandFailed }
        return try await open(configuration.controlCommand(pane: pane,
            cols: min(500, max(2, cols)), rows: min(300, max(2, rows))))
    }

    private func open(_ command: String) async throws -> HerdrTerminalStream {
        let pair = AsyncThrowingStream<Data, Error>.makeStream(bufferingPolicy: .bufferingOldest(32))
        let timeout = channel.eventLoop.scheduleTask(in: .seconds(20)) { [channel] in
            channel.close(promise: nil)
        }
        defer { timeout.cancel() }
        let child: Channel = try await channel.pipeline.handler(type: NIOSSHHandler.self).flatMap { handler in
            let promise = self.channel.eventLoop.makePromise(of: Channel.self)
            handler.createChannel(promise) { child, type in
                guard type == .session else { return child.eventLoop.makeFailedFuture(HerdrRemoteError.commandFailed) }
                return child.pipeline.addHandler(BoundedOutput(command: command, output: pair.continuation))
            }
            return promise.futureResult
        }.get()
        pair.continuation.onTermination = { _ in child.close(promise: nil) }
        return HerdrTerminalStream(channel: child, output: pair.stream)
    }
}

public final class HerdrTerminalStream: @unchecked Sendable {
    private let channel: Channel
    public let output: AsyncThrowingStream<Data, Error>
    fileprivate init(channel: Channel, output: AsyncThrowingStream<Data, Error>) {
        self.channel = channel; self.output = output
    }
    public func close() { channel.close(promise: nil) }
    public func input(_ data: Data) async throws {
        guard data.count <= 32 * 1024 else { throw HerdrRemoteError.oversized }
        try await write(["type": "terminal.input", "bytes": data.base64EncodedString()])
    }
    public func resize(cols: Int, rows: Int) async throws {
        try await write(["type": "terminal.resize", "cols": min(500, max(2, cols)), "rows": min(300, max(2, rows))])
    }
    private func write(_ object: [String: Any]) async throws {
        var data = try JSONSerialization.data(withJSONObject: object)
        data.append(10)
        let buffer = ByteBuffer(bytes: data)
        try await channel.writeAndFlush(SSHChannelData(type: .channel, data: .byteBuffer(buffer))).get()
    }
}

private final class PasswordAuthentication: NIOSSHClientUserAuthenticationDelegate {
    private let configuration: HerdrSSHConfiguration
    private var attempted = false // NIOSSH invokes authentication on its single event loop.
    init(_ configuration: HerdrSSHConfiguration) { self.configuration = configuration }
    func nextAuthenticationType(availableMethods: NIOSSHAvailableUserAuthenticationMethods,
                                nextChallengePromise: EventLoopPromise<NIOSSHUserAuthenticationOffer?>) {
        guard !attempted, availableMethods.contains(.password) else {
            nextChallengePromise.fail(HerdrRemoteError.authentication)
            return
        }
        attempted = true
        nextChallengePromise.succeed(.init(username: configuration.username, serviceName: "",
            offer: .password(.init(password: configuration.password))))
    }
}

private final class PinnedHostKey: NIOSSHClientServerAuthenticationDelegate {
    private let expected: NIOSSHPublicKey
    init(_ expected: NIOSSHPublicKey) { self.expected = expected }
    func validateHostKey(hostKey: NIOSSHPublicKey, validationCompletePromise: EventLoopPromise<Void>) {
        if hostKey == expected { validationCompletePromise.succeed(()) }
        else { validationCompletePromise.fail(HerdrRemoteError.hostKeyMismatch) }
    }
}

private final class CloseOnError: ChannelInboundHandler {
    typealias InboundIn = Any
    func errorCaught(context: ChannelHandlerContext, error: Error) { context.close(promise: nil) }
}

private final class BoundedOutput: ChannelInboundHandler {
    typealias InboundIn = SSHChannelData
    private let command: String
    private let output: AsyncThrowingStream<Data, Error>.Continuation
    init(command: String, output: AsyncThrowingStream<Data, Error>.Continuation) {
        self.command = command; self.output = output
    }
    func channelActive(context: ChannelHandlerContext) {
        context.triggerUserOutboundEvent(SSHChannelRequestEvent.ExecRequest(command: command, wantReply: true), promise: nil)
    }
    func channelRead(context: ChannelHandlerContext, data: NIOAny) {
        let message = unwrapInboundIn(data)
        guard message.type == .channel else { return } // Never log or retain stderr/terminal bytes.
        guard case .byteBuffer(let buffer) = message.data, buffer.readableBytes <= 64 * 1024 else {
            fail(context, HerdrRemoteError.oversized); return
        }
        switch output.yield(Data(buffer.readableBytesView)) {
        case .dropped:
            // At most 2 MiB are queued. A slow consumer forces a new checkpoint.
            fail(context, HerdrRemoteError.oversized)
        case .terminated: context.close(promise: nil)
        case .enqueued: break
        @unknown default: fail(context, HerdrRemoteError.disconnected)
        }
    }
    func userInboundEventTriggered(context: ChannelHandlerContext, event: Any) {
        if event is ChannelFailureEvent { fail(context, HerdrRemoteError.commandFailed) }
        if let status = event as? SSHChannelRequestEvent.ExitStatus, status.exitStatus != 0 {
            fail(context, HerdrRemoteError.commandFailed)
        }
    }
    func channelInactive(context: ChannelHandlerContext) { output.finish() }
    func errorCaught(context: ChannelHandlerContext, error: Error) { fail(context, error) }
    private func fail(_ context: ChannelHandlerContext, _ error: Error) {
        output.finish(throwing: error)
        context.close(promise: nil)
    }
}
