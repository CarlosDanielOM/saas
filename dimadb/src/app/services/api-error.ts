export function extractApiError(error: unknown, fallback: string): Error {
  if (error && typeof error === 'object' && 'error' in error) {
    const body = (error as { error?: { message?: string }; status?: number }).error;
    const status = (error as { status?: number }).status;
    if (body?.message) {
      return Object.assign(new Error(body.message), { status });
    }
  }
  return error instanceof Error ? error : new Error(fallback);
}
