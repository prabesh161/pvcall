const signalStore = globalThis.__PV_CALL_SIGNAL_STORE ||= new Map()

export default function handler(req, res) {
  if (req.method === 'GET') {
    const peerId = Array.isArray(req.query.peerId) ? req.query.peerId[0] : req.query.peerId
    if (!peerId) {
      return res.status(400).json({ error: 'peerId is required' })
    }

    const queue = signalStore.get(peerId) || []
    signalStore.delete(peerId)
    return res.status(200).json(queue)
  }

  if (req.method === 'POST') {
    const { to, from, message } = req.body || {}
    if (!to || !from || !message || !message.type) {
      return res.status(400).json({ error: 'to, from and message.type are required' })
    }

    const queue = signalStore.get(to) || []
    queue.push({ from, message, createdAt: Date.now() })
    signalStore.set(to, queue)
    return res.status(200).json({ ok: true })
  }

  res.setHeader('Allow', ['GET', 'POST'])
  return res.status(405).end(`Method ${req.method} not allowed`)
}
