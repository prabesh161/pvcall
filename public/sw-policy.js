(function (root, factory) {
  const api = factory()
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api
  } else {
    root.__PVCallSwPolicy = api
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  function isSameOrigin(request, currentOrigin) {
    if (!request || typeof request.url !== 'string') return false
    try {
      return new URL(request.url, currentOrigin).origin === currentOrigin
    } catch (error) {
      return false
    }
  }

  function shouldCacheRequest(request, currentOrigin = 'http://localhost') {
    if (!request || request.method !== 'GET') return false
    if (!isSameOrigin(request, currentOrigin)) return false

    const url = new URL(request.url, currentOrigin)
    if (url.pathname.startsWith('/api/')) return false

    const destination = request.destination || ''
    return ['document', 'script', 'style', 'image', 'font', 'manifest', 'worker', ''].includes(destination)
  }

  return { shouldCacheRequest }
})
