/** Read an Error or a serialized failure without dumping arbitrary request or Provider data. */
export function errorMessage(error: unknown, fallback = 'Operation failed without a readable error message.'): string {
  try {
    const message = typeof error === 'object' && error !== null ? ('message' in error ? error.message : undefined)
      : error === undefined || error === null ? undefined : String(error)
    return typeof message === 'string' && message.trim() !== '' && !/^(?:Error:\s*)?\[object Object\]$/u.test(message.trim()) ? message : fallback
  } catch { return fallback }
}
