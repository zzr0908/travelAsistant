const messages: Record<string, string> = {
  MAP_AUTH: '地图服务鉴权失败，请检查服务配置；地点和图文仍可查看。',
  MAP_RATE: '地图服务请求较多，请稍后重试；地点和图文仍可查看。',
  MAP_BUDGET: '地图今日预算已达阈值，已有地点和图文仍可查看。',
  MAP_NETWORK: '地图网络暂时不可用，请稍后重试；地点和图文仍可查看。',
  MAP_TIMEOUT: '地图请求超时，请重试；地点和图文仍可查看。',
  MAP_UNAVAILABLE: '地图服务尚未配置，已有地点和图文仍可查看。',
};
export const mapResourceFallback = '部分地图资源未加载，可重试；地点列表和图文仍可使用。';

/** MapLibre preserves the proxy response body on resource errors. Never display raw error URLs or response text. */
export async function mapFailureMessage(error: unknown): Promise<string> {
  if (!error || typeof error !== 'object') return mapResourceFallback;
  const failure = error as { status?: number; body?: Blob };
  if (failure.body instanceof Blob && failure.body.size <= 8192) {
    try {
      const payload = JSON.parse(await failure.body.text());
      if (typeof payload?.code === 'string' && messages[payload.code]) return messages[payload.code];
    } catch { /* Invalid or unrelated response bodies use the generic resource message. */ }
  }
  return failure.status === 0 ? messages.MAP_NETWORK : mapResourceFallback;
}
