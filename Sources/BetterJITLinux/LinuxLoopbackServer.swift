// SPDX-License-Identifier: GPL-3.0-or-later
#if canImport(Network)
import Foundation
import Network

final class LinuxLoopbackServer: @unchecked Sendable {
    struct Response {
        var status: Int
        var type: String
        var body: Data
        var headers: [String:String] = [:]
    }

    private let queue = DispatchQueue(label:"BetterJIT.linux.server")
    private var listener: NWListener?
    private var started: CheckedContinuation<UInt16,Error>?
    private var connections: [UUID:LinuxHTTPConnection] = [:]
    #if canImport(Darwin)
    private var channels: [LinuxNativeChannel] = []
    #endif
    private var stopped = false
    private let token: String
    private let assets: [String:(Data,String)]
    private let backend: LinuxTranslationBackend
    private let fileSystem: LinuxFileSystemSource
    private let onLog: @Sendable (String) -> Void
    private let onExit: @Sendable (Int) -> Void
    private let onWindow: @Sendable ([String:String]) -> Void
    private let onShot: @Sendable (String,Data) -> Void
    private let gpuHandler: LinuxGPUChannelHandler?

    init(token: String,
         assets: [String:(Data,String)],
         backend: LinuxTranslationBackend,
         fileSystem: LinuxFileSystemSource,
         onLog: @escaping @Sendable (String)->Void,
         onExit: @escaping @Sendable (Int)->Void,
         onWindow: @escaping @Sendable ([String:String])->Void = { _ in },
         onShot: @escaping @Sendable (String,Data)->Void = { _,_ in },
         gpuHandler: LinuxGPUChannelHandler? = nil) {
        self.token=token; self.assets=assets; self.backend=backend; self.fileSystem=fileSystem
        self.onLog=onLog; self.onExit=onExit; self.onWindow=onWindow; self.onShot=onShot
        self.gpuHandler=gpuHandler
    }

    func start(timeout: Double) async throws -> UInt16 {
        guard timeout.isFinite, timeout > 0, timeout <= 30 else {
            throw LinuxRuntimeError.invalidConfiguration("Invalid Linux loopback startup timeout.")
        }
        return try await withCheckedThrowingContinuation { continuation in
            queue.async { [self] in
                guard !stopped, listener == nil else { continuation.resume(throwing:LinuxRuntimeError.closed); return }
                started=continuation
                do {
                    let p=NWParameters.tcp
                    p.requiredLocalEndpoint = .hostPort(host:"127.0.0.1",port:.any)
                    p.requiredInterfaceType = .loopback
                    p.allowLocalEndpointReuse = true
                    let l=try NWListener(using:p); listener=l
                    l.stateUpdateHandler = { [weak self,weak l] state in
                        guard let self else { return }
                        switch state {
                        case .ready:
                            guard let port=l?.port?.rawValue else { self.finishStart(.failure(LinuxRuntimeError.server("Linux loopback port unavailable."))); return }
                            self.finishStart(.success(port))
                        case .failed(let error): self.finishStart(.failure(error)); self.stopOnQueue()
                        case .cancelled: self.finishStart(.failure(LinuxRuntimeError.closed))
                        default: break
                        }
                    }
                    l.newConnectionHandler = { [weak self] c in self?.accept(c) }
                    l.start(queue:queue)
                    queue.asyncAfter(deadline:.now()+timeout) { [weak self] in
                        guard let self, self.started != nil else { return }
                        self.finishStart(.failure(LinuxRuntimeError.server("Linux loopback startup timed out."))); self.stopOnQueue()
                    }
                } catch { finishStart(.failure(error)); stopOnQueue() }
            }
        }
    }

    func stop() { queue.async { self.stopOnQueue() } }

    private func finishStart(_ result: Result<UInt16,Error>) {
        let c=started; started=nil; c?.resume(with:result)
    }
    private func stopOnQueue() {
        guard !stopped else { return }; stopped=true
        listener?.stateUpdateHandler=nil; listener?.newConnectionHandler=nil; listener?.cancel(); listener=nil
        let current=Array(connections.values); connections.removeAll()
        for c in current { c.stop() }
        #if canImport(Darwin)
        let activeChannels=channels; channels.removeAll()
        for channel in activeChannels { channel.stop() }
        #endif
        backend.close(); finishStart(.failure(LinuxRuntimeError.closed))
    }
    private func accept(_ connection: NWConnection) {
        guard !stopped, connections.count < 32 else { connection.cancel(); return }
        let id=UUID()
        let c=LinuxHTTPConnection(connection:connection,queue:queue,route:{ [weak self] req in
            guard let self else { return Response(status:503,type:"text/plain",body:Data()) }
            return self.route(req)
        },closed:{ [weak self] in self?.connections.removeValue(forKey:id) })
        connections[id]=c; c.start()
    }

