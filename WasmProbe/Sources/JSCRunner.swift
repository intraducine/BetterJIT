import Foundation
import JavaScriptCore

/// Runs the shared suites in an in-process JSContext. A third-party app has no
/// JIT entitlement, so this is JavaScriptCore's interpreter tiers only — the
/// "App Store without WebKit" baseline.
enum JSCRunner {
    static func run(webRoot: URL, kernels: Bool, dispatch: Bool, completion: @escaping () -> Void) {
        let thread = Thread {
            body(webRoot: webRoot, kernels: kernels, dispatch: dispatch)
            DispatchQueue.main.async(execute: completion)
        }
        thread.stackSize = 16 << 20
        thread.start()
    }

    private static func body(webRoot: URL, kernels: Bool, dispatch: Bool) {
        guard let ctx = JSContext() else { Log.result(["suite": "jsc", "error": "no JSContext"]); return }
        ctx.exceptionHandler = { _, exc in
            Log.result(["suite": "jsc", "engine": "jsc", "error": exc?.toString() ?? "?"])
        }
        let now: @convention(block) () -> Double = { NativeBench.nowMs() }
        let emit: @convention(block) (String) -> Void = { s in Log.resultJSON(s, extra: ["engine": "jsc"]) }
        ctx.setObject(now, forKeyedSubscript: "__now" as NSString)
        ctx.setObject(emit, forKeyedSubscript: "__emit" as NSString)
        ctx.evaluateScript("var env = { now: __now, emit: function (o) { __emit(JSON.stringify(o)); } };")

        let wasmType = ctx.evaluateScript("typeof WebAssembly")?.toString() ?? "?"
        var envResult: [String: Any] = ["suite": "env", "engine": "jsc", "typeofWebAssembly": wasmType]
        for f in ["wasmgen.js", "features.js", "core.js"] {
            let src = (try? String(contentsOf: webRoot.appendingPathComponent(f), encoding: .utf8)) ?? ""
            ctx.evaluateScript(src, withSourceURL: webRoot.appendingPathComponent(f))
        }
        if wasmType == "object" {
            envResult["features"] = ctx.evaluateScript("JSON.stringify(WasmFeatures.detect())")?.toString() ?? "?"
        }
        Log.result(envResult)
        guard wasmType == "object" else { return }

        if kernels, let data = try? Data(contentsOf: webRoot.appendingPathComponent("bench.wasm")) {
            let arr = ctx.evaluateScript("new Uint8Array(\(data.count))")!
            if let ptr = JSObjectGetTypedArrayBytesPtr(ctx.jsGlobalContextRef, arr.jsValueRef, nil) {
                data.withUnsafeBytes { memcpy(ptr, $0.baseAddress!, data.count) }
            }
            ctx.setObject(arr, forKeyedSubscript: "__bench" as NSString)
            // One timed run each, no warm-up: the interpreter never tiers up.
            ctx.evaluateScript("ProbeCore.runKernels(__bench, env, { reps: 1, warmup: false });")
        }
        if dispatch, let json = try? String(contentsOf: webRoot.appendingPathComponent("guestprog.json"), encoding: .utf8) {
            ctx.setObject(json, forKeyedSubscript: "__prog" as NSString)
            ctx.evaluateScript("ProbeCore.runDispatch(JSON.parse(__prog), env, { steps: 200000, reps: 1 });")
            ctx.evaluateScript("ProbeCore.runJitCost(JSON.parse(__prog), env, { chunks: 20, chunk: 5000 });")
        }
    }
}
