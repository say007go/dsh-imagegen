// 可取消等待与超时信号：集中处理 AbortSignal，避免每个模块各写一份。

/** 合并调用方信号与单次请求超时；旧 Node 没有 AbortSignal.any 时退化为手动合并。 */
export function withTimeout(signal, ms) {
  const timeout = AbortSignal.timeout(ms);
  if (!signal) return timeout;
  if (typeof AbortSignal.any === "function") return AbortSignal.any([signal, timeout]);

  const controller = new AbortController();
  const abort = (reason) => {
    if (!controller.signal.aborted) controller.abort(reason);
  };
  for (const source of [signal, timeout]) {
    if (source.aborted) {
      abort(source.reason);
      break;
    }
    source.addEventListener("abort", () => abort(source.reason), { once: true });
  }
  return controller.signal;
}

/** 可被 exec.signal 取消的 sleep。 */
export function sleep(ms, signal) {
  if (!signal) return new Promise((resolve) => setTimeout(resolve, ms));
  if (signal.aborted) return Promise.reject(signal.reason ?? new Error("aborted"));
  return new Promise((resolve, reject) => {
    let timer;
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason ?? new Error("aborted"));
    };
    timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
}