    fileprivate struct Request {
        let method: String
        let target: String
        let path: String
        let query: [String:String]
        let headers: [String:String]
        let body: Data
    }

    private func route(_ req: Request) -> Response {
        do {
            let initial = req.method == "GET" && req.path == "/linux/web/linux.html" && req.query["session"] == token
            if !initial {
                let cookies=req.headers["cookie"] ?? ""
                guard cookies.split(separator:";").map({$0.trimmingCharacters(in:.whitespaces)})
                    .contains("BJSESSION=\(token)") else {
                    return Response(status:403,type:"text/plain",body:Data("forbidden".utf8))
                }
            }
            if initial {
                guard let asset=assets[req.path] else { return Response(status:404,type:"text/plain",body:Data()) }
                return Response(status:200,type:asset.1,body:asset.0,
                                headers:["Set-Cookie":"BJSESSION=\(token); Path=/; SameSite=Strict"])
            }
            if let asset=assets[req.path], req.method == "GET" {
                return Response(status:200,type:asset.1,body:asset.0)
            }
            func space() throws -> UInt32 {
                guard let text=req.query["space"], let n=UInt32(text) else { throw LinuxRuntimeError.guest("Invalid Linux translation space.") }
                return n
            }
            switch (req.method,req.path) {
            case ("GET","/xlat/config"):
                return Response(status:200,type:"application/json",body:try backend.configuration(space:space()))
            case ("GET","/xlat/dispatcher"):
                return Response(status:200,type:"application/wasm",body:try backend.dispatcher(space:space()))
            case ("GET","/xlat/state"):
                return Response(status:200,type:"application/octet-stream",body:try backend.initialState(space:space()))
            case ("GET","/xlat/unit"):
                guard let rip=UInt32(req.query["rip"] ?? "") else { throw LinuxRuntimeError.guest("Invalid FEX RIP.") }
                return Response(status:200,type:"application/wasm",body:try backend.unit(space:space(),rip:rip))
            case ("POST","/xlat/region"):
                return Response(status:200,type:"application/wasm",body:try backend.region(space:space(),profile:req.body))
            case ("POST","/xlat/code"):
                guard let addr=UInt64(req.query["addr"] ?? "",radix:16) else { throw LinuxRuntimeError.guest("Invalid mapped-code address.") }
                let abi=UInt32(req.query["abi"] ?? "") ?? 0
                try backend.mapCode(space:space(),address:addr,bytes:req.body,abi:abi)
                return Response(status:200,type:"application/octet-stream",body:Data())
            case ("POST","/xlat/patch"):
                guard let addr=UInt64(req.query["addr"] ?? "",radix:16) else { throw LinuxRuntimeError.guest("Invalid code-patch address.") }
                try backend.patchCode(space:space(),address:addr,bytes:req.body)
                return Response(status:200,type:"application/octet-stream",body:Data())
            case ("GET","/xlat/uncode"):
                guard let addr=UInt64(req.query["addr"] ?? "",radix:16),
                      let size=UInt64(req.query["size"] ?? "",radix:16) else { throw LinuxRuntimeError.guest("Invalid unmap range.") }
                try backend.unmapCode(space:space(),address:addr,size:size)
                return Response(status:200,type:"application/octet-stream",body:Data())
            case ("GET","/xlat/drop"):
                backend.drop(space:try space()); return Response(status:200,type:"application/octet-stream",body:Data())
            case ("GET","/fs/index"):
                return Response(status:200,type:"application/json",body:try fileSystem.indexJSON())
            case ("GET","/fs/file"):
                let path=req.query["p"] ?? ""
                let off=req.query["off"].flatMap(Int.init), len=req.query["len"].flatMap(Int.init)
                return Response(status:200,type:"application/octet-stream",body:try fileSystem.readFile(path:path,offset:off,length:len))
            case ("POST","/log"):
                let log=String(decoding:req.body,as:UTF8.self); onLog(log)
                for line in log.split(separator:"\n") where line.hasPrefix("[page] exit ") {
                    if let code=Int(line.dropFirst(12).split(separator:" ").first ?? "") { onExit(code) }
                }
                return Response(status:200,type:"text/plain",body:Data())
            case ("GET","/win"):
                onWindow(req.query); return Response(status:200,type:"text/plain",body:Data())
            case ("POST","/shot"):
                onShot(req.query["name"] ?? "shot",req.body); return Response(status:200,type:"text/plain",body:Data())
            case ("GET","/chan/attach"):
                #if canImport(Darwin)
                guard let kind=req.query["kind"], let magic=req.query["magic"] else {
                    return Response(status:400,type:"text/plain",body:Data("missing channel metadata".utf8))
                }
                try attachChannel(kind:kind,magic:magic)
                return Response(status:200,type:"text/plain",body:Data("ok".utf8))
                #else
                return Response(status:501,type:"text/plain",body:Data("native OPFS channels require Darwin".utf8))
                #endif
            default:
                return Response(status:404,type:"text/plain",body:Data("not found".utf8))
            }
        } catch {
            return Response(status:500,type:"text/plain",body:Data("linux runtime request failed".utf8))
        }
    }
    #if canImport(Darwin)
    private func attachChannel(kind:String,magic:String)throws {
        let path=try LinuxNativeChannel.discover(magic:magic)
        let channel=try LinuxNativeChannel(path:path,magic:magic) { [weak self] request,capacity in
            guard let self else { return LinuxChannelReply(result:-5) }
            return try self.channel(kind:kind,request:request,capacity:capacity)
        }
        channels.append(channel)
        channel.start()
    }

