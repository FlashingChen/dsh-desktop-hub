/**
 * Read a fetch response body without ever buffering more than `maxBytes`.
 * Callers own HTTP status handling and pass their domain-specific error text.
 */
export async function readResponseBytes(
  response: Response,
  maxBytes: number,
  tooLargeMessage: string,
): Promise<Uint8Array> {
  const declaredLength = Number(response.headers.get('content-length'))
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    void response.body?.cancel().catch(() => {})
    throw new Error(tooLargeMessage)
  }
  if (!response.body) return new Uint8Array()

  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let totalBytes = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    if (!value) continue
    totalBytes += value.byteLength
    if (totalBytes > maxBytes) {
      void reader.cancel().catch(() => {})
      throw new Error(tooLargeMessage)
    }
    chunks.push(value)
  }

  const body = new Uint8Array(totalBytes)
  let offset = 0
  for (const chunk of chunks) {
    body.set(chunk, offset)
    offset += chunk.byteLength
  }
  return body
}

export async function readResponseText(
  response: Response,
  maxBytes: number,
  tooLargeMessage: string,
): Promise<string> {
  return new TextDecoder().decode(await readResponseBytes(response, maxBytes, tooLargeMessage))
}
