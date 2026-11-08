export async function boundedResponseText(response: Response, limit: number, invalid: string) {
  const reader = response.body?.getReader();
  if (!reader) throw Error(invalid);
  const decoder = new TextDecoder();
  let size = 0,
    text = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return text + decoder.decode();
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel();
      throw Error(invalid);
    }
    text += decoder.decode(value, { stream: true });
  }
}
