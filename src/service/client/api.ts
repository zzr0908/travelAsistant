export class ApiError extends Error {
  constructor(
    message: string,
    public status = 0,
  ) {
    super(message);
  }
}
export function uid() {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 15) | 64;
  bytes[8] = (bytes[8] & 63) | 128;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join(
    "",
  );
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
export async function api<T = unknown>(
  url: string,
  options: RequestInit = {},
): Promise<T> {
  const controller = new AbortController(),
    timer = setTimeout(() => controller.abort(), 15000);
  try {
    const response = await fetch(url, {
      ...options,
      credentials: "same-origin",
      signal: options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal,
      headers: {
        "Content-Type": "application/json",
        "X-Travel-App": "1",
        ...options.headers,
      },
    });
    const data = await response.json();
    if (!response.ok)
      throw new ApiError(data.message || "操作未完成，请重试", response.status);
    return data as T;
  } catch (error) {
    if (options.signal?.aborted) throw new DOMException('请求已取消', 'AbortError');
    if (error instanceof ApiError) throw error;
    throw new ApiError(
      "连接中断或响应超时。输入已保留，请确认部署电脑仍在运行后重试。",
    );
  } finally {
    clearTimeout(timer);
  }
}
export const post = <T = unknown>(url: string, body: unknown) =>
  api<T>(url, { method: "POST", body: JSON.stringify(body) });
