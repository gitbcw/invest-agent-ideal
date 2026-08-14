type CryptoWithOptionalRandomUuid = {
  randomUUID?: () => string;
};

export function createClientId(
  cryptoApi: CryptoWithOptionalRandomUuid | undefined = globalThis.crypto,
): string {
  if (typeof cryptoApi?.randomUUID === "function") {
    return cryptoApi.randomUUID();
  }
  const randomPart = Math.random().toString(36).slice(2, 10).padEnd(8, "0");
  return `client_${Date.now().toString(36)}_${randomPart}`;
}
