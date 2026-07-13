import Head from 'next/head'
import { useEffect, useRef, useState } from 'react'

const generateId = () => `pv-${Math.random().toString(36).slice(2, 10)}`

const loadPeerJS = () => {
  return new Promise((resolve, reject) => {
    if (typeof window === 'undefined') {
      reject(new Error('PeerJS requires a browser environment.'))
      return
    }

    if (window.Peer) {
      resolve(window.Peer)
      return
    }

    const script = document.createElement('script')
    script.src = 'https://unpkg.com/peerjs@1.4.7/dist/peerjs.min.js'
    script.async = true
    script.onload = () => {
      if (window.Peer) {
        resolve(window.Peer)
      } else {
        reject(new Error('PeerJS loaded but did not expose window.Peer.'))
      }
    }
    script.onerror = () => reject(new Error('Failed to load PeerJS script.'))
    document.body.appendChild(script)
  })
}

export default function Home() {
  const [userId, setUserId] = useState('')
  const [editableId, setEditableId] = useState('')
  const [remoteId, setRemoteId] = useState('')
  const [status, setStatus] = useState('Initializing...')
  const [incomingPeer, setIncomingPeer] = useState(null)
  const [callActive, setCallActive] = useState(false)
  const [notificationPermission, setNotificationPermission] = useState('default')
  const [errorMessage, setErrorMessage] = useState('')
  const [swStatus, setSwStatus] = useState('')

  const peerRef = useRef(null)
  const localStreamRef = useRef(null)
  const currentCallRef = useRef(null)
  const audioRef = useRef(null)
  const ringtoneRef = useRef(null)

  useEffect(() => {
    if (typeof window === 'undefined') return

    const storedId = localStorage.getItem('pvcall-user-id') || generateId()
    localStorage.setItem('pvcall-user-id', storedId)
    setUserId(storedId)
    setEditableId(storedId)
    setNotificationPermission(Notification.permission)

    const setupPeer = async () => {
      try {
        const PeerClass = await loadPeerJS()
        const peer = new PeerClass(storedId, {
          host: '0.peerjs.com',
          port: 443,
          path: '/',
          secure: true,
          config: {
            iceServers: [
              { urls: 'stun:stun.l.google.com:19302' },
              { urls: 'stun:stun1.l.google.com:19302' },
            ],
          },
        })

        peer.on('open', () => setStatus(`Ready as ${storedId}`))
        peer.on('error', (err) => setStatus(`Peer error: ${err.type || err}`))

        peer.on('call', async (call) => {
          setIncomingPeer(call)
          setStatus(`Incoming call from ${call.peer}`)
          requestNotificationPermission()
          showIncomingNotification(call.peer)
          playRingtone()
        })

        peerRef.current = peer
      } catch (error) {
        setStatus('Unable to initialize PeerJS client.')
        setErrorMessage(error.message || 'PeerJS initialization failed.')
      }
    }

    setupPeer()

    if ('serviceWorker' in navigator) {
      navigator.serviceWorker
        .register('/sw.js')
        .then(() => setSwStatus('PWA service worker registered'))
        .catch(() => setSwStatus('PWA service worker failed to register'))
    }

    return () => {
      currentCallRef.current?.close()
      peer.destroy()
      stopRingtone()
      localStreamRef.current?.getTracks().forEach((track) => track.stop())
    }
  }, [])

  const getLocalStream = async () => {
    if (localStreamRef.current) return localStreamRef.current
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      localStreamRef.current = stream
      return stream
    } catch (error) {
      setErrorMessage('Microphone access is required for calls.')
      throw error
    }
  }

  const playRingtone = () => {
    if (ringtoneRef.current) return
    const AudioContext = window.AudioContext || window.webkitAudioContext
    if (!AudioContext) return

    const audioCtx = new AudioContext()
    const oscillator = audioCtx.createOscillator()
    const gain = audioCtx.createGain()
    oscillator.type = 'sine'
    oscillator.frequency.value = 400
    gain.gain.value = 0.12
    oscillator.connect(gain).connect(audioCtx.destination)
    oscillator.start()

    ringtoneRef.current = { audioCtx, oscillator }
  }

  const stopRingtone = () => {
    if (!ringtoneRef.current) return
    ringtoneRef.current.oscillator.stop()
    ringtoneRef.current.audioCtx.close()
    ringtoneRef.current = null
  }

  const showIncomingNotification = (callerId) => {
    if (Notification.permission !== 'granted') return
    new Notification('PVCall incoming call', {
      body: `Call from ${callerId}`,
      icon: '/icon.svg',
    })
  }

  const requestNotificationPermission = async () => {
    if (!('Notification' in window)) return
    const permission = await Notification.requestPermission()
    setNotificationPermission(permission)
  }

  const startCall = async () => {
    setErrorMessage('')
    if (!remoteId.trim()) {
      setErrorMessage('Enter the other user’s ID to start a call.')
      return
    }
    if (!peerRef.current || peerRef.current.disconnected) {
      setErrorMessage('Connection not ready. Reload the page.')
      return
    }

    try {
      const stream = await getLocalStream()
      const call = peerRef.current.call(remoteId.trim(), stream)
      currentCallRef.current = call
      setStatus(`Calling ${remoteId.trim()}...`)

      call.on('stream', (remoteStream) => {
        setCallActive(true)
        audioRef.current.srcObject = remoteStream
        audioRef.current.play().catch(() => {})
        setStatus(`In call with ${remoteId.trim()}`)
      })

      call.on('close', endCall)
      call.on('error', () => endCall())
    } catch (error) {
      setErrorMessage('Unable to start call. Check microphone permissions.')
    }
  }

  const answerCall = async () => {
    if (!incomingPeer) return
    stopRingtone()

    try {
      const stream = await getLocalStream()
      incomingPeer.answer(stream)
      currentCallRef.current = incomingPeer
      setIncomingPeer(null)

      incomingPeer.on('stream', (remoteStream) => {
        setCallActive(true)
        audioRef.current.srcObject = remoteStream
        audioRef.current.play().catch(() => {})
        setStatus(`In call with ${incomingPeer.peer}`)
      })

      incomingPeer.on('close', endCall)
      incomingPeer.on('error', () => endCall())
    } catch (error) {
      setErrorMessage('Unable to answer call. Check microphone permissions.')
    }
  }

  const rejectCall = () => {
    if (!incomingPeer) return
    incomingPeer.close()
    setIncomingPeer(null)
    stopRingtone()
    setStatus('Incoming call declined')
  }

  const endCall = () => {
    currentCallRef.current?.close()
    currentCallRef.current = null
    setCallActive(false)
    setIncomingPeer(null)
    setStatus(`Ready as ${userId}`)
    stopRingtone()
  }

  const saveUserId = () => {
    const nextId = editableId.trim()
    if (!nextId) {
      setErrorMessage('User ID cannot be empty.')
      return
    }
    localStorage.setItem('pvcall-user-id', nextId)
    window.location.reload()
  }

  const copyToClipboard = async () => {
    await navigator.clipboard.writeText(userId)
    setStatus('Your ID has been copied to clipboard')
  }

  return (
    <>
      <Head>
        <title>PVCall</title>
        <meta name="description" content="Minimal browser calling experience with clean design." />
        <meta name="theme-color" content="#f5f7f8" />
        <link rel="manifest" href="/manifest.json" />
        <link rel="icon" href="/icon.svg" />
      </Head>

      <main style={styles.page}>
        <section style={styles.card}>
          <div style={styles.header}>
            <span style={styles.icon}>📞</span>
            <div>
              <h1 style={styles.title}>PVCall</h1>
              <p style={styles.subtitle}>A clean peer-to-peer calling experience.</p>
            </div>
          </div>

          <div style={styles.section}>
            <div style={styles.sectionHeader}>
              <span style={styles.sectionIcon}>🆔</span>
              <span style={styles.sectionTitle}>Your call ID</span>
            </div>
            <div style={styles.idBox}>
              <code style={styles.id}>{userId || 'Loading...'}</code>
              <button style={styles.button} type="button" onClick={copyToClipboard}>
                Copy
              </button>
            </div>
          </div>

          <div style={styles.section}>
            <div style={styles.sectionHeader}>
              <span style={styles.sectionIcon}>🎯</span>
              <span style={styles.sectionTitle}>Start a call</span>
            </div>
            <div style={styles.row}>
              <input
                style={styles.input}
                value={remoteId}
                onChange={(event) => setRemoteId(event.target.value)}
                placeholder="Enter recipient ID"
              />
              <button style={styles.button} type="button" onClick={startCall} disabled={callActive}>
                Call
              </button>
            </div>
          </div>

          <div style={styles.section}>
            <div style={styles.sectionHeader}>
              <span style={styles.sectionIcon}>🔔</span>
              <span style={styles.sectionTitle}>Notifications</span>
            </div>
            <p style={styles.small}>
              {notificationPermission === 'granted'
                ? 'Incoming call alerts are enabled.'
                : 'Enable notifications for callers.'}
            </p>
            {notificationPermission !== 'granted' && (
              <button style={styles.subtleButton} type="button" onClick={requestNotificationPermission}>
                Enable
              </button>
            )}
          </div>

          {incomingPeer && (
            <div style={styles.incoming}>
              <p style={styles.incomingText}>Incoming call from <strong>{incomingPeer.peer}</strong></p>
              <div style={styles.actionRow}>
                <button style={styles.button} type="button" onClick={answerCall}>
                  Answer
                </button>
                <button style={styles.dangerButton} type="button" onClick={rejectCall}>
                  Decline
                </button>
              </div>
            </div>
          )}

          {callActive && (
            <div style={styles.section}>
              <button style={styles.dangerButton} type="button" onClick={endCall}>
                End Call
              </button>
            </div>
          )}

          <div style={styles.footer}>
            <p style={styles.status}>{status}</p>
            {errorMessage && <p style={styles.error}>{errorMessage}</p>}
          </div>
        </section>
      </main>

      <audio ref={audioRef} hidden />
    </>
  )
}

