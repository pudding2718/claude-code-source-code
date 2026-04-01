export const DEFAULT_GRANT_FLAGS = {
  clipboardRead: false,
  clipboardWrite: false,
  systemKeyCombos: false,
}

export const API_RESIZE_PARAMS = {}

export function targetImageSize(width: number, height: number) {
  return [width, height]
}

export function buildComputerUseTools() {
  return []
}

export function bindSessionContext(_ctx: unknown, _overrides?: unknown) {
  return async () => ({
    content: [{ type: 'text', text: 'Computer use is unavailable in this build.' }],
    isError: true,
  })
}

export function createComputerUseMcpServer() {
  return {
    setRequestHandler() {},
    async connect() {},
  }
}