    private func channel(kind:String,request:Data,capacity:Int)throws->LinuxChannelReply {
        if kind=="gpu" {
            return try gpuHandler?(request,capacity) ?? LinuxChannelReply(result:-38)
        }
        guard request.count >= 32 else { return LinuxChannelReply(result:-22) }
        let bytes=[UInt8](request)
        func u32(_ at:Int)->UInt32 {
            UInt32(bytes[at]) | UInt32(bytes[at+1])<<8 | UInt32(bytes[at+2])<<16 | UInt32(bytes[at+3])<<24
        }
        func u64(_ at:Int)->UInt64 {
            (0..<8).reduce(UInt64(0)) { partial,index in
                partial | UInt64(bytes[at+index]) << UInt64(8*index)
            }
        }
        let op=u32(0),rawSpace=u32(4),a=u64(8),b=u64(16),c=u64(24)
        let space=rawSpace & 0x00ff_ffff
        let abi=rawSpace >> 24
        switch kind {
        case "xlat":
            switch op {
            case 1:
                guard a <= UInt64(UInt32.max) else { return LinuxChannelReply(result:-22) }
                let data=try backend.unit(space:space,rip:UInt32(a))
                guard data.count <= capacity else { return LinuxChannelReply(result:-7) }
                return LinuxChannelReply(result:Int32(data.count),data:data)
            case 6:
                let body=request.subdata(in:32..<request.count)
                try backend.patchCode(space:space,address:a,bytes:body)
                return LinuxChannelReply(result:0)
            default:
                return LinuxChannelReply(result:-38)
            }
        case "kern":
            switch op {
            case 2:
                let body=request.subdata(in:32..<request.count)
                guard a <= UInt64.max-c else { return LinuxChannelReply(result:-22) }
                try backend.mapCode(space:space,address:a+c,bytes:body,abi:abi)
                return LinuxChannelReply(result:0)
            case 3:
                let path=String(decoding:bytes[32...],as:UTF8.self)
                let total=try fileSystem.fileSize(path:path)
                let off=Int(min(a,UInt64(Int.max)))
                let maxPayload=max(0,capacity-8)
                let wanted=b==0 ? maxPayload : min(Int(min(b,UInt64(Int.max))),maxPayload)
                let data=try fileSystem.readFile(path:path,offset:off,length:wanted)
                var out=Data()
                var totalLE=UInt64(total).littleEndian
                withUnsafeBytes(of:&totalLE) { out.append(contentsOf:$0) }
                out.append(data)
                return LinuxChannelReply(result:Int32(out.count),data:out)
            case 4:
                try backend.unmapCode(space:space,address:a,size:b)
                return LinuxChannelReply(result:0)
            case 5:
                backend.drop(space:space)
                return LinuxChannelReply(result:0)
            default:
                return LinuxChannelReply(result:-38)
            }
        default:
            return try gpuHandler?(request,capacity) ?? LinuxChannelReply(result:-38)
        }
    }
    #endif
}

