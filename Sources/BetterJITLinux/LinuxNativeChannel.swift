// SPDX-License-Identifier: GPL-3.0-or-later
#if canImport(Darwin)
import Foundation
import Darwin

final class LinuxNativeChannel: @unchecked Sendable {
    static let requestMaximum=32*1024*1024
    static let responseMaximum=32*1024*1024
    static let fileSize=4096+requestMaximum+responseMaximum

    private let fd:Int32
    private let base:UnsafeMutableRawPointer
    private let handler:(Data,Int)throws->LinuxChannelReply
    private let work=DispatchQueue(label:"BetterJIT.linux.channel",qos:.userInteractive)
    private let lock=NSLock()
    private let done=DispatchSemaphore(value:0)
    private var stopping=false
    private var cleaned=false

    init(path:String,magic:String,handler:@escaping (Data,Int)throws->LinuxChannelReply) throws {
        let fd=open(path,O_RDWR|O_NOFOLLOW|O_CLOEXEC)
        guard fd >= 0 else { throw LinuxRuntimeError.server("Could not open Linux OPFS channel.") }
        var st=stat()
        guard fstat(fd,&st)==0,(st.st_mode & mode_t(S_IFMT))==mode_t(S_IFREG),
              st.st_nlink==1,st.st_size==off_t(Self.fileSize) else {
            Darwin.close(fd); throw LinuxRuntimeError.server("Linux OPFS channel file is invalid.")
        }
        let p=mmap(nil,Self.fileSize,PROT_READ|PROT_WRITE,MAP_SHARED,fd,0)
        guard p != MAP_FAILED,let p else {
            Darwin.close(fd); throw LinuxRuntimeError.server("Could not mmap Linux OPFS channel.")
        }
        let marker=Data(magic.utf8)
        guard marker.count < 64,Data(bytes:p,count:marker.count)==marker else {
            munmap(p,Self.fileSize); Darwin.close(fd)
            throw LinuxRuntimeError.server("Linux OPFS channel magic does not match.")
        }
        self.fd=fd; self.base=p; self.handler=handler
    }

    func start() {
        storeU32(136,1)
        work.async { [weak self] in
            guard let self else { return }
            defer {
                self.storeU32(136,0)
                self.cleanup()
                self.done.signal()
            }
            var last=self.loadU32(128)
            while !self.shouldStop() {
                let seq=self.loadU32(64)
                if seq == last { Thread.sleep(forTimeInterval:0.00005); continue }
                let n=Int(self.loadU32(68))
                guard n >= 0,n <= Self.requestMaximum else {
                    self.storeI32(132,-7); self.storeU32(128,seq); last=seq; continue
                }
                let req=Data(bytes:self.base.advanced(by:4096),count:n)
                do {
                    let reply=try self.handler(req,Self.responseMaximum)
                    let out=reply.data.prefix(Self.responseMaximum)
                    if !out.isEmpty {
                        out.withUnsafeBytes { raw in
                            if let p=raw.baseAddress { memcpy(self.base.advanced(by:4096+Self.requestMaximum),p,out.count) }
                        }
                    }
                    self.storeI32(132,reply.result)
                } catch {
                    self.storeI32(132,-5)
                }
                self.storeU32(128,seq); last=seq
            }
        }
    }

    func stop() {
        lock.lock(); let already=stopping; stopping=true; lock.unlock()
        guard !already else { return }
        _=done.wait(timeout:.now()+5)
    }

    private func cleanup() {
        lock.lock()
        if cleaned { lock.unlock(); return }
        cleaned=true
        lock.unlock()
        _=munmap(base,Self.fileSize)
        _=Darwin.close(fd)
    }
    deinit { stop() }

    private func shouldStop()->Bool { lock.lock(); defer { lock.unlock() }; return stopping }
    private func loadU32(_ off:Int)->UInt32 { base.load(fromByteOffset:off,as:UInt32.self).littleEndian }
    private func storeU32(_ off:Int,_ value:UInt32) { base.storeBytes(of:value.littleEndian,toByteOffset:off,as:UInt32.self) }
    private func storeI32(_ off:Int,_ value:Int32) { base.storeBytes(of:UInt32(bitPattern:value).littleEndian,toByteOffset:off,as:UInt32.self) }

    static func discover(magic:String,timeout:TimeInterval=3)throws->String {
        guard magic.utf8.count < 64 else { throw LinuxRuntimeError.server("Linux channel magic is oversized.") }
        let fm=FileManager.default
        var roots=fm.urls(for:.libraryDirectory,in:.userDomainMask).map{$0.appendingPathComponent("WebKit",isDirectory:true)}
        roots += fm.urls(for:.libraryDirectory,in:.userDomainMask)
        roots += fm.urls(for:.applicationSupportDirectory,in:.userDomainMask)
        roots += fm.urls(for:.cachesDirectory,in:.userDomainMask)
        roots.append(fm.temporaryDirectory)
        let want=Array(magic.utf8),deadline=Date().addingTimeInterval(timeout)
        var visited=0
        for root in roots {
            let base=root.resolvingSymlinksInPath().standardizedFileURL
            guard let e=fm.enumerator(at:base,includingPropertiesForKeys:[.isRegularFileKey,.isSymbolicLinkKey],options:[.skipsPackageDescendants]) else { continue }
            for case let u as URL in e {
                visited += 1
                guard visited <= 20_000,Date()<deadline else {
                    throw LinuxRuntimeError.server("Linux channel discovery exceeded its bounded search budget.")
                }
                let v=try? u.resourceValues(forKeys:[.isRegularFileKey,.isSymbolicLinkKey])
                guard v?.isRegularFile==true,v?.isSymbolicLink != true else { continue }
                var st=stat()
                guard stat(u.path,&st)==0,st.st_size==off_t(Self.fileSize) else { continue }
                let f=open(u.path,O_RDONLY|O_NOFOLLOW|O_CLOEXEC)
                guard f>=0 else { continue }
                var b=[UInt8](repeating:0,count:want.count)
                let n=read(f,&b,b.count); Darwin.close(f)
                if n==want.count,b==want {
                    let resolved=u.resolvingSymlinksInPath().standardizedFileURL
                    guard resolved.path.hasPrefix(base.path+"/") else { continue }
                    return resolved.path
                }
            }
        }
        throw LinuxRuntimeError.server("Linux OPFS channel backing file was not discoverable.")
    }
}
#endif
