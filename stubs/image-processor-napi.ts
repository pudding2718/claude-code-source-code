export function sharp() {
  throw new Error('image-processor-napi is not available in this build')
}

export async function getNativeModule() {
  return {}
}

export default sharp