private final class LinuxHTTPConnection {
    private let connection: NWConnection
    private let queue: DispatchQueue
    private let route: (LinuxLoopbackServer.Request)->LinuxLoopbackServer.Response
    private let closed: ()->Void
    private var buffer=Data()
    private var finished=false
    private let maxHeader=16*1024, maxBody=32*1024*1024

    init(connection:NWConnection,queue:DispatchQueue,
         route:@escaping (LinuxLoopbackServer.Request)->LinuxLoopbackServer.Response,
         closed:@escaping ()->Void) {
        self.connection=connection; self.queue=queue; self.route=route; self.closed=closed
    }
    func start() { connection.start(queue:queue); receive() }
    func stop() { guard !finished else { return }; finished=true; connection.cancel(); closed() }
    private func receive() {
        connection.receive(minimumIncompleteLength:1,maximumLength:1<<20) { [weak self] data,_,complete,error in
            guard let self,!self.finished else { return }
            if let data { self.buffer.append(data) }
            if error != nil { self.stop(); return }
            self.process()
            if complete { self.stop() } else if !self.finished { self.receive() }
        }
    }
    private func process() {
        let sep=Data("\r\n\r\n".utf8)
        while let range=buffer.range(of:sep) {
            guard range.lowerBound <= maxHeader else { stop(); return }
            let head=String(decoding:buffer[..<range.lowerBound],as:UTF8.self)
            let lines=head.components(separatedBy:"\r\n")
            guard let first=lines.first else { stop(); return }
            let parts=first.split(separator:" ",maxSplits:2).map(String.init)
            guard parts.count >= 2 else { stop(); return }
            var headers:[String:String]=[:], length=0
            for line in lines.dropFirst() {
                let kv=line.split(separator:":",maxSplits:1)
                guard kv.count==2 else { continue }
                let key=kv[0].trimmingCharacters(in:.whitespaces).lowercased()
                let value=kv[1].trimmingCharacters(in:.whitespaces)
                headers[key]=value
                if key=="content-length" { length=Int(value) ?? -1 }
            }
            guard length >= 0, length <= maxBody else { stop(); return }
            let bodyStart=range.upperBound
            guard buffer.count-bodyStart >= length else { return }
            let body=buffer.subdata(in:bodyStart..<(bodyStart+length))
            buffer.removeSubrange(0..<(bodyStart+length))
            guard let comps=URLComponents(string:parts[1]) else { stop(); return }
            var query:[String:String]=[:]; comps.queryItems?.forEach { query[$0.name]=$0.value ?? "" }
            let request=LinuxLoopbackServer.Request(method:parts[0],target:parts[1],path:comps.path,
                                                    query:query,headers:headers,body:body)
            send(route(request))
            return // serialize responses; continue receiving after send completes
        }
        if buffer.count > maxHeader+maxBody { stop() }
    }
    private func send(_ response: LinuxLoopbackServer.Response) {
        let reason=response.status==200 ? "OK" : response.status==403 ? "Forbidden" : response.status==404 ? "Not Found" : response.status==501 ? "Not Implemented" : "Error"
        var header="HTTP/1.1 \(response.status) \(reason)\r\nContent-Type: \(response.type)\r\nContent-Length: \(response.body.count)\r\nConnection: keep-alive\r\nCache-Control: no-store\r\nX-Content-Type-Options: nosniff\r\nCross-Origin-Opener-Policy: same-origin\r\nCross-Origin-Embedder-Policy: require-corp\r\nCross-Origin-Resource-Policy: same-origin\r\nContent-Security-Policy: default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self'; connect-src 'self'; style-src 'unsafe-inline'; img-src 'self' data: blob:; base-uri 'none'; form-action 'none'\r\n"
        for (k,v) in response.headers { header += "\(k): \(v)\r\n" }
        header += "\r\n"
        var out=Data(header.utf8); out.append(response.body)
        connection.send(content:out,completion:.contentProcessed { [weak self] error in
            guard let self else { return }
            if error != nil { self.stop(); return }
            self.process()
        })
    }
}
#endif
