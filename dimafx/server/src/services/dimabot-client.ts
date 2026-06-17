interface ApiEnvelope<T> {
  error: boolean;
  message?: string;
  status?: number;
  data?: T;
  meta?: Record<string, unknown>;
}

export class DimabotClient {
  private readonly apiUrl = process.env.DIMABOT_INTERNAL_API_URL || 'http://dima-server:3000';
  private readonly fallbackApiUrl = process.env.DIMABOT_PUBLIC_API_URL || 'https://api.domdimabot.com';
  private readonly serviceToken = process.env.DIMAFX_SERVICE_TOKEN || '';

  async get<T>(path: string): Promise<ApiEnvelope<T>> {
    return this.request<T>(path, { method: 'GET' });
  }

  async post<T>(path: string, body: Record<string, unknown>): Promise<ApiEnvelope<T>> {
    return this.request<T>(path, { method: 'POST', body: JSON.stringify(body) });
  }

  async patch<T>(path: string, body: Record<string, unknown>): Promise<ApiEnvelope<T>> {
    return this.request<T>(path, { method: 'PATCH', body: JSON.stringify(body) });
  }

  private async request<T>(path: string, init: RequestInit): Promise<ApiEnvelope<T>> {
    if (!this.serviceToken) {
      return { error: true, message: 'DimaFX service token is not configured', status: 503 };
    }

    const primaryResult = await this.requestFrom<T>(this.apiUrl, path, init).catch((error) => ({
      error: true,
      message: error instanceof Error ? error.message : String(error),
      status: 503
    }) as ApiEnvelope<T>);

    if (!primaryResult.error || !this.shouldFallback(primaryResult)) {
      return primaryResult;
    }

    console.warn('DimaFX internal API failed, falling back to public API:', {
      internalApiUrl: this.apiUrl,
      fallbackApiUrl: this.fallbackApiUrl,
      path,
      status: primaryResult.status,
      message: primaryResult.message,
      timestamp: new Date().toISOString()
    });

    return this.requestFrom<T>(this.fallbackApiUrl, path, init).catch((error) => ({
      error: true,
      message: error instanceof Error ? error.message : String(error),
      status: 503
    }) as ApiEnvelope<T>);
  }

  private shouldFallback(result: ApiEnvelope<unknown>): boolean {
    return !result.status || result.status >= 500;
  }

  private async requestFrom<T>(baseUrl: string, path: string, init: RequestInit): Promise<ApiEnvelope<T>> {
    const response = await fetch(`${baseUrl}${path}`, {
      ...init,
      headers: {
        'Content-Type': 'application/json',
        'x-dimafx-service-token': this.serviceToken,
        ...(init.headers || {})
      }
    });

    const payload = await response.json().catch(() => ({ error: true, message: 'Invalid API response' })) as ApiEnvelope<T>;
    if (!response.ok && !payload.error) {
      return { ...payload, error: true, status: response.status };
    }

    return payload;
  }
}

export const dimabotClient = new DimabotClient();