const styles = {
  page: {
    minHeight: '100vh',
    padding: '2rem',
    background: '#f5f7f8',
    display: 'flex',
    justifyContent: 'center',
    alignItems: 'center',
    color: '#111827',
  },
  card: {
    width: '100%',
    maxWidth: '640px',
    padding: '2rem',
    borderRadius: '24px',
    background: '#ffffff',
    boxShadow: '0 20px 45px rgba(15, 23, 42, 0.08)',
    border: '1px solid rgba(15, 23, 42, 0.08)',
  },
  header: {
    display: 'flex',
    alignItems: 'center',
    gap: '1rem',
    marginBottom: '1.5rem',
  },
  icon: {
    fontSize: '2rem',
    background: '#e2e8f0',
    width: '3rem',
    height: '3rem',
    borderRadius: '16px',
    display: 'grid',
    placeItems: 'center',
  },
  title: {
    margin: 0,
    fontSize: '2rem',
    lineHeight: 1.1,
  },
  subtitle: {
    margin: '0.35rem 0 0',
    color: '#475569',
    fontSize: '1rem',
  },
  section: {
    marginBottom: '1.5rem',
  },
  sectionHeader: {
    display: 'flex',
    alignItems: 'center',
    gap: '0.75rem',
    marginBottom: '0.75rem',
  },
  sectionIcon: {
    fontSize: '1.2rem',
  },
  sectionTitle: {
    fontWeight: 600,
    color: '#111827',
  },
  idBox: {
    display: 'flex',
    gap: '0.75rem',
    flexWrap: 'wrap',
    alignItems: 'center',
  },
  id: {
    padding: '0.9rem 1rem',
    borderRadius: '14px',
    background: '#f8fafc',
    border: '1px solid #e2e8f0',
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace',
    color: '#0f172a',
    flex: 1,
    minWidth: 0,
  },
  input: {
    flex: 1,
    minWidth: 0,
    borderRadius: '14px',
    border: '1px solid #e2e8f0',
    background: '#f8fafc',
    color: '#111827',
    padding: '0.95rem 1rem',
    fontSize: '1rem',
  },
  button: {
    borderRadius: '14px',
    border: 'none',
    padding: '0.95rem 1.25rem',
    background: '#111827',
    color: '#ffffff',
    cursor: 'pointer',
    fontSize: '1rem',
    minWidth: '92px',
  },
  subtleButton: {
    borderRadius: '14px',
    border: '1px solid #d1d5db',
    background: '#ffffff',
    color: '#111827',
    cursor: 'pointer',
    padding: '0.9rem 1.1rem',
    fontSize: '0.95rem',
  },
  dangerButton: {
    borderRadius: '14px',
    border: 'none',
    padding: '0.95rem 1.25rem',
    background: '#ef4444',
    color: '#ffffff',
    cursor: 'pointer',
    fontSize: '1rem',
  },
  row: {
    display: 'flex',
    gap: '0.75rem',
    alignItems: 'center',
  },
  footer: {
    marginTop: '1rem',
    display: 'grid',
    gap: '0.5rem',
  },
  status: {
    margin: 0,
    color: '#475569',
  },
  small: {
    color: '#475569',
    margin: 0,
    lineHeight: 1.6,
  },
  error: {
    color: '#b91c1c',
    margin: 0,
  },
  incoming: {
    borderRadius: '18px',
    padding: '1rem',
    background: '#f8fafc',
    border: '1px solid #e2e8f0',
  },
  incomingText: {
    margin: 0,
    color: '#111827',
  },
  actionRow: {
    display: 'flex',
    gap: '0.75rem',
    marginTop: '0.75rem',
  },
}
