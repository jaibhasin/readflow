export const RECONNECT_MESSAGE = "Refresh this tab to reconnect Readflow.";

export function connectionErrorMessage(runtime: Pick<typeof chrome.runtime, "id"> | undefined): string {
  return runtime?.id ? "Readflow lost its audio connection. Press Listen to try again." : RECONNECT_MESSAGE;
}

export function extensionRuntime(): typeof chrome.runtime {
  if (typeof chrome === "undefined" || !chrome.runtime?.id) {
    throw new Error(RECONNECT_MESSAGE);
  }
  return chrome.runtime;
}

export async function sendExtensionMessage<T>(message: object): Promise<T> {
  try {
    return await extensionRuntime().sendMessage(message) as T;
  } catch {
    throw new Error(RECONNECT_MESSAGE);
  }
}
